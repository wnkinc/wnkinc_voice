/**
 * Register the deployed worker with Temporal Cloud as the version named in
 * packages/worker/src/version.ts, and route new workflows to it.
 *
 *   npx tsx scripts/temporal-release.mts
 *
 * Runs after `npm run deploy -- wnk-worker-dev` (or by CI after a merge to
 * main). In order: publish an
 * immutable Lambda version of what was deployed; create the Worker Deployment
 * Version pointing at that qualified ARN, which makes Temporal invoke it once
 * to validate; check that invocation bound the task queue (if not, stop: the
 * function, secret, or invocation role is wrong, and routing traffic will not
 * fix it); set the version current. Idempotent per build id: rerun after a
 * failure and it picks up where it stopped.
 *
 * Every published version stays registered, so a rollback is one command:
 *   temporal worker deployment set-current-version --deployment-name <name> --build-id <previous> --yes
 *
 * The Temporal connection comes from the stack's secret; the API key goes to
 * the CLI as an environment variable and is never printed.
 */
import { execFileSync } from 'node:child_process';
import { BUILD_ID, DEPLOYMENT_NAME, TASK_QUEUE } from '../packages/worker/src/version.js';
import { REGION, temporalSecret } from './lib/temporal-env.mts';
import { missingSearchAttributes } from './lib/temporal-namespace.mts';

const STACK = 'wnk-worker-dev';
/** Every morning: the connection check at 15:00 UTC, the assistant probe ten minutes after it, so a failure there is about the loop, not Composio. */
const SCHEDULES = [
  { id: 'composio-health', cron: '0 15 * * *', type: 'composioHealth' },
  { id: 'assistant-health', cron: '10 15 * * *', type: 'assistantHealth' },
];

const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const output = (key: string) =>
  sh('aws', ['cloudformation', 'describe-stacks', '--stack-name', STACK, '--region', REGION, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text']);

const functionArn = output('functionArn');
const invokeRoleArn = output('invokeRoleArn');
const secret = await temporalSecret();
// The browser login's token, when present, is tried first and may have expired: point the CLI past it.
const temporalEnv = { TEMPORAL_ADDRESS: secret.TEMPORAL_ADDRESS!, TEMPORAL_NAMESPACE: secret.TEMPORAL_NAMESPACE!, TEMPORAL_API_KEY: secret.TEMPORAL_API_KEY!, TEMPORAL_CONFIG_FILE: '/dev/null' };
const temporal = (args: string[]) => sh('temporal', args, temporalEnv);

// 0. The namespace configuration the build depends on (CI checked it before the deploy too; here for a release by hand).
const missing = missingSearchAttributes(temporalEnv.TEMPORAL_NAMESPACE, temporalEnv);
if (missing.length > 0) { console.error(`the namespace lacks search attribute(s) the worker sets; a person creates each once (ops/README.md):\n  ${missing.map((m) => m.command).join('\n  ')}`); process.exit(1); }

// 1. An immutable Lambda version of the deployed code, one per build id. If this
//    build id already has one (a rerun), reuse it rather than publishing again.
const versions = JSON.parse(sh('aws', ['lambda', 'list-versions-by-function', '--function-name', functionArn, '--region', REGION, '--query', 'Versions[?Description==`' + BUILD_ID + '`].FunctionArn', '--output', 'json'])) as string[];
const qualifiedArn = versions[0] ?? sh('aws', ['lambda', 'publish-version', '--function-name', functionArn, '--description', BUILD_ID, '--region', REGION, '--query', 'FunctionArn', '--output', 'text']);
console.log(`lambda version: ${qualifiedArn}`);

// 2. The Worker Deployment Version. Creating it triggers one validation invocation.
const deployments = temporal(['worker', 'deployment', 'list', '-o', 'json']);
if (!deployments.includes(`"name": "${DEPLOYMENT_NAME}"`)) temporal(['worker', 'deployment', 'create', '--name', DEPLOYMENT_NAME]);
const existing = temporal(['worker', 'deployment', 'describe', '--name', DEPLOYMENT_NAME, '-o', 'json']);
if (!existing.includes(`"BuildID": "${BUILD_ID}"`)) {
  temporal(['worker', 'deployment', 'create-version', '--deployment-name', DEPLOYMENT_NAME, '--build-id', BUILD_ID,
    '--aws-lambda-function-arn', qualifiedArn, '--aws-lambda-assume-role-arn', invokeRoleArn, '--aws-lambda-assume-role-external-id', secret.EXTERNAL_ID!]);
}
console.log(`registered: ${DEPLOYMENT_NAME} / ${BUILD_ID}`);

// 3. The validation invocation must have bound the task queue before any traffic is routed.
let bound = false;
for (let i = 0; i < 12 && !bound; i++) {
  const described = temporal(['worker', 'deployment', 'describe-version', '--deployment-name', DEPLOYMENT_NAME, '--build-id', BUILD_ID, '--report-task-queue-stats', '-o', 'json']);
  bound = described.includes(`"name": "${TASK_QUEUE}"`);
  if (!bound) await new Promise((r) => setTimeout(r, 10_000));
}
if (!bound) {
  console.error(`task queue ${TASK_QUEUE} is not bound after the validation invocation: check /aws/lambda logs and the secret before routing traffic`);
  process.exit(1);
}
console.log(`task queue bound: ${TASK_QUEUE}`);

// 4. Route new workflows to it. --yes: without it the command prompts and, non-interactively, does nothing.
temporal(['worker', 'deployment', 'set-current-version', '--deployment-name', DEPLOYMENT_NAME, '--build-id', BUILD_ID, '--yes']);
const current = temporal(['worker', 'deployment', 'describe', '--name', DEPLOYMENT_NAME, '-o', 'json']);
console.log(current.includes(`"currentVersionBuildID": "${BUILD_ID}"`) ? `current: ${BUILD_ID}` : 'WARNING: current version did not change');

// 5. The schedules: config, applied idempotently. Each is a workflow type on
//    the task queue at a cron time (UTC); one running at a time, a missed run
//    skipped rather than piled up.
for (const s of SCHEDULES) {
  const exists = (() => { try { execFileSync('temporal', ['schedule', 'describe', '--schedule-id', s.id, '-o', 'json'], { env: { ...process.env, ...temporalEnv }, stdio: 'ignore' }); return true; } catch { return false; } })();
  if (exists) continue;
  temporal(['schedule', 'create', '--schedule-id', s.id, '--cron', s.cron, '--type', s.type, '--task-queue', TASK_QUEUE, '--workflow-id', s.id, '--overlap-policy', 'Skip']);
  console.log(`schedule created: ${s.id} (${s.cron} UTC -> ${s.type})`);
}
