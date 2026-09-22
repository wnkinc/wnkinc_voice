import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { errorAlarm } from '../infra_utils/alarms.js';
import { Construct } from 'constructs';

export interface RuntimeStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly alarmTopic: sns.ITopic;
}

/**
 * What the worker's channels read that predates the worker stack: the
 * Telegram, Twilio and Browserbase secrets (their values were put in by
 * hand and a new resource would generate new ones) and the media link
 * resolver. Every workflow that once lived here runs in the Temporal worker
 * (stacks/worker-stack.ts); this stack exposes these as fields for it.
 */
export class RuntimeStack extends cdk.Stack {
  /** Twilio credentials and the generated webhook path; the worker stack's SMS route and replies use them. */
  readonly twilioSecret: secretsmanager.Secret;
  /** The media link resolver; the worker's activities invoke it. */
  readonly mediaLinkFn: lambda.IFunction;
  /** The bot token and the generated webhook path; the worker's Telegram route and replies use them. */
  readonly telegramSecret: secretsmanager.Secret;
  /** The Browserbase project key; the worker's login handoff uses it. */
  readonly browserbaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    // Bot token (set by hand, see README) plus a generated secret path segment
    // for the webhook URL: Telegram's recommended way to authenticate posts.
    const telegramSecret = new secretsmanager.Secret(this, 'TelegramSecret', {
      description: 'Telegram bot: {"TELEGRAM_BOT_TOKEN": <from BotFather>, "WEBHOOK_PATH": <generated>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TELEGRAM_BOT_TOKEN: 'set-me' }),
        generateStringKey: 'WEBHOOK_PATH',
        excludePunctuation: true,
        passwordLength: 40,
      },
    });
    // Browserbase: one platform project (its id is cdk.json context: not a
    // secret); each tenant's browser is a context keyed on the row. Fill the
    // key after the first deploy:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"BROWSERBASE_API_KEY":"bb_live_..."}'
    // Do not touch generateSecretString once deployed: any change to it makes
    // CloudFormation generate a NEW value, overwriting the key you stored. (The
    // BROWSERBASE_PROJECT_ID placeholder in the template is a leftover of the
    // first deploy, kept for that reason; the project id lives in cdk.json.)
    const browserbaseSecret = new secretsmanager.Secret(this, 'BrowserbaseSecret', {
      description: 'Browserbase: {"BROWSERBASE_API_KEY": <project API key>, "BROWSERBASE_PROJECT_ID": <project id>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ BROWSERBASE_PROJECT_ID: 'set-me' }),
        generateStringKey: 'BROWSERBASE_API_KEY',
        excludePunctuation: true,
      },
    });
    // Twilio: the credentials the worker texts with and the media link resolver
    // asks Twilio with, plus a generated secret path segment for the webhook
    // URL. Fill after the first deploy (keep WEBHOOK_PATH):
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"TWILIO_ACCOUNT_SID":"AC...","TWILIO_AUTH_TOKEN":"...","WEBHOOK_PATH":"<keep>"}'
    const twilioSecret = new secretsmanager.Secret(this, 'TwilioSecret', {
      description: 'Twilio: {"TWILIO_ACCOUNT_SID": <AC...>, "TWILIO_AUTH_TOKEN": <token>, "WEBHOOK_PATH": <generated>}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TWILIO_ACCOUNT_SID: 'set-me', TWILIO_AUTH_TOKEN: 'set-me' }),
        generateStringKey: 'WEBHOOK_PATH',
        excludePunctuation: true,
        passwordLength: 40,
      },
    });
    // The media link resolver: a texted photo's Twilio ids -> the signed link
    // Twilio redirects to. Code because the redirect's Location header is the
    // answer and nothing managed hands it back. Invoked synchronously by the
    // worker's activity, so its failures surface in the workflow; no queue.
    const mediaLinkName = `${prefix}-media-link`;
    const mediaLinkFn = new NodejsFunction(this, 'MediaLink', {
      functionName: mediaLinkName,
      description: 'Texted photo ids -> the signed link Twilio redirects to (nothing fetched, nothing stored)',
      entry: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../media-link/src/media-link.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { TWILIO_SECRET_ARN: twilioSecret.secretArn, NODE_OPTIONS: '--enable-source-maps' },
      logGroup: new logs.LogGroup(this, 'MediaLinkLogs', { logGroupName: `/aws/lambda/${mediaLinkName}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      tracing: lambda.Tracing.ACTIVE,
      bundling: { format: OutputFormat.ESM, target: 'node22', mainFields: ['module', 'main'], sourceMap: true },
    });
    twilioSecret.grantRead(mediaLinkFn);
    errorAlarm(this, 'MediaLinkErrors', mediaLinkFn, props.alarmTopic, 'Media link resolver');

    new cdk.CfnOutput(this, 'telegramSecretArn', { value: telegramSecret.secretArn });
    new cdk.CfnOutput(this, 'twilioSecretArn', { value: twilioSecret.secretArn });
    new cdk.CfnOutput(this, 'browserbaseSecretArn', { value: browserbaseSecret.secretArn });
    this.twilioSecret = twilioSecret;
    this.mediaLinkFn = mediaLinkFn;
    this.telegramSecret = telegramSecret;
    this.browserbaseSecret = browserbaseSecret;
  }
}
