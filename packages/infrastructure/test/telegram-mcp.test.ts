/**
 * The tenancy guarantees of a Telegram connector stack: its role reads only
 * its own tenant's secret, and one instance at a time holds the session.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { TelegramMcpStack, telegramMcpSecretName } from '../stacks/telegram-mcp-stack.js';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-west-2' };
const template = (tenantId: string) =>
  Template.fromStack(new TelegramMcpStack(app, `wnk-telegram-mcp-${tenantId}-test`, { prefix: 'p', tenantId, env }));

describe('telegram-mcp stack', () => {
  const meg = template('meg');

  it('reads only its own tenant\'s secret, the one the function is pointed at', () => {
    const secrets = Object.values(meg.findResources('AWS::SecretsManager::Secret'));
    expect(secrets.map((s) => s.Properties.Name)).toEqual([telegramMcpSecretName('p', 'meg')]);

    const statements = Object.values(meg.findResources('AWS::IAM::Policy'))
      .flatMap((p) => (p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[]));
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toContain('secretsmanager:GetSecretValue');
    expect(statements[0]?.Resource).toEqual({ Ref: Object.keys(meg.findResources('AWS::SecretsManager::Secret'))[0] });

    const fn = Object.values(meg.findResources('AWS::Lambda::Function'))[0];
    expect(fn?.Properties.Environment.Variables.SECRET_ARN).toEqual(statements[0]?.Resource);
  });

  it('runs one instance at a time', () => {
    meg.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 1 });
  });
});
