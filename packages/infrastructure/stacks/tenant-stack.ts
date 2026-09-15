import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import { dlqAlarm, failedExecutionsAlarm } from '../infra_utils/alarms.js';
import { expressNoData, grantHttp } from '../infra_utils/state-machine.js';
import { COMPOSIO_API } from '../workflows/asl.js';
import type { Automation, AutomationRefs } from '../workflows/automation.js';
import { MEMORY_USE_ACTIONS } from './memory-stack.js';

/** What a tenant file exports: the id and the automations that tenant gets. */
export interface TenantAutomations {
  readonly tenantId: string;
  readonly automations: readonly Automation[];
}

export interface TenantStackProps extends cdk.StackProps, TenantAutomations {
  readonly prefix: string;
  readonly bus: events.IEventBus;
  readonly tenantsTable: dynamodb.ITable;
  readonly callsTable: dynamodb.ITable;
  readonly usageTable: dynamodb.ITable;
  readonly composioConnection: events.IConnection;
  readonly alarmTopic: sns.ITopic;
  readonly callerMemory?: { readonly memoryId: string; readonly memoryArn: string };
}

/**
 * One tenant's automations: for each descriptor, a state machine named for
 * the tenant, a rule that starts it only for events carrying this tenant's
 * id (published by our own session Lambda, so the id is trustworthy), the
 * grants the descriptor declares, and a failed-executions alarm. Deploying
 * this stack touches nothing another tenant runs on. No code.
 */
export class TenantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TenantStackProps) {
    super(scope, id, props);
    const { prefix, tenantId } = props;
    const refs: AutomationRefs = {
      tenantsTable: props.tenantsTable.tableName,
      callsTable: props.callsTable.tableName,
      usageTable: props.usageTable.tableName,
      composioConnectionArn: props.composioConnection.connectionArn,
      busName: props.bus.eventBusName,
      memoryId: props.callerMemory?.memoryId,
    };
    const pascal = (s: string) => s.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
    const camel = (s: string) => { const p = pascal(s); return p.charAt(0).toLowerCase() + p.slice(1); };

    // A start the rule could not deliver (after retries) parks here and alarms.
    const startDlq = new sqs.Queue(this, 'StartDlq', { retentionPeriod: cdk.Duration.days(14) });

    for (const a of props.automations) {
      const cid = pascal(a.name);
      const wf = new sfn.StateMachine(this, `${cid}Workflow`, {
        stateMachineName: `${prefix}-${tenantId}-${a.name}`,
        tracingEnabled: true, // X-Ray: the workflow joins the trace the event carried
        definitionBody: sfn.DefinitionBody.fromString(JSON.stringify(a.definition(refs))),
        timeout: cdk.Duration.minutes(a.timeoutMinutes),
        ...(a.express ? expressNoData(this, `${cid}WorkflowLogs`) : {}),
      });
      if (a.needs.tenants) props.tenantsTable.grantReadData(wf);
      if (a.needs.calls) props.callsTable.grantReadWriteData(wf);
      if (a.needs.usage) props.usageTable.grantWriteData(wf);
      if (a.needs.composio) grantHttp(wf, [props.composioConnection], [`${COMPOSIO_API}*`]);
      if (a.needs.bus) props.bus.grantPutEventsTo(wf);
      if (a.needs.memory && props.callerMemory) {
        wf.addToRolePolicy(new iam.PolicyStatement({
          actions: MEMORY_USE_ACTIONS,
          resources: [props.callerMemory.memoryArn, `${props.callerMemory.memoryArn}/*`],
        }));
      }
      new events.Rule(this, `${cid}Rule`, {
        eventBus: props.bus,
        description: `${tenantId}: ${a.on} -> ${a.name}`,
        eventPattern: { source: ['wnkinc.voice'], detailType: [a.on], detail: { tenantId: [tenantId] } },
        targets: [new targets.SfnStateMachine(wf, { retryAttempts: 2, maxEventAge: cdk.Duration.hours(1), deadLetterQueue: startDlq })],
      });
      failedExecutionsAlarm(this, `${cid}WorkflowFailed`, wf, props.alarmTopic, `${tenantId} ${a.name}`);
      new cdk.CfnOutput(this, `${camel(a.name)}WorkflowArn`, { value: wf.stateMachineArn });
    }
    dlqAlarm(this, 'StartDlqAlarm', startDlq, props.alarmTopic, `${tenantId}: an event could not start its automation`);
  }
}
