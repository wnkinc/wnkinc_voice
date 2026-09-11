import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';

/**
 * The two alarm shapes the platform needs, as declarations. Anything that
 * failed after its retries is in a dead-letter queue; anything failing right
 * now is a function error. Both page the alarm topic. No custom metrics.
 */

/** Pages when a dead-letter queue holds anything at all. */
export function dlqAlarm(scope: Construct, id: string, queue: sqs.IQueue, topic: sns.ITopic, what: string): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    alarmDescription: `${what}: messages in the dead-letter queue (failed after retries)`,
    metric: queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cwActions.SnsAction(topic));
  return alarm;
}

/** Pages on any function error in a five-minute window. */
export function errorAlarm(scope: Construct, id: string, fn: lambda.IFunction, topic: sns.ITopic, what: string): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    alarmDescription: `${what}: Lambda errors`,
    metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cwActions.SnsAction(topic));
  return alarm;
}

/** Pages when a workflow execution fails (its input is in the execution history for replay). */
export function failedExecutionsAlarm(scope: Construct, id: string, machine: sfn.IStateMachine, topic: sns.ITopic, what: string): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, id, {
    alarmDescription: `${what}: workflow executions failed`,
    metric: machine.metricFailed({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cwActions.SnsAction(topic));
  return alarm;
}
