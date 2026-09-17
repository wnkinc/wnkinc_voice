/**
 * The tenancy guarantees of a Telegram connector stack: its role reads only
 * its own tenant's secrets, and one instance at a time holds the session.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { TelegramMcpStack, telegramMcpSecretPath } from '../stacks/telegram-mcp-stack.js';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-west-2' };
const template = (tenantId: string) =>
  Template.fromStack(new TelegramMcpStack(app, `wnk-telegram-mcp-${tenantId}-test`, { prefix: 'p', tenantId, env }));

describe('telegram-mcp stack', () => {
  const meg = template('meg');

  it('reads only its own tenant\'s secrets, from the path the function is told', () => {
    const statements = Object.values(meg.findResources('AWS::IAM::Policy'))
      .flatMap((p) => (p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[]));
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toBe('ssm:GetParameters');
    expect(JSON.stringify(statements[0]?.Resource)).toContain(`:parameter${telegramMcpSecretPath('p', 'meg')}/*`);

    const fn = Object.values(meg.findResources('AWS::Lambda::Function'))[0];
    expect(fn?.Properties.Environment.Variables.SSM_PREFIX).toBe(telegramMcpSecretPath('p', 'meg'));
  });

  it('runs one instance at a time', () => {
    meg.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 1 });
  });
});
