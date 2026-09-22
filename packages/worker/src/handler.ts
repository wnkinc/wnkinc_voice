/**
 * The Lambda entry point. Temporal Cloud invokes this function when the task
 * queue has work (Serverless Workers); the Worker polls until the invocation
 * deadline nears, then drains and returns. Connection details come from the
 * secret the stack points at, read once per container under the execution
 * role: nothing Temporal-specific is in the environment, and the API key is
 * never a plaintext variable on the function.
 */
import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { runWorker, type LambdaHandler, type LambdaWorkerConfig } from '@temporalio/lambda-worker';
import * as activities from './activities/index.js';
import { BUILD_ID, DEPLOYMENT_NAME, TASK_QUEUE } from './version.js';

let config!: LambdaWorkerConfig;
const worker = runWorker({ deploymentName: DEPLOYMENT_NAME, buildId: BUILD_ID }, (c) => {
  config = c;
  c.workerOptions.taskQueue = TASK_QUEUE;
  // Pre-bundled at image build (scripts/bundle-workflows.ts): no webpack on a cold start.
  c.workerOptions.workflowBundle = { codePath: fileURLToPath(new URL('./workflow-bundle.js', import.meta.url)) };
  c.workerOptions.activities = activities;
});

const REQUIRED = ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_API_KEY'] as const;

async function connect(): Promise<void> {
  const arn = process.env.TEMPORAL_SECRET_ARN;
  if (!arn) throw new Error('TEMPORAL_SECRET_ARN is not set');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = JSON.parse(out.SecretString ?? '{}') as Partial<Record<(typeof REQUIRED)[number], string>>;
  for (const key of REQUIRED) if (!secret[key]) throw new Error(`${key} is empty in the Temporal secret`);
  // The worker reads these per invocation from the config object it handed us.
  config.connectionOptions = { address: secret.TEMPORAL_ADDRESS, apiKey: secret.TEMPORAL_API_KEY, tls: true };
  config.namespace = secret.TEMPORAL_NAMESPACE;
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
