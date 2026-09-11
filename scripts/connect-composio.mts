/**
 * Composio consent flow: connect a tenant owner's Gmail or HubSpot to
 * Composio's token vault (their verified OAuth apps). The Composio-side
 * userId IS our tenantId.
 *
 *   npx tsx scripts/connect-composio.mts <tenantId> [gmail|hubspot]
 *
 * Reads the API key from the runtime stack's Composio secret (or
 * COMPOSIO_API_KEY env). Prints the connect link, waits for consent, then
 * proves it: Gmail profile, or a HubSpot owners lookup, through the adapter.
 */
import { execFileSync } from 'node:child_process';
import { composioConnect, composioGmail, type ComposioToolkit } from '@wnk/shared/composio';

const tenantId = process.argv[2];
if (!tenantId) { console.error('usage: npx tsx scripts/connect-composio.mts <tenantId> [gmail|hubspot]'); process.exit(2); }
const toolkit = (process.argv[3] ?? 'gmail') as ComposioToolkit;
if (toolkit !== 'gmail' && toolkit !== 'hubspot') throw new Error(`unknown toolkit ${toolkit}`);

if (!process.env.COMPOSIO_API_KEY && !process.env.COMPOSIO_SECRET_ARN) {
  process.env.COMPOSIO_SECRET_ARN = execFileSync('aws', [
    'cloudformation', 'describe-stacks', '--stack-name', 'wnk-voice-dev',
    '--query', "Stacks[0].Outputs[?OutputKey=='composioSecretArn'].OutputValue | [0]",
    '--output', 'text', '--region', 'us-west-2',
  ], { encoding: 'utf8' }).trim();
}

const link = await composioConnect.link(tenantId, toolkit);
console.log(`\n=== TENANT "${tenantId}" / ${toolkit.toUpperCase()}: OPEN THIS URL AND CONSENT ===`);
console.log(link.redirectUrl);
console.log('\nwaiting up to 5 minutes...');
const accountId = await link.waitForActive();
console.log(`connected: ${accountId}`);

if (toolkit === 'gmail') console.log(`proof — Gmail profile: ${await composioGmail.ownerEmail(tenantId)}`);
else console.log('proof — run scripts/test-crm-workflows.mts to exercise HubSpot through the workflows');
