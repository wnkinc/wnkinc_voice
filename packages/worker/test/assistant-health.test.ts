/** The canary: every tenant with the assistant on gets one read-only turn; a silent one fails the workflow, which is the alarm. */
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantHealth } from '../src/workflows/index.js';
import { answer, failure, fakes, run as runWorkflow, tenant, type Fakes } from './fakes.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });
const run = (f: Fakes) => runWorkflow(env, f, assistantHealth, []);

describe('assistant health', () => {
  it('probes each tenant with the assistant on, with one tool, in its own memory session', async () => {
    const f = fakes();
    f.listTenants.mockResolvedValue([tenant, { ...tenant, tenantId: 'off', assistant: { enabled: false } }]);
    expect(await run(f)).toEqual({ probed: ['deck'] });
    expect(f.callModel).toHaveBeenCalledTimes(1);
    expect((f.callModel.mock.calls[0]?.[0].tools as { name: string }[]).map((t) => t.name)).toEqual(['search_contacts']);
    expect(f.saveTurn).toHaveBeenCalledWith('deck_canary', expect.stringMatching(/^canary-deck-\d{8}$/), expect.any(String), 'Sure.');
    expect(f.recordUsage).not.toHaveBeenCalled();
  }, 60_000);

  it('a tenant whose loop produces no text fails the workflow, naming it', async () => {
    const f = fakes();
    f.callModel.mockResolvedValue(answer(''));
    const failed = await failure(run(f));
    expect(failed.type).toBe('AssistantSilent');
    expect(failed.message).toContain('deck');
  }, 60_000);
});
