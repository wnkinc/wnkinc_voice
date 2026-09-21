/**
 * Composio adapter — the ONE file that may import @composio/core or name a
 * Composio tool slug. Composio is our SaaS credential broker (their verified
 * OAuth apps; tokens live in their vault, keyed by our tenantId): code calls
 * these functions, nothing else in the platform knows Composio exists.
 *
 * Tenancy: every call names the tenant (Composio `userId` = our tenantId), so
 * the credential is chosen per call.
 *
 * At runtime nothing imports this file: the workflows call Composio's HTTP API
 * directly (Step Functions HTTP tasks, the tenant id as user_id, the key in an
 * EventBridge Connection), and the assistant loop runs each tool the model asks
 * for the same way. What remains here is for the consent scripts: connect
 * links and the owner's Gmail address.
 *
 * Deliberately NOT re-exported from the shared index: import from
 * '@wnk/shared/composio' (scripts only) so no Lambda bundle carries the SDK.
 *
 * Config: COMPOSIO_SECRET_ARN (Secrets Manager JSON {"COMPOSIO_API_KEY":...})
 * or COMPOSIO_API_KEY directly (scripts). Optional COMPOSIO_GMAIL_VERSION /
 * COMPOSIO_HUBSPOT_VERSION pin toolkit versions — set in prod; unset skips
 * the pin (dev).
 */
import { Composio } from '@composio/core';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION ?? 'us-west-2';

let clientPromise: Promise<Composio> | undefined;
function client(): Promise<Composio> {
  clientPromise ??= (async () => {
    let apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) {
      const arn = process.env.COMPOSIO_SECRET_ARN;
      if (!arn) throw new Error('neither COMPOSIO_API_KEY nor COMPOSIO_SECRET_ARN set');
      const sm = new SecretsManagerClient({ region: REGION });
      const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
      apiKey = (JSON.parse(secret.SecretString ?? '{}') as { COMPOSIO_API_KEY?: string }).COMPOSIO_API_KEY;
      if (!apiKey) throw new Error('COMPOSIO_API_KEY missing from secret');
    }
    const versions: Record<string, string> = {};
    if (process.env.COMPOSIO_GMAIL_VERSION) versions.gmail = process.env.COMPOSIO_GMAIL_VERSION;
    if (process.env.COMPOSIO_HUBSPOT_VERSION) versions.hubspot = process.env.COMPOSIO_HUBSPOT_VERSION;
    return new Composio({ apiKey, ...(Object.keys(versions).length ? { toolkitVersions: versions } : {}) });
  })();
  return clientPromise;
}

const pinned = (slug: string) => (slug.startsWith('GMAIL_') ? process.env.COMPOSIO_GMAIL_VERSION : process.env.COMPOSIO_HUBSPOT_VERSION);

async function execute(slug: string, tenantId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const c = await client();
  const attempt = () => c.tools.execute(slug, {
    userId: tenantId,
    arguments: args,
    ...(pinned(slug) ? {} : { dangerouslySkipVersionCheck: true }),
  });
  let res = await attempt().catch(async (err: unknown) => {
    // One retry with a short pause: Composio is a hard dependency on the send
    // path, and transient 5xx/429s should not drop a lead email.
    console.warn(JSON.stringify({ msg: 'composio execute retrying', slug, err: String(err) }));
    await new Promise((r) => setTimeout(r, 2000));
    return attempt();
  });
  if (!res.successful) {
    console.warn(JSON.stringify({ msg: 'composio execute retrying (unsuccessful)', slug, error: res.error }));
    await new Promise((r) => setTimeout(r, 2000));
    res = await attempt();
  }
  if (!res.successful) throw new Error(`composio ${slug} failed: ${res.error}`);
  return res.data;
}

/** The owner's Gmail address for a tenant's connected account. */
async function ownerEmail(tenantId: string): Promise<string> {
  const profile = await execute('GMAIL_GET_PROFILE', tenantId, {});
  const email = (profile as { response_data?: { emailAddress?: string }; emailAddress?: string })
    .response_data?.emailAddress ?? (profile as { emailAddress?: string }).emailAddress;
  if (!email) throw new Error(`no Gmail profile for tenant ${tenantId}; run scripts/connect-composio.mts`);
  return email;
}

export const COMPOSIO_TOOLKITS = ['gmail', 'hubspot', 'facebook'] as const;
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number];

/** Mint the OAuth connect link a tenant owner clicks once at onboarding, per toolkit. */
async function connectLink(tenantId: string, toolkit: ComposioToolkit = 'gmail'): Promise<{ redirectUrl: string; waitForActive: (timeoutMs?: number) => Promise<string> }> {
  const c = await client();
  const configs = await c.authConfigs.list({ toolkit });
  let authConfigId = configs.items?.[0]?.id;
  if (!authConfigId) {
    const created = await c.authConfigs.create(toolkit, { type: 'use_composio_managed_auth', name: toolkit });
    authConfigId = created.id;
  }
  const request = await c.connectedAccounts.link(tenantId, authConfigId);
  if (!request.redirectUrl) throw new Error('composio returned no redirect url');
  return {
    redirectUrl: request.redirectUrl,
    waitForActive: async (timeoutMs = 300_000) => {
      const account = await c.connectedAccounts.waitForConnection(request.id, timeoutMs);
      return account.id;
    },
  };
}

export const composioGmail = { ownerEmail, connectLink: (tenantId: string) => connectLink(tenantId, 'gmail') };
export const composioConnect = { link: connectLink };
