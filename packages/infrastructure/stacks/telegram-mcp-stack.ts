import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../telegram-mcp');

export interface TelegramMcpStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly tenantId: string;
}

/** The tenant-named secret holding this tenant's connector credentials. */
export function telegramMcpSecretName(prefix: string, tenantId: string): string {
  return `${prefix}/${tenantId}/telegram-mcp`;
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
    const fnName = `${props.prefix}-${props.tenantId}-telegram-mcp`;

    // The tenant's Telegram credentials, with the URL token generated here so it
    // never passes through a person. The three Telegram values are placeholders
    // until the tenant's login is put in (packages/telegram-mcp/README.md).
    const secret = new secretsmanager.Secret(this, 'Credentials', {
      secretName: telegramMcpSecretName(props.prefix, props.tenantId),
      description: `Telegram MCP connector for tenant ${props.tenantId}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '', TELEGRAM_SESSION_STRING: '' }),
        generateStringKey: 'URL_TOKEN',
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    const fn = new lambda.DockerImageFunction(this, 'Server', {
      functionName: fnName,
      code: lambda.DockerImageCode.fromImageAsset(PACKAGE_DIR, { platform: Platform.LINUX_ARM64, exclude: ['*.md'] }),
      architecture: lambda.Architecture.ARM_64,
      // CPU scales with memory; less than this and imports overrun the 10s init window.
      memorySize: 1536,
      timeout: cdk.Duration.seconds(90),
      // Telegram revokes a session it sees from two IPs at once, and every instance has its own IP.
      reservedConcurrentExecutions: 1,
      environment: { SECRET_ARN: secret.secretArn, TELEGRAM_EXPOSED_TOOLS: 'all' },
      logGroup: new logs.LogGroup(this, 'Logs', {
        logGroupName: `/aws/lambda/${fnName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    secret.grantRead(fn);

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new cdk.CfnOutput(this, 'baseUrl', { value: url.url, description: 'The connector URL is this + mcp/<URL_TOKEN from the secret>' });
    new cdk.CfnOutput(this, 'secretArn', { value: secret.secretArn });
  }
}
