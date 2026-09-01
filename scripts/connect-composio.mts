/**
 * Composio consent flow: connect a tenant owner's Gmail to Composio's token
 * vault (their verified Google OAuth app — no unverified-app screen, no 7-day
 * token expiry). The Composio-side userId IS our tenantId.
 *
 *   npx tsx scripts/connect-composio.mts [tenantId]
 *
 * Reads the API key from the runtime stack's Composio secret (or
 * COMPOSIO_API_KEY env). Prints the connect link, waits for consent, then
 * proves it by reading the Gmail profile through the adapter.
 */
import { execFileSync } from 'node:child_process';
import { composioGmail } from '@wnk/shared/composio';

const tenantId = process.argv[2] ?? 'wnk';

if (!process.env.COMPOSIO_API_KEY && !process.env.COMPOSIO_SECRET_ARN) {
  process.env.COMPOSIO_SECRET_ARN = execFileSync('aws', [
    'cloudformation', 'describe-stacks', '--stack-name', 'wnk-runtime-dev',
    '--query', "Stacks[0].Outputs[?OutputKey=='composioSecretArn'].OutputValue | [0]",
    '--output', 'text', '--region', 'us-west-2',
  ], { encoding: 'utf8' }).trim();
}

const link = await composioGmail.connectLink(tenantId);
console.log(`\n=== TENANT "${tenantId}": OPEN THIS URL AND CONSENT ===`);
console.log(link.redirectUrl);
console.log('\nwaiting up to 5 minutes...');
const accountId = await link.waitForActive();
console.log(`connected: ${accountId}`);

const email = await composioGmail.ownerEmail(tenantId);
console.log(`proof — Gmail profile via adapter: ${email}`);
