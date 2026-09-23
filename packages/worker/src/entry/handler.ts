/**
 * The Lambda entry point. Temporal Cloud invokes this function when the task
 * queue has work (Serverless Workers); the Worker polls until the invocation
 * deadline nears, then drains and returns. The connection comes from the
 * stack's secret (temporal.ts), read once per container.
 */
import { fileURLToPath } from 'node:url';
import { runWorker, type LambdaHandler, type LambdaWorkerConfig } from '@temporalio/lambda-worker';
import * as activities from '../activities/index.js';
import { BUILD_ID, DEPLOYMENT_NAME, TASK_QUEUE } from '../version.js';
import { temporalConnection } from './temporal.js';

let config!: LambdaWorkerConfig;
const worker = runWorker({ deploymentName: DEPLOYMENT_NAME, buildId: BUILD_ID }, (c) => {
  config = c;
  c.workerOptions.taskQueue = TASK_QUEUE;
  // Pre-bundled at image build (scripts/bundle-workflows.ts), beside this bundled entry in lib/: no webpack on a cold start.
  c.workerOptions.workflowBundle = { codePath: fileURLToPath(new URL('./workflow-bundle.js', import.meta.url)) };
  c.workerOptions.activities = activities;
});

async function connect(): Promise<void> {
  const t = await temporalConnection();
  // The worker reads these per invocation from the config object it handed us.
  config.connectionOptions = { address: t.address, apiKey: t.apiKey, tls: true };
  config.namespace = t.namespace;
}

let connection: Promise<void> | undefined;

export const handler: LambdaHandler = async (event, context) => {
  connection ??= connect().catch((err: unknown) => {
    connection = undefined; // a failed read is retried on the next invocation, not cached
    throw err;
  });
  await connection;
  return worker(event, context);
};
