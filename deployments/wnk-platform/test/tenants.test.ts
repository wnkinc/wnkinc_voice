/**
 * What this deployment's tenants get, and that core names none of them. The
 * rules a tenant file makes are the isolation proof: each matches that
 * tenant's events alone.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { TenantStack } from '../../../packages/infrastructure/stacks/tenant-stack.js';
import { tenants } from '../tenants/index.js';
import { wnk } from '../tenants/wnk.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const CORE = ['packages', 'scripts'];
const files = (path: string): string[] => statSync(path).isDirectory()
  ? readdirSync(path).filter((n) => !['node_modules', 'lib', 'test', 'cdk.out'].includes(n)).flatMap((n) => files(join(path, n)))
  : /\.(ts|mts|py)$/.test(path) ? [path] : [];
const lines = CORE.flatMap((p) => files(join(ROOT, p))).flatMap((file) => readFileSync(file, 'utf8').split('\n').map((text, i) => ({ at: `${file.slice(ROOT.length + 1)}:${i + 1}`, text })));

describe('this deployment\'s tenants', () => {
  it('are named nowhere in core', () => {
    expect(lines.length).toBeGreaterThan(1000);
    for (const { tenantId } of tenants) expect(lines.filter((l) => new RegExp(`['"]${tenantId}['"]`).test(l.text)).map((l) => l.at), tenantId).toEqual([]);
  });

  it('wnk: one rule per automation, each matching its events alone', () => {
    const app = new cdk.App();
    const env = { account: '123456789012', region: 'us-west-2' };
    const platform = new cdk.Stack(app, 'platform-test', { env });
    const starter = new lambda.Function(platform, 'Starter', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => ({})') });
    const stack = new TenantStack(app, 'tenant-wnk-test', { ...wnk, prefix: 'p', env, bus: new events.EventBus(platform, 'Bus'), alarmTopic: new sns.Topic(platform, 'Alarms'), automationStarter: starter });
    const rules = Object.values(Template.fromStack(stack).findResources('AWS::Events::Rule'));
    const table = rules.map((r) => ({
      on: r.Properties.EventPattern['detail-type'], tenant: r.Properties.EventPattern.detail.tenantId,
      workflow: JSON.parse(r.Properties.Targets[0].InputTransformer.InputTemplate.replace(/<detail>|<id>/g, '{}')).workflow,
    })).sort((a, b) => a.workflow.localeCompare(b.workflow));
    expect(table).toEqual([
      { on: ['appointment.requested'], tenant: ['wnk'], workflow: 'bookAppointment' },
      { on: ['call.ended'], tenant: ['wnk'], workflow: 'crmCall' },
      { on: ['lead.recorded'], tenant: ['wnk'], workflow: 'crmLead' },
      { on: ['lead.recorded'], tenant: ['wnk'], workflow: 'leadEmail' },
      { on: ['owner.notify'], tenant: ['wnk'], workflow: 'ownerAlert' },
    ]);
  });
});
