/**
 * What the worker stack guarantees: Temporal can invoke this one function and
 * nothing else, only from its own accounts and only with the external id; the
 * function reads only the secret it is pointed at.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { TEMPORAL_CLOUD_INVOKERS, WorkerStack, temporalSecretName } from '../stacks/worker-stack.js';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-west-2' };
const alarms = new cdk.Stack(app, 'alarms-test', { env });
const stack = new WorkerStack(app, 'wnk-worker-test', { prefix: 'p', env, alarmTopic: new sns.Topic(alarms, 'Alarms') });
const template = Template.fromStack(stack);

type Statement = { Action: string | string[]; Resource: unknown; Principal?: { AWS: string | string[] }; Condition?: Record<string, Record<string, unknown>> };
const roles = template.findResources('AWS::IAM::Role');
const invoke = Object.values(roles).find((r) => r.Properties.RoleName === 'p-temporal-invoke');

describe('worker stack', () => {
  it('lets only Temporal Cloud assume the invocation role, and only with the external id', () => {
    // CDK renders a composite principal as one statement per principal; every one carries the condition.
    const trust = invoke?.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust.flatMap((s) => [s.Principal?.AWS].flat()).sort()).toEqual([...TEMPORAL_CLOUD_INVOKERS].sort());
    for (const s of trust) expect(JSON.stringify(s.Condition?.StringEquals?.['sts:ExternalId'])).toContain('SecretString:EXTERNAL_ID');
  });

  it('lets that role invoke and describe the worker function and its versions, nothing else', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => roles[r.Ref] === invoke));
    expect(policies).toHaveLength(1);
    const statements = policies[0]?.Properties.PolicyDocument.Statement as Statement[];
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual(['lambda:InvokeFunction', 'lambda:GetFunction']);
    const fnRef = Object.keys(template.findResources('AWS::Lambda::Function'))[0];
    expect(JSON.stringify(statements[0]?.Resource)).toContain(`"Fn::GetAtt":["${fnRef}","Arn"]`);
    expect(JSON.stringify(statements[0]?.Resource)).toContain(':*');
  });

  it('gives the function only the Temporal secret, the one it is pointed at', () => {
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets.map((s) => s.Properties.Name)).toEqual([temporalSecretName('p')]);
    const fnRole = Object.values(template.findResources('AWS::Lambda::Function'))[0]?.Properties.Role['Fn::GetAtt'][0];
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === fnRole))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toContain('secretsmanager:GetSecretValue');
    expect(statements[0]?.Resource).toEqual({ Ref: Object.keys(template.findResources('AWS::SecretsManager::Secret'))[0] });
  });
});
