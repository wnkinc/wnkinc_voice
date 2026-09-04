/**
 * Composio trial run: their managed Gmail OAuth (verified Google app — no
 * 7-day token expiry, no unverified-app screen) + their curated tool layer.
 *
 * Setup (once):
 *   1. Sign up at https://app.composio.dev (free tier) and create an API key
 *   2. export COMPOSIO_API_KEY=...
 *
 * Run:  npx tsx scripts/test-composio.mts [recipient@example.com]
 *
 * One run does the whole loop: ensures a Gmail auth config (Composio-managed),
 * prints an OAuth link if this user has no connected account yet (click it,
 * consent, the script waits), then sends a test email via GMAIL_SEND_EMAIL —
 * to the connected account's own address unless a recipient is given.
 *
 * Compare against our own rails: this replaces identity-stack 3LO + vault +
 * a raw Gmail fetch in our own code. What it costs us is spelled out in
 * the conversation that led here: token custody, data path, per-call fees.
 */
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error('COMPOSIO_API_KEY not set — create one at https://app.composio.dev');

const USER_ID = 'wnk-composio-test'; // Composio's tenant key; one per employee/tenant in a real setup
const composio = new Composio({ apiKey });

// ---- 1. Auth config: Composio-managed Gmail OAuth (their verified Google app)
async function ensureAuthConfig(): Promise<string> {
  const existing = await composio.authConfigs.list({ toolkit: 'gmail' });
  const found = existing.items?.[0];
  if (found) {
    console.log(`auth config: ${found.id} (existing)`);
    return found.id;
  }
  const created = await composio.authConfigs.create('gmail', {
    type: 'use_composio_managed_auth',
    name: 'gmail-trial',
  });
  console.log(`auth config: ${created.id} (created, composio-managed: ${created.isComposioManaged})`);
  return created.id;
}

// ---- 2. Connected account: reuse an ACTIVE one or run the OAuth dance now
async function ensureConnectedAccount(authConfigId: string): Promise<string> {
  try {
    const accounts = await composio.connectedAccounts.list({ userIds: [USER_ID] });
    const active = accounts.items?.find(
      (a: { status?: string; id: string; toolkit?: { slug?: string } }) =>
        a.status === 'ACTIVE' && (a.toolkit?.slug ?? 'gmail') === 'gmail',
    );
    if (active) {
      console.log(`connected account: ${active.id} (already ACTIVE)`);
      return active.id;
    }
  } catch (err) {
    console.log(`could not list accounts (${String(err)}); initiating fresh connection`);
  }
  const request = await composio.connectedAccounts.link(USER_ID, authConfigId);
  console.log('\n>>> Open this link, pick the Gmail account, consent (note: NO unverified-app warning):');
  console.log(`>>> ${request.redirectUrl}\n`);
  console.log('waiting up to 3 minutes for you to finish...');
  const account = await composio.connectedAccounts.waitForConnection(request.id, 180_000);
  console.log(`connected account: ${account.id} (${account.status})`);
  return account.id;
}

// ---- 3. Execute tools through their layer
async function execute(slug: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Trial-only: unpinned toolkit version. Production use would pin one
  // (their schema-drift management, surfacing as a hard requirement).
  const res = await composio.tools.execute(slug, {
    userId: USER_ID,
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  if (!res.successful) throw new Error(`${slug} failed: ${res.error}`);
  return res.data;
}

const authConfigId = await ensureAuthConfig();
await ensureConnectedAccount(authConfigId);

let recipient = process.argv[2];
if (!recipient) {
  const profile = await execute('GMAIL_GET_PROFILE', {});
  recipient = (profile as { response_data?: { emailAddress?: string }; emailAddress?: string })
    .response_data?.emailAddress ?? (profile as { emailAddress?: string }).emailAddress ?? '';
  console.log(`no recipient given — sending to the connected account itself: ${recipient}`);
}
if (!recipient) throw new Error('could not determine recipient; pass one as argv');

const sent = await execute('GMAIL_SEND_EMAIL', {
  recipient_email: recipient,
  subject: 'Composio trial — wnkinc_voice',
  body: 'Sent through Composio’s managed Gmail tool layer (their OAuth app, their tool schema, their API in the path).',
});
console.log('sent:', JSON.stringify(sent, null, 2));
