import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../telegram-mcp');

export interface TelegramMcpStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly tenantId: string;
}

/** Where one tenant's connector secrets live in SSM: `api-id`, `api-hash`, `session-string`, `url-token` under it. */
export function telegramMcpSecretPath(prefix: string, tenantId: string): string {
  return `/${prefix}/${tenantId}/telegram-mcp`;
}

/**
 * One tenant's Telegram account as a remote MCP server (packages/telegram-mcp):
 * a container Lambda behind a public Function URL whose path carries the
 * tenant's secret token. The tenant is fixed here, at deploy; no request names
 * it, and the role reads only that tenant's secrets. Takes no platform handles,
 * so deploying it touches nothing else.
 */
export class TelegramMcpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TelegramMcpStackProps) {
    super(scope, id, props);
    const secretPath = telegramMcpSecretPath(props.prefix, props.tenantId);
    const fnName = `${props.prefix}-${props.tenantId}-telegram-mcp`;

    const fn = new lambda.DockerImageFunction(this, 'Server', {
      functionName: fnName,
      code: lambda.DockerImageCode.fromImageAsset(PACKAGE_DIR, { platform: Platform.LINUX_ARM64, exclude: ['*.md'] }),
      architecture: lambda.Architecture.ARM_64,
      // CPU scales with memory; less than this and imports overrun the 10s init window.
      memorySize: 1536,
      timeout: cdk.Duration.seconds(90),
      // Telegram revokes a session it sees from two IPs at once, and every instance has its own IP.
      reservedConcurrentExecutions: 1,
      environment: { SSM_PREFIX: secretPath, TELEGRAM_EXPOSED_TOOLS: 'all' },
      logGroup: new logs.LogGroup(this, 'Logs', {
        logGroupName: `/aws/lambda/${fnName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${secretPath.slice(1)}/*` })],
    }));

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new cdk.CfnOutput(this, 'baseUrl', { value: url.url, description: 'The connector URL is this + mcp/<url-token>' });
    new cdk.CfnOutput(this, 'secretPath', { value: secretPath });
  }
}
