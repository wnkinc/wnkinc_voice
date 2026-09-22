import * as cdk from 'aws-cdk-lib';
import { MemoryStack } from '../stacks/memory-stack.js';
import { TelegramMcpStack } from '../stacks/telegram-mcp-stack.js';
import { TenantStack } from '../stacks/tenant-stack.js';
import { VoiceStack } from '../stacks/voice-stack.js';
import { WorkerStack } from '../stacks/worker-stack.js';
import { tenants } from '../../../tenants/index.js';

const app = new cdk.App();
const env = { region: 'us-west-2' };
const prefix = 'wnkinc-voice-dev';

const memory = new MemoryStack(app, 'wnk-memory-dev', { prefix, env });
const callerMemory = { memoryId: memory.memory.memoryId, memoryArn: memory.memory.memoryArn };

const voice = new VoiceStack(app, 'wnk-voice-dev', {
  prefix,
  env,
  callerMemory,
});
// The platform handles the worker takes. Built once, so nothing can drift from it.
const platform = {
  bus: voice.bus,
  tenantsTable: voice.tenantsTable,
  callsTable: voice.callsTable,
  usageTable: voice.usageTable,
  alarmTopic: voice.alarmTopic,
  callerMemory,
};

// The Temporal Worker: every workflow runs in it, with the platform handles
// its activities reach (tables, secrets, memory), the channels' own secrets
// and the media link resolver, and the front doors on the platform API.
const worker = new WorkerStack(app, 'wnk-worker-dev', {
  prefix, env,
  alarmTopic: voice.alarmTopic, tenantsTable: voice.tenantsTable, callsTable: voice.callsTable, usageTable: voice.usageTable, callerMemory,
  peopleTable: voice.peopleTable, actionsTable: voice.actionsTable, api: voice.api, bus: voice.bus,
  openaiSecret: voice.openaiSecret, composioSecret: voice.composioSecret,
  browserbaseProjectId: app.node.tryGetContext('browserbaseProjectId') as string,
});

// Per tenant (tenants/<id>.ts), the stacks its file asks for: its automations
// as rules filtered on its id, run on the shared worker; its Telegram
// connector, which takes no platform handles. Deploying one touches no other
// tenant and nothing above.
for (const t of tenants) {
  if (t.automations.length) new TenantStack(app, `wnk-tenant-${t.tenantId}-dev`, { ...t, prefix, env, bus: voice.bus, alarmTopic: voice.alarmTopic, automationStarter: worker.automationStart });
  if (t.telegramMcp) new TelegramMcpStack(app, `wnk-telegram-mcp-${t.tenantId}-dev`, { tenantId: t.tenantId, prefix, env });
}
