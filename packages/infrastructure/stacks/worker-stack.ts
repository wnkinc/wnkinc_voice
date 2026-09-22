/**
 * The Temporal Worker (packages/worker) as a container Lambda that Temporal
 * Cloud invokes when its task queue has work: Serverless Workers, public
 * preview. Nothing here runs unless Temporal calls; idle costs nothing.
 *
 * Two roles, not to be confused: the function's execution role (what the
 * Worker may touch: the Temporal secret, and later the tables an activity
 * reads for a tenant) and the invocation role (what Temporal may do: invoke
 * and describe this one function). Temporal assumes the invocation role from
 * its own accounts, gated by an external id the secret generates here, so the
 * guard never passes through a person.
 *
 * After a deploy the version is registered with Temporal (deployment name and
 * build id from packages/worker/src/version.ts) and set current; see
 * scripts/temporal-release.mts.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { errorAlarm } from '../infra_utils/alarms.js';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../worker');

/** The Temporal Cloud accounts that invoke Serverless Workers (docs.temporal.io, serverless-workers/aws-lambda). */
export const TEMPORAL_CLOUD_INVOKERS = ['902542641901', '160190466495', '819232936619', '829909441867', '354116250941']
  .map((account) => `arn:aws:iam::${account}:role/wci-lambda-invoke`);

/** The platform secret holding the Temporal Cloud connection and the invocation guard. */
export const temporalSecretName = (prefix: string) => `${prefix}/temporal`;

export interface WorkerStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly alarmTopic: sns.ITopic;
}

export class WorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    const fnName = `${props.prefix}-worker`;

    // Address, namespace and API key are put in after the namespace exists
    // (ops, never a deploy variable); EXTERNAL_ID is generated here.
    const secret = new secretsmanager.Secret(this, 'Temporal', {
      secretName: temporalSecretName(props.prefix),
      description: 'Temporal Cloud: namespace address, namespace, the worker API key; EXTERNAL_ID guards the invocation role',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ TEMPORAL_ADDRESS: '', TEMPORAL_NAMESPACE: '', TEMPORAL_API_KEY: '' }),
        generateStringKey: 'EXTERNAL_ID',
        passwordLength: 40,
        excludePunctuation: true,
      },
    });

    const fn = new lambda.DockerImageFunction(this, 'Worker', {
      functionName: fnName,
      description: 'Temporal Worker: invoked by Temporal Cloud when the task queue has work',
      code: lambda.DockerImageCode.fromImageAsset(PACKAGE_DIR, { platform: Platform.LINUX_ARM64, exclude: ['node_modules', 'lib', 'test', '*.md'] }),
      architecture: lambda.Architecture.ARM_64,
      // CPU scales with memory: at 1024 MB loading the SDK's native core overran
      // Lambda's 10 s init window and every cold start paid a second init.
      memorySize: 2048,
      // The invocation deadline: the Worker works until this minus its shutdown buffer.
      // Longer means fewer cold starts; an activity can never outlive it.
      timeout: cdk.Duration.minutes(10),
      environment: { TEMPORAL_SECRET_ARN: secret.secretArn, NODE_OPTIONS: '--enable-source-maps' },
      logGroup: new logs.LogGroup(this, 'Logs', { logGroupName: `/aws/lambda/${fnName}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    secret.grantRead(fn);
    errorAlarm(this, 'WorkerErrors', fn, props.alarmTopic, 'Temporal worker');

    const invoke = new iam.Role(this, 'Invoke', {
      roleName: `${props.prefix}-temporal-invoke`,
      description: 'Assumed by Temporal Cloud to invoke the worker when its task queue has work',
      assumedBy: new iam.CompositePrincipal(...TEMPORAL_CLOUD_INVOKERS.map((arn) => new iam.ArnPrincipal(arn)))
        .withConditions({ StringEquals: { 'sts:ExternalId': secret.secretValueFromJson('EXTERNAL_ID').unsafeUnwrap() } }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    // The unqualified function and every published version of it: a new build
    // id registers a new Lambda version, and the grant must already cover it.
    invoke.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction', 'lambda:GetFunction'], resources: [fn.functionArn, `${fn.functionArn}:*`] }));

    new cdk.CfnOutput(this, 'functionArn', { value: fn.functionArn });
    new cdk.CfnOutput(this, 'invokeRoleArn', { value: invoke.roleArn, description: 'The --aws-lambda-assume-role-arn when registering a version' });
    new cdk.CfnOutput(this, 'secretName', { value: secret.secretName });
  }
}
