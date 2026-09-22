import * as cdk from 'aws-cdk-lib';
import { MemoryStack } from '../stacks/memory-stack.js';
import { RuntimeStack } from '../stacks/runtime-stack.js';
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
// The platform handles every bus-driven stack takes: the runtime stack and
// each tenant stack. Built once so the two cannot drift.
const platform = {
  bus: voice.bus,
  tenantsTable: voice.tenantsTable,
  callsTable: voice.callsTable,
  usageTable: voice.usageTable,
  composioConnection: voice.composioConnection,
  alarmTopic: voice.alarmTopic,
  callerMemory,
};

const runtime = new RuntimeStack(app, 'wnk-runtime-dev', { prefix, env, ...platform });

// The Temporal Worker: every workflow that moves here runs in it, with the
// platform handles its activities reach (tables, secrets, memory, the media
// link resolver) and the SMS front door on the platform API.
new WorkerStack(app, 'wnk-worker-dev', {
  prefix, env,
  alarmTopic: voice.alarmTopic, tenantsTable: voice.tenantsTable, usageTable: voice.usageTable, callerMemory,
  peopleTable: voice.peopleTable, actionsTable: voice.actionsTable, api: voice.api,
  openaiSecret: voice.openaiSecret, composioSecret: voice.composioSecret,
  twilioSecret: runtime.twilioSecret, mediaLinkFunction: runtime.mediaLinkFn,
  telegramSecret: runtime.telegramSecret, browserbaseSecret: runtime.browserbaseSecret,
  browserbaseProjectId: app.node.tryGetContext('browserbaseProjectId') as string,
});

// Per tenant (tenants/<id>.ts), the stacks its file asks for: its automations,
// rules filtered on its id; its Telegram connector, which takes no platform
// handles. Deploying one touches no other tenant and nothing above.
for (const t of tenants) {
  if (t.automations.length) new TenantStack(app, `wnk-tenant-${t.tenantId}-dev`, { ...t, prefix, env, ...platform });
  if (t.telegramMcp) new TelegramMcpStack(app, `wnk-telegram-mcp-${t.tenantId}-dev`, { tenantId: t.tenantId, prefix, env });
}
