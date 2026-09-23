import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { AUTOMATIONS, type TenantAutomations } from '@wnk/shared/contracts';
import { dlqAlarm } from '../infra_utils/alarms.js';
import { EVENT_SOURCE } from './platform-stack.js';

export interface TenantStackProps extends cdk.StackProps, TenantAutomations {
  readonly prefix: string;
  readonly bus: events.IEventBus;
  readonly alarmTopic: sns.ITopic;
  /** The worker stack's automation starter: opens the named workflow with the event. */
  readonly automationStarter: lambda.IFunction;
}

/**
 * One tenant's automations: for each entry, a rule that matches only events
 * carrying this tenant's id (published by our own session Lambda, so the id
 * is trustworthy) and hands the worker's starter the workflow name, the
 * event, and this tenant's options. The workflow runs on the shared worker,
 * for the tenant the event names. Deploying this stack touches nothing
 * another tenant runs on: rules are data, and a rule names one tenant.
 */
export class TenantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TenantStackProps) {
    super(scope, id, props);
    const { tenantId } = props;
    const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    // A start the rule could not deliver (after retries) parks here and alarms.
    const startDlq = new sqs.Queue(this, 'StartDlq', { retentionPeriod: cdk.Duration.days(14) });

    for (const a of props.automations) {
      const on = AUTOMATIONS[a.workflow].on;
      new events.Rule(this, `${pascal(a.workflow)}Rule`, {
        eventBus: props.bus,
        description: `${tenantId}: ${on} -> ${a.workflow}`,
        eventPattern: { source: [EVENT_SOURCE], detailType: [on], detail: { tenantId: [tenantId] } },
        targets: [new targets.LambdaFunction(props.automationStarter, {
          event: events.RuleTargetInput.fromObject({ workflow: a.workflow, options: a.options ?? {}, detail: events.EventField.fromPath('$.detail'), id: events.EventField.eventId }),
          retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq,
        })],
      });
    }
    dlqAlarm(this, 'StartDlqAlarm', startDlq, props.alarmTopic, `${tenantId}: an event could not start its automation`);
  }
}
