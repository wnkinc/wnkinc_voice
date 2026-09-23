/**
 * The platform, as stacks, bottom up. Each layer takes handles only from the
 * ones above it here; deploying one touches nothing below it. Names come from
 * ../names.ts: one project, one stage.
 *
 *   memory        AgentCore Memory: the callers' memory across calls
 *   platform      the tables, the bus, the HTTP API, the alarm topic, the platform secrets
 *   receptionist  the call path: webhook, accept, session
 *   worker        the Temporal Worker, its starters (the SMS, Telegram, and automation
 *                 front doors), the channel secrets, the fallback
 *   tenant-<id>   one per tenant file with automations: rules filtered on its id
 *   telegram-mcp-<id>  one per tenant file asking for it; takes no platform handles
 */
import * as cdk from 'aws-cdk-lib';
import { PREFIX, STACKS } from '../names.js';
import { MemoryStack } from '../stacks/memory-stack.js';
import { PlatformStack } from '../stacks/platform-stack.js';
import { ReceptionistStack } from '../stacks/receptionist-stack.js';
import { TelegramMcpStack } from '../stacks/telegram-mcp-stack.js';
import { TenantStack } from '../stacks/tenant-stack.js';
import { WorkerStack } from '../stacks/worker-stack.js';
import { tenants } from '../../../tenants/index.js';

const app = new cdk.App();
const env = { region: 'us-west-2' };
const prefix = PREFIX;

const memory = new MemoryStack(app, STACKS.memory, { prefix, env });
const callerMemory = { memoryId: memory.memory.memoryId, memoryArn: memory.memory.memoryArn };

const platform = new PlatformStack(app, STACKS.platform, { prefix, env });

new ReceptionistStack(app, STACKS.receptionist, {
  prefix, env, callerMemory,
  tenantsTable: platform.tenantsTable, callsTable: platform.callsTable, bus: platform.bus, api: platform.api, alarmTopic: platform.alarmTopic,
  openaiSecret: platform.openaiSecret, composioSecret: platform.composioSecret,
});

const worker = new WorkerStack(app, STACKS.worker, {
  prefix, env, callerMemory,
  alarmTopic: platform.alarmTopic, tenantsTable: platform.tenantsTable, callsTable: platform.callsTable, usageTable: platform.usageTable,
  peopleTable: platform.peopleTable, actionsTable: platform.actionsTable, api: platform.api, bus: platform.bus,
  openaiSecret: platform.openaiSecret, composioSecret: platform.composioSecret,
  browserbaseProjectId: app.node.tryGetContext('browserbaseProjectId') as string,
});

for (const t of tenants) {
  if (t.automations.length) new TenantStack(app, STACKS.tenant(t.tenantId), { ...t, prefix, env, bus: platform.bus, alarmTopic: platform.alarmTopic, automationStarter: worker.automationStart });
  if (t.telegramMcp) new TelegramMcpStack(app, STACKS.telegramMcp(t.tenantId), { tenantId: t.tenantId, prefix, env });
}
