/** The connection canary: every tenant's expected toolkits ACTIVE, or a failed workflow that names what is missing. */
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composioHealth } from '../src/workflows/index.js';
import { failure, fakes, run as runWorkflow, tenant, testEnv } from './fakes.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await testEnv(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

describe('composio health', () => {
  it('checks each tenant that promises a connection, and passes when all are active', async () => {
    const f = fakes();
    f.listTenants.mockResolvedValue([
      { ...tenant, tenantId: 'a', crm: { type: 'hubspot', via: 'composio' }, emailResponder: { enabled: true } },
      { ...tenant, tenantId: 'quiet', assistant: { enabled: false }, facebookPosts: { enabled: false } },
    ]);
    f.composioAccounts.mockResolvedValue([{ id: '1', toolkit: 'hubspot' }, { id: '2', toolkit: 'gmail' }, { id: '3', toolkit: 'facebook' }]);
    expect(await runWorkflow(env, f, composioHealth, [])).toEqual({ checked: ['a'] });
    expect(f.composioAccounts).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('fails naming the tenant and the missing toolkit, and a tenant with the assistant on but nothing connected', async () => {
    const f = fakes();
    f.listTenants.mockResolvedValue([
      { ...tenant, tenantId: 'a', crm: { type: 'hubspot', via: 'composio' }, facebookPosts: { enabled: false } },
      { ...tenant, tenantId: 'b', facebookPosts: { enabled: false }, assistant: { enabled: true, tools: [] } },
    ]);
    f.composioAccounts.mockResolvedValueOnce([{ id: '2', toolkit: 'gmail' }]).mockResolvedValueOnce([]);
    const failed = await failure(runWorkflow(env, f, composioHealth, []));
    expect(failed.type).toBe('ComposioConnectionMissing');
    expect(failed.message).toContain('tenant a: no ACTIVE Composio account for hubspot');
    expect(failed.message).toContain('tenant b: assistant is on but no ACTIVE Composio account at all');
  }, 60_000);
});
