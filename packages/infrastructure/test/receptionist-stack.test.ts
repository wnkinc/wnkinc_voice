/**
 * What the receptionist stack guarantees: each of the three Lambdas reaches
 * only what its step needs (the verifier a secret and accept; accept the
 * tables, the queue and the caller memory; the session the tables and the
 * bus), the webhook route lands on the platform's API, and a failed call
 * pages through the dead-letter queues.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { ReceptionistStack } from '../stacks/receptionist-stack.js';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-west-2' };
const platform = new cdk.Stack(app, 'platform-test', { env });
const table = (id: string) => new dynamodb.Table(platform, id, { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });
const stack = new ReceptionistStack(app, 'p-receptionist-test', {
  prefix: 'p', env, tenantsTable: table('Tenants'), callsTable: table('Calls'), bus: new events.EventBus(platform, 'Bus'), api: new apigwv2.HttpApi(platform, 'Api'),
  alarmTopic: new sns.Topic(platform, 'Alarms'), openaiSecret: new secretsmanager.Secret(platform, 'OpenAI'), composioSecret: new secretsmanager.Secret(platform, 'Composio'),
  callerMemory: { memoryId: 'mem', memoryArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem' },
});
const template = Template.fromStack(stack);

type Statement = { Action: string | string[]; Resource: unknown };
const functions = template.findResources('AWS::Lambda::Function');
const fnByName = (name: string) => Object.values(functions).find((f) => f.Properties.FunctionName === name)!;
const actionsOf = (name: string) => Object.values(template.findResources('AWS::IAM::Policy'))
  .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === fnByName(name).Properties.Role['Fn::GetAtt'][0]))
  .flatMap((p) => (p.Properties.PolicyDocument.Statement as Statement[]).flatMap((s) => [s.Action].flat()))
  .filter((a) => !a.startsWith('xray:')).sort();

describe('receptionist stack', () => {
  it('the verifier reads the OpenAI secret and invokes accept, nothing else', () => {
    expect(actionsOf('p-webhook')).toEqual(['lambda:InvokeFunction', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
    expect(fnByName('p-webhook').Properties.Environment.Variables.ACCEPT_FUNCTION_NAME).toEqual({ Ref: Object.keys(functions).find((k) => functions[k]?.Properties.FunctionName === 'p-accept') });
  });
  it('accept reads the tenant, claims the call, recalls the caller, queues the session; it publishes nothing', () => {
    const a = actionsOf('p-accept');
    for (const need of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'sqs:SendMessage', 'bedrock-agentcore:RetrieveMemoryRecords']) expect(a).toContain(need);
    expect(a.some((x) => x.startsWith('events:'))).toBe(false);
    expect(fnByName('p-accept').Properties.DeadLetterConfig).toBeDefined();
  });
  it('the session reads the tenant, writes the call, and publishes to the bus; it reaches no queue and no memory', () => {
    const a = actionsOf('p-session');
    for (const need of ['dynamodb:GetItem', 'dynamodb:PutItem', 'events:PutEvents']) expect(a).toContain(need);
    expect(a.some((x) => x.startsWith('bedrock-agentcore:') || x === 'sqs:SendMessage')).toBe(false);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'] });
    template.hasResourceProperties('AWS::SQS::Queue', { VisibilityTimeout: 960 });
  });
  it('one route, the OpenAI webhook, on the platform API; the dead-letter queues page', () => {
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes.map((r) => r.Properties.RouteKey)).toEqual(['POST /openai/webhook']);
    expect(JSON.stringify(routes[0]?.Properties.ApiId)).toContain('Fn::ImportValue');
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms.filter((a) => a.Properties.MetricName === 'ApproximateNumberOfMessagesVisible')).toHaveLength(2);
    for (const a of alarms) expect(a.Properties.AlarmActions).toHaveLength(1);
  });
});
