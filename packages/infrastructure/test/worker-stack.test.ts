/**
 * What the worker stack guarantees: Temporal can invoke this one function and
 * nothing else, only from its own accounts and only with the external id; the
 * worker reads the named platform secrets and no other; the SMS starter, the
 * same image with a different handler, reaches only the Temporal secret.
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { TEMPORAL_CLOUD_INVOKERS, WorkerStack, temporalSecretName } from '../stacks/worker-stack.js';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-west-2' };
const platform = new cdk.Stack(app, 'platform-test', { env });
const table = (id: string) => new dynamodb.Table(platform, id, { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });
const secret = (id: string) => new secretsmanager.Secret(platform, id);
const stack = new WorkerStack(app, 'wnk-worker-test', {
  prefix: 'p', env, alarmTopic: new sns.Topic(platform, 'Alarms'),
  tenantsTable: table('Tenants'), callsTable: table('Calls'), peopleTable: table('People'), actionsTable: table('Actions'), usageTable: table('Usage'),
  mediaBucket: new s3.Bucket(platform, 'Media'),
  openaiSecret: secret('OpenAI'), composioSecret: secret('Composio'), browserbaseProjectId: 'proj',
  callerMemory: { memoryId: 'mem', memoryArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem' },
  api: new apigwv2.HttpApi(platform, 'Api'), bus: new events.EventBus(platform, 'Bus'),
});
const template = Template.fromStack(stack);

type Statement = { Action: string | string[]; Resource: unknown; Principal?: { AWS: string | string[] }; Condition?: Record<string, Record<string, unknown>> };
const roles = template.findResources('AWS::IAM::Role');
const functions = template.findResources('AWS::Lambda::Function');
const invoke = Object.values(roles).find((r) => r.Properties.RoleName === 'p-temporal-invoke');
const fnByName = (name: string) => Object.values(functions).find((f) => f.Properties.FunctionName === name);
const statementsOf = (roleRef: string) => Object.values(template.findResources('AWS::IAM::Policy'))
  .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleRef))
  .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
const actions = (s: Statement) => [s.Action].flat();

describe('worker stack', () => {
  it('lets only Temporal Cloud assume the invocation role, and only with the external id', () => {
    // CDK renders a composite principal as one statement per principal; every one carries the condition.
    const trust = invoke?.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust.flatMap((s) => [s.Principal?.AWS].flat()).sort()).toEqual([...TEMPORAL_CLOUD_INVOKERS].sort());
    for (const s of trust) expect(JSON.stringify(s.Condition?.StringEquals?.['sts:ExternalId'])).toContain('SecretString:EXTERNAL_ID');
  });

  it('lets that role invoke and describe the worker function and its versions, nothing else', () => {
    const invokeRef = Object.keys(roles).find((k) => roles[k] === invoke)!;
    const statements = statementsOf(invokeRef);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual(['lambda:InvokeFunction', 'lambda:GetFunction']);
    const fnRef = Object.keys(functions).find((k) => functions[k]?.Properties.FunctionName === 'p-worker');
    expect(JSON.stringify(statements[0]?.Resource)).toContain(`"Fn::GetAtt":["${fnRef}","Arn"]`);
    expect(JSON.stringify(statements[0]?.Resource)).toContain(':*');
  });

  it('the worker reads the Temporal secret, the three channel secrets, and the two platform secrets its activities need, and no other', () => {
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets.map((s) => s.Properties.Name).filter(Boolean)).toEqual([temporalSecretName('p')]);
    expect(secrets).toHaveLength(4);
    const worker = fnByName('p-worker')!;
    const reads = statementsOf(worker.Properties.Role['Fn::GetAtt'][0]).filter((s) => actions(s).includes('secretsmanager:GetSecretValue'));
    const resources = reads.flatMap((s) => [s.Resource].flat()).map((r) => JSON.stringify(r));
    expect(resources).toHaveLength(6);
    for (const own of Object.keys(template.findResources('AWS::SecretsManager::Secret'))) expect(resources.some((r) => r.includes('"Ref":"' + own))).toBe(true);
    for (const imported of ['OpenAI', 'Composio']) expect(resources.some((r) => r.includes(imported))).toBe(true);
    const envVars = worker.Properties.Environment.Variables;
    for (const key of ['PEOPLE_TABLE', 'TENANTS_TABLE', 'ACTIONS_TABLE', 'MEDIA_BUCKET', 'CALLS_TABLE', 'USAGE_TABLE', 'OPENAI_SECRET_ARN', 'COMPOSIO_SECRET_ARN', 'TWILIO_SECRET_ARN', 'TELEGRAM_SECRET_ARN', 'BROWSERBASE_SECRET_ARN', 'BROWSERBASE_PROJECT_ID', 'MEMORY_ID', 'TEMPORAL_SECRET_ARN']) expect(envVars[key]).toBeDefined();
    expect(envVars.TEMPORAL_API_KEY).toBeUndefined();
  });

  it('the starters are the same image with different handlers, and reach only the Temporal secret', () => {
    const worker = fnByName('p-worker')!;
    expect(worker.Properties.ImageConfig.Command).toEqual(['lib/handler.handler']);
    for (const [name, cmd] of [['p-sms-start', 'lib/starter.handler'], ['p-telegram-start', 'lib/starter.telegram'], ['p-automation-start', 'lib/starter.automation']] as const) {
      const starter = fnByName(name)!;
      expect(starter.Properties.Code.ImageUri).toEqual(worker.Properties.Code.ImageUri);
      expect(starter.Properties.ImageConfig.Command).toEqual([cmd]);
      const statements = statementsOf(starter.Properties.Role['Fn::GetAtt'][0]);
      const secretReads = statements.filter((s) => actions(s).includes('secretsmanager:GetSecretValue'));
      expect(secretReads).toHaveLength(1);
      expect(secretReads[0]?.Resource).toEqual({ Ref: Object.entries(template.findResources('AWS::SecretsManager::Secret')).find(([, s]) => s.Properties.Name)![0] });
      expect(statements.flatMap(actions).filter((a) => a.startsWith('dynamodb:') || a.startsWith('bedrock-agentcore:'))).toEqual([]);
    }
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1 });
    const rule = Object.values(template.findResources('AWS::Events::Rule'))[0]!;
    expect(rule.Properties.EventPattern).toEqual({ source: ['wnkinc.voice'], 'detail-type': ['call.ended'] });
    expect(rule.Properties.Targets[0].InputTransformer.InputTemplate).toContain('"workflow":"callEnded"');
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => JSON.stringify(r.Properties.RouteKey));
    expect(routes.some((r) => r.includes('/temporal/sms/'))).toBe(true);
    expect(routes.some((r) => r.includes('/temporal/telegram/'))).toBe(true);
  });

  it('the fallback is the same image as a long-running process at zero tasks, writing the same log group, with the worker\'s grants', () => {
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0, LaunchType: 'FARGATE' });
    const task = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0]!;
    const container = task.Properties.ContainerDefinitions[0];
    expect(container.EntryPoint).toEqual(['/var/lang/bin/node', '/var/task/lib/service.js']);
    expect(container.LogConfiguration.Options['awslogs-group']).toEqual(fnByName('p-worker')!.Properties.LoggingConfig.LogGroup);
    const taskRole = task.Properties.TaskRoleArn['Fn::GetAtt'][0];
    const workerRole = fnByName('p-worker')!.Properties.Role['Fn::GetAtt'][0];
    const strip = (ref: string) => JSON.stringify(statementsOf(ref).map((st) => [st.Action, st.Resource])).replaceAll(ref, 'ROLE');
    expect(strip(taskRole)).toEqual(strip(workerRole));
    // No NAT gateway: the worker only calls out, and a gateway would cost more than the stack.
    expect(Object.keys(template.findResources('AWS::EC2::NatGateway'))).toHaveLength(0);
  });

  it('alarms on the SDK\'s own failure lines: one failed workflow pages, a run of failed activities pages', () => {
    const filters = Object.values(template.findResources('AWS::Logs::MetricFilter'));
    expect(filters.map((f) => f.Properties.FilterPattern).sort()).toEqual([
      '{ ($.level = "WARN") && ($.message = "Activity failed") }',
      '{ ($.level = "WARN") && ($.message = "Workflow failed") }',
    ]);
    for (const f of filters) expect(f.Properties.LogGroupName).toEqual(fnByName('p-worker')!.Properties.LoggingConfig.LogGroup);
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter((a) => a.Properties.Namespace === 'p/temporal');
    expect(alarms.map((a) => [a.Properties.MetricName, a.Properties.Threshold, a.Properties.Period]).sort()).toEqual([['ActivityFailed', 5, 3600], ['WorkflowFailed', 1, 300]]);
    for (const a of alarms) expect(a.Properties.AlarmActions).toHaveLength(1);
  });
});
