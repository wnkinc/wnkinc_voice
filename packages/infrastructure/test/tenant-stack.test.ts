/**
 * The tenancy guarantee of a tenant stack, as data: every rule names this
 * tenant alone, targets the worker's starter, and hands it the workflow name
 * and this tenant's options. What the four rules are for a tenant file is
 * the isolation proof the definition snapshots used to be.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { TenantStack } from '../stacks/tenant-stack.js';
import { wnk } from '../../../tenants/wnk.js';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-west-2' };
const platform = new cdk.Stack(app, 'platform-test', { env });
const starter = new lambda.Function(platform, 'Starter', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => ({})') });
const stack = new TenantStack(app, 'wnk-tenant-wnk-test', { ...wnk, prefix: 'p', env, bus: new events.EventBus(platform, 'Bus'), alarmTopic: new sns.Topic(platform, 'Alarms'), automationStarter: starter });
const template = Template.fromStack(stack);

describe('tenant stack', () => {
  const rules = Object.values(template.findResources('AWS::Events::Rule'));

  it('one rule per automation in the tenant file, each matching this tenant\'s events alone', () => {
    const table = rules.map((r) => ({
      on: r.Properties.EventPattern['detail-type'], tenant: r.Properties.EventPattern.detail.tenantId,
      workflow: JSON.parse(r.Properties.Targets[0].InputTransformer.InputTemplate.replace(/<detail>|<id>/g, '{}')).workflow,
    })).sort((a, b) => a.workflow.localeCompare(b.workflow));
    expect(table).toEqual([
      { on: ['call.ended'], tenant: ['wnk'], workflow: 'crmCall' },
      { on: ['lead.recorded'], tenant: ['wnk'], workflow: 'crmLead' },
      { on: ['lead.recorded'], tenant: ['wnk'], workflow: 'leadEmail' },
      { on: ['owner.notify'], tenant: ['wnk'], workflow: 'ownerAlert' },
    ]);
  });

  it('every rule targets the worker\'s starter with the event detail and this tenant\'s options, with a dead letter', () => {
    for (const r of rules) {
      const t = r.Properties.Targets[0];
      expect(JSON.stringify(t.Arn)).toContain('Starter');
      expect(t.InputTransformer.InputPathsMap).toEqual({ detail: '$.detail', id: '$.id' });
      expect(t.InputTransformer.InputTemplate).toContain('"options":{}');
      expect(t.DeadLetterConfig).toBeDefined();
      expect(t.RetryPolicy.MaximumRetryAttempts).toBe(2);
    }
  });
});
