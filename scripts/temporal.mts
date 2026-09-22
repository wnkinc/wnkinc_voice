/**
 * The Temporal CLI against the platform namespace, authenticated with the
 * worker's API key from the stack's secret (the browser login expires; this
 * does not). The key reaches the CLI as an environment variable, never an
 * argument or a printed line.
 *
 *   npx tsx scripts/temporal.mts workflow list --limit 5
 *   npx tsx scripts/temporal.mts workflow show --workflow-id sms-<MessageSid>
 */
import { spawnSync } from 'node:child_process';
import { temporalEnv } from './lib/temporal-env.mts';

const env = await temporalEnv();
const args = process.argv.slice(2);
const r = spawnSync('temporal', args, { stdio: 'inherit', env: { ...process.env, ...env, TEMPORAL_PROFILE: '', TEMPORAL_CONFIG_FILE: '/dev/null' } });
process.exit(r.status ?? 1);
