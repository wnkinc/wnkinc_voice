/** Every activity as a recorded fake with a quiet default, and a worker on Temporal's test server to run a workflow against them. */
import { fileURLToPath } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { expect, vi } from 'vitest';
import type * as activities from '../src/activities/index.js';
import type { ModelResult } from '../src/activities/model.js';
import type { DraftRow, PersonRecord, TenantRow } from '@wnk/shared/contracts';

type Activities = typeof activities;
export type Fakes = { [K in keyof Activities]: ReturnType<typeof vi.fn<Activities[K]>> };

export const tenant: TenantRow = {
  tenantId: 'deck', phoneNumber: '+15550001111', business: { name: 'Deck Co' },
  assistant: { enabled: true, tools: ['search_contacts', 'draft_facebook_post', 'cancel_facebook_draft'] },
  facebookPosts: { enabled: true, pageId: '42', pageName: 'Deck Co' },
  browser: { enabled: true },
};
export const person: PersonRecord = { channelId: 'sms:+15550002222', tenantId: 'deck', tenantPhone: '+15550001111', name: 'Meg', role: 'owner' };
export const photo = { messageSid: 'MM1', mediaSid: 'ME1' };
export const draft = (revision: number, shown: number): DraftRow =>
  ({ tenantId: 'deck', sk: 'sms:+15550002222#facebook_post#t#1', status: 'pending', revision, shownRevision: shown, approveBy: 9e9, payload: { caption: 'Cedar deck, finished today.', media: [photo] } });
export const answer = (reply: string, calls: ModelResult['calls'] = []): ModelResult => ({ responseId: 'r', calls, reply, tokens: 3, inputTokens: 2, outputTokens: 1 });

export function fakes(): Fakes {
  return {
    lookupPerson: vi.fn(async () => person), lookupTenant: vi.fn(async () => tenant), listTenants: vi.fn(async () => [tenant]),
    findPending: vi.fn(async () => undefined), createDraft: vi.fn(async () => ({ sk: 'new' })), reviseDraft: vi.fn(async () => true), cancelDraft: vi.fn(async () => true),
    lockDraft: vi.fn(async () => true), markShown: vi.fn(async () => true), markCompleted: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined), markUnconfirmed: vi.fn(async () => undefined),
    rememberMedia: vi.fn(async () => undefined), recentMedia: vi.fn(async () => []),
    sendText: vi.fn(async () => undefined), sendTelegram: vi.fn(async () => undefined), mintLinks: vi.fn(async () => ['https://link/1']),
    callModel: vi.fn(async () => answer('Sure.')), executeTool: vi.fn(async () => ({ successful: true, data: { id: 'page_post1' } })),
    loadHistory: vi.fn(async () => []), recall: vi.fn(async () => []), saveTurn: vi.fn(async () => undefined), recordUsage: vi.fn(async () => undefined),
    claimLoginWindow: vi.fn(async () => true), clearLoginWindow: vi.fn(async () => undefined), saveBrowserContext: vi.fn(async () => undefined),
    createBrowserContext: vi.fn(async () => 'ctx-new'), startBrowserSession: vi.fn(async () => 'sess-1'), browserLiveView: vi.fn(async () => 'https://live/1'), releaseBrowserSession: vi.fn(async () => undefined),
    readCall: vi.fn(async () => ({ done: false, transcript: [] })), markDone: vi.fn(async () => true), rememberCall: vi.fn(async () => undefined),
    composioAccounts: vi.fn(async () => []), composioProxy: vi.fn(async () => ({ successful: true, data: {} })), recallPreferences: vi.fn(async () => []), recordMeter: vi.fn(async () => undefined),
    echo: vi.fn(async (n: string) => `pong: ${n}`),
  };
}

let n = 0;
/** Runs one workflow to completion on its own task queue against these fakes. */
export async function run<T>(env: TestWorkflowEnvironment, f: Fakes, workflow: (...args: any[]) => Promise<T>, args: unknown[]): Promise<T> {
  const taskQueue = `t-${n++}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)), activities: f });
  return worker.runUntil(env.client.workflow.execute(workflow as any, { taskQueue, workflowId: `wf-${taskQueue}`, args })) as Promise<T>;
}

/** The failure a workflow ended with, as the client reports it: the cause under the wrapper. */
export async function failure(p: Promise<unknown>): Promise<{ type?: string | null; message: string }> {
  try { await p; } catch (err) {
    const cause = (err as { cause?: { type?: string | null; message: string } }).cause;
    if (cause) return cause;
    throw err;
  }
  expect.fail('the workflow completed');
}
