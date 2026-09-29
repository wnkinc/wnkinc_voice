/**
 * What the platform is for a list of tenants: the four layers, a stack of
 * rules for each tenant with automations, a Telegram MCP stack for each
 * asking for one, every name the prefix's. The tenants are the caller's.
 */
import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { definePlatform } from '../platform.js';

const stackNames = (app: cdk.App) => app.node.children.filter(cdk.Stack.isStack).map((s) => s.stackName).sort();
const env = { account: '123456789012', region: 'us-west-2' };

describe('platform', () => {
  it('is the four layers and what each tenant asks for, named from the prefix', () => {
    const app = new cdk.App();
    definePlatform(app, {
      prefix: 'p-test', env, browserbaseProjectId: 'proj',
      tenants: [
        { tenantId: 'a', automations: [{ workflow: 'leadEmail' }] },
        { tenantId: 'b', automations: [], telegramMcp: true },
      ],
    });
    expect(stackNames(app)).toEqual(['p-test-memory', 'p-test-platform', 'p-test-receptionist', 'p-test-telegram-mcp-b', 'p-test-tenant-a', 'p-test-worker']);
  });

  it('with no tenants is the four layers alone', () => {
    const app = new cdk.App();
    definePlatform(app, { prefix: 'p-test', env, browserbaseProjectId: 'proj', tenants: [] });
    expect(stackNames(app)).toEqual(['p-test-memory', 'p-test-platform', 'p-test-receptionist', 'p-test-worker']);
  });
});
