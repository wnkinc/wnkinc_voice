/**
 * What the platform stack guarantees: it runs nothing (data and the bus only,
 * so a deploy of it never changes behavior), every platform event is
 * recorded, and the approval ledger outlives the stack.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { EVENT_SOURCE, PlatformStack } from '../stacks/platform-stack.js';

const app = new cdk.App();
const template = Template.fromStack(new PlatformStack(app, 'p-platform-test', { prefix: 'p', env: { account: '123456789012', region: 'us-west-2' } }));

describe('platform stack', () => {
  it('runs nothing of ours: no named function (CDK adds one to set the log group policy), no queue', () => {
    for (const f of Object.values(template.findResources('AWS::Lambda::Function'))) expect(f.Properties.FunctionName).toBeUndefined();
    expect(Object.keys(template.findResources('AWS::SQS::Queue'))).toHaveLength(0);
  });
  it('names the bus, the topic and the API from the prefix; the tables take generated names', () => {
    template.hasResourceProperties('AWS::Events::EventBus', { Name: 'p-events' });
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'p-alarms' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'p-api' });
    for (const t of Object.values(template.findResources('AWS::DynamoDB::Table'))) expect(t.Properties.TableName).toBeUndefined();
  });
  it('records every platform event, from the one source, in the activity log', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.Properties.EventPattern).toEqual({ source: [EVENT_SOURCE] });
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/p/activity', RetentionInDays: 90 });
  });
  it('keeps the approval ledger when the stack goes; the dev tables go with it', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const policy = (id: string) => Object.entries(tables).find(([k]) => k.startsWith(id))?.[1]?.DeletionPolicy;
    expect(policy('Actions')).toBe('Retain');
    for (const id of ['Tenants', 'People', 'Calls', 'Usage']) expect(policy(id)).toBe('Delete');
  });
});
