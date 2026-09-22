/**
 * What the worker stack guarantees: Temporal can invoke this one function and
 * nothing else, only from its own accounts and only with the external id; the
 * worker reads the named platform secrets and no other; the SMS starter, the
 * same image with a different handler, reaches only the Temporal secret.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
  tenantsTable: table('Tenants'), peopleTable: table('People'), actionsTable: table('Actions'), usageTable: table('Usage'),
  openaiSecret: secret('OpenAI'), composioSecret: secret('Composio'), twilioSecret: secret('Twilio'),
  mediaLinkFunction: new lambda.Function(platform, 'MediaLink', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => ({})') }),
  callerMemory: { memoryId: 'mem', memoryArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem' },
  api: new apigwv2.HttpApi(platform, 'Api'),
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

  it('the worker reads the Temporal secret and the three platform secrets its activities need, and no other', () => {
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets.map((s) => s.Properties.Name)).toEqual([temporalSecretName('p')]);
    const worker = fnByName('p-worker')!;
    const reads = statementsOf(worker.Properties.Role['Fn::GetAtt'][0]).filter((s) => actions(s).includes('secretsmanager:GetSecretValue'));
    const resources = reads.flatMap((s) => [s.Resource].flat()).map((r) => JSON.stringify(r));
    expect(resources).toHaveLength(4);
    expect(resources.some((r) => r.includes('"Ref":"' + Object.keys(template.findResources('AWS::SecretsManager::Secret'))[0]))).toBe(true);
    for (const imported of ['OpenAI', 'Composio', 'Twilio']) expect(resources.some((r) => r.includes(imported))).toBe(true);
    const envVars = worker.Properties.Environment.Variables;
    for (const key of ['PEOPLE_TABLE', 'TENANTS_TABLE', 'ACTIONS_TABLE', 'USAGE_TABLE', 'OPENAI_SECRET_ARN', 'COMPOSIO_SECRET_ARN', 'TWILIO_SECRET_ARN', 'MEDIA_LINK_FUNCTION_ARN', 'MEMORY_ID', 'TEMPORAL_SECRET_ARN']) expect(envVars[key]).toBeDefined();
    expect(envVars.TEMPORAL_API_KEY).toBeUndefined();
  });

  it('the SMS starter is the same image with a different handler, and reaches only the Temporal secret', () => {
    const worker = fnByName('p-worker')!;
    const starter = fnByName('p-sms-start')!;
    expect(starter.Properties.Code.ImageUri).toEqual(worker.Properties.Code.ImageUri);
    expect(starter.Properties.ImageConfig.Command).toEqual(['lib/starter.handler']);
    expect(worker.Properties.ImageConfig.Command).toEqual(['lib/handler.handler']);
    const statements = statementsOf(starter.Properties.Role['Fn::GetAtt'][0]);
    const secretReads = statements.filter((s) => actions(s).includes('secretsmanager:GetSecretValue'));
    expect(secretReads).toHaveLength(1);
    expect(secretReads[0]?.Resource).toEqual({ Ref: Object.keys(template.findResources('AWS::SecretsManager::Secret'))[0] });
    expect(statements.flatMap(actions).filter((a) => a.startsWith('dynamodb:') || a.startsWith('bedrock-agentcore:'))).toEqual([]);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1 });
  });
});
