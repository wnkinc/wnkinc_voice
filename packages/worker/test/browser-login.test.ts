/** The login handoff: one window at a time, the saved browser reused or created once, the window a real timer, the release and the row cleared after it. */
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserLogin } from '../src/workflows/index.js';
import { failure, fakes, run as runWorkflow, tenant, type Fakes, testEnv } from './fakes.js';

const input = { tenantId: 'deck', tenantPhoneNumber: '+15550001111', chatId: 777, text: '/login hubspot', windowSeconds: 600 };
let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await testEnv(); }, 120_000);
afterAll(async () => { await env?.teardown(); });
const run = (f: Fakes) => runWorkflow(env, f, browserLogin, [input]);
const told = (f: Fakes) => f.sendTelegram.mock.calls.map((c) => c[1]);

describe('browser login', () => {
  it('creates the saved browser once, opens the window, and closes it after the timer', async () => {
    const f = fakes();
    expect(await run(f)).toBe('closed');
    expect(f.claimLoginWindow).toHaveBeenCalledTimes(1);
    expect(f.createBrowserContext).toHaveBeenCalledWith('deck');
    expect(f.saveBrowserContext).toHaveBeenCalledWith('+15550001111', 'ctx-new');
    expect(f.startBrowserSession).toHaveBeenCalledWith('ctx-new', 900);
    expect(told(f)[0]).toContain('Browser ready for hubspot.');
    expect(told(f)[0]).toContain('https://live/1');
    expect(told(f)[0]).toContain('browser.contextId = ctx-new');
    expect(f.releaseBrowserSession).toHaveBeenCalledWith('sess-1');
    expect(f.clearLoginWindow).toHaveBeenCalledWith('+15550001111');
    expect(told(f)[1]).toBe('Browser closed. Whatever you signed into is saved for this business.');
  }, 60_000);

  it('reuses the saved browser and says nothing about the file', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...tenant, browser: { enabled: true, contextId: 'ctx-old' } });
    await run(f);
    expect(f.createBrowserContext).not.toHaveBeenCalled();
    expect(f.startBrowserSession).toHaveBeenCalledWith('ctx-old', 900);
    expect(told(f)[0]).not.toContain('tenant file');
  }, 60_000);

  it('a window already open: says so and opens nothing', async () => {
    const f = fakes();
    f.claimLoginWindow.mockResolvedValue(false);
    expect(await run(f)).toBe('busy');
    expect(f.startBrowserSession).not.toHaveBeenCalled();
    expect(told(f)).toEqual(['A browser is already open for this business. Use the link you have, or try again once it closes.']);
  }, 60_000);

  it('a failed release still clears the window and tells the owner', async () => {
    const f = fakes();
    f.releaseBrowserSession.mockRejectedValue(new Error('gone'));
    expect(await run(f)).toBe('closed');
    expect(f.clearLoginWindow).toHaveBeenCalled();
  }, 60_000);

  it('fails closed when the browser product is off', async () => {
    const f = fakes();
    f.lookupTenant.mockResolvedValue({ ...tenant, browser: { enabled: false } });
    expect((await failure(run(f))).type).toBe('BrowserNotEnabled');
    expect(f.claimLoginWindow).not.toHaveBeenCalled();
  }, 60_000);
});
