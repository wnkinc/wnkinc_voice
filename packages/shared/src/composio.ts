/**
 * Composio adapter — the ONE file that may import @composio/core or name a
 * Composio tool slug. Composio is our Gmail credential broker (their verified
 * Google OAuth app; tokens live in their vault, keyed by our tenantId): code
 * calls these functions, nothing else in the platform knows Composio exists.
 * LLM-facing surfaces get task-shaped Gateway tools that call THIS underneath —
 * never Composio's generic tools directly.
 *
 * Deliberately NOT re-exported from the shared index: import from
 * '@wnk/shared/composio' so only bundles that send email carry the SDK.
 *
 * Config: COMPOSIO_SECRET_ARN (Secrets Manager JSON {"COMPOSIO_API_KEY":...})
 * or COMPOSIO_API_KEY directly (scripts). Optional COMPOSIO_GMAIL_VERSION pins
 * their gmail toolkit version — set it in prod; unset skips the pin (dev).
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
    const version = process.env.COMPOSIO_GMAIL_VERSION;
    return new Composio({ apiKey, ...(version ? { toolkitVersions: { gmail: version } } : {}) });
  })();
  return clientPromise;
}

async function execute(slug: string, tenantId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const c = await client();
  const attempt = () => c.tools.execute(slug, {
    userId: tenantId,
    arguments: args,
    ...(process.env.COMPOSIO_GMAIL_VERSION ? {} : { dangerouslySkipVersionCheck: true }),
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

/** Send a plain-text email from the tenant owner's Gmail to the owner themself. */
async function sendAsOwner(tenantId: string, subject: string, body: string): Promise<string> {
  const email = await ownerEmail(tenantId);
  await execute('GMAIL_SEND_EMAIL', tenantId, { recipient_email: email, subject, body });
  return email;
}

/** Mint the OAuth connect link a tenant owner clicks once at onboarding. */
async function connectLink(tenantId: string): Promise<{ redirectUrl: string; waitForActive: (timeoutMs?: number) => Promise<string> }> {
  const c = await client();
  const configs = await c.authConfigs.list({ toolkit: 'gmail' });
  let authConfigId = configs.items?.[0]?.id;
  if (!authConfigId) {
    const created = await c.authConfigs.create('gmail', { type: 'use_composio_managed_auth', name: 'gmail' });
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

export const composioGmail = { sendAsOwner, ownerEmail, connectLink };
