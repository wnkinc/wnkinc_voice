/** Stack-side pieces a state machine needs (CDK constructs): logging preset and the HTTP-task grant. */
import * as cdk from 'aws-cdk-lib';
import type * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';

/**
 * Express with execution data NOT logged: for workflows whose inputs or
 * fetched payloads carry transcripts, CRM notes, or SIP headers. State
 * transitions and errors still log (and the failed-executions alarm still
 * fires); payloads are persisted nowhere.
 */
export function expressNoData(scope: Construct, logId: string) {
  return {
    stateMachineType: sfn.StateMachineType.EXPRESS,
    logs: {
      destination: new logs.LogGroup(scope, logId, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      level: sfn.LogLevel.ALL,
      includeExecutionData: false,
    },
  };
}

/** What an HTTP task needs: the endpoint allow-list, the connection, and the secret EventBridge keeps for it. */
export function grantHttp(wf: sfn.StateMachine, connections: events.IConnection[], endpointPatterns: string[]) {
  const stack = cdk.Stack.of(wf);
  wf.addToRolePolicy(new iam.PolicyStatement({
    actions: ['states:InvokeHTTPEndpoint'], resources: ['*'],
    conditions: { StringLike: { 'states:HTTPEndpoint': endpointPatterns } },
  }));
  wf.addToRolePolicy(new iam.PolicyStatement({ actions: ['events:RetrieveConnectionCredentials'], resources: connections.map((c) => c.connectionArn) }));
  wf.addToRolePolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:events!connection/*`],
  }));
}
