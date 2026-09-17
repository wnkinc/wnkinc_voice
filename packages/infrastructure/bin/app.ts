import * as cdk from 'aws-cdk-lib';
import { MemoryStack } from '../stacks/memory-stack.js';
import { RuntimeStack } from '../stacks/runtime-stack.js';
import { TelegramMcpStack } from '../stacks/telegram-mcp-stack.js';
import { TenantStack } from '../stacks/tenant-stack.js';
import { VoiceStack } from '../stacks/voice-stack.js';
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

new RuntimeStack(app, 'wnk-runtime-dev', {
  prefix,
  env,
  ...platform,
  openaiConnection: voice.openaiConnection,
  peopleTable: voice.peopleTable,
  api: voice.api,
});

// Per tenant (tenants/<id>.ts), the stacks its file asks for: its automations,
// rules filtered on its id; its Telegram connector, which takes no platform
// handles. Deploying one touches no other tenant and nothing above.
for (const t of tenants) {
  if (t.automations.length) new TenantStack(app, `wnk-tenant-${t.tenantId}-dev`, { ...t, prefix, env, ...platform });
  if (t.telegramMcp) new TelegramMcpStack(app, `wnk-telegram-mcp-${t.tenantId}-dev`, { tenantId: t.tenantId, prefix, env });
}
