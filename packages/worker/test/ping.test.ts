/** A workflow runs through a real Worker against Temporal's test server, with time skipped. */
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as activities from '../src/activities/index.js';
import { ping } from '../src/workflows/index.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

it('runs ping through a worker: workflow task, activity, result', async () => {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'test',
    workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
    activities,
  });
  const result = await worker.runUntil(env.client.workflow.execute(ping, { taskQueue: 'test', workflowId: 'ping-test', args: ['wnk'] }));
  expect(result).toBe('pong: wnk');
}, 120_000);
