/**
 * The fallback: the same Worker as a long-running process, for when the
 * Lambda path (Serverless Workers, still a preview) misbehaves. The stack
 * keeps a Fargate service of this at zero tasks; one setting brings it up and
 * the queue drains. It announces the same deployment version as the Lambda,
 * so Temporal routes to it without a release.
 */
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';
import { env, secret } from './activities/config.js';
import { BUILD_ID, DEPLOYMENT_NAME, TASK_QUEUE } from './version.js';

const s = await secret(env('TEMPORAL_SECRET_ARN'));
for (const key of ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_API_KEY']) if (!s[key]) throw new Error(`${key} is empty in the Temporal secret`);
const connection = await NativeConnection.connect({ address: s.TEMPORAL_ADDRESS, tls: true, apiKey: s.TEMPORAL_API_KEY });
const worker = await Worker.create({
  connection,
  namespace: s.TEMPORAL_NAMESPACE!,
  taskQueue: TASK_QUEUE,
  workflowBundle: { codePath: fileURLToPath(new URL('./workflow-bundle.js', import.meta.url)) },
  activities,
  workerDeploymentOptions: { useWorkerVersioning: true, version: { deploymentName: DEPLOYMENT_NAME, buildId: BUILD_ID }, defaultVersioningBehavior: 'PINNED' },
});
process.on('SIGTERM', () => worker.shutdown());
console.log(JSON.stringify({ level: 'INFO', message: 'Fallback worker running', deploymentName: DEPLOYMENT_NAME, buildId: BUILD_ID, taskQueue: TASK_QUEUE }));
await worker.run();
await connection.close();
