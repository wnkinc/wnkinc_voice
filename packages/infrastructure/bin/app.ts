import * as cdk from 'aws-cdk-lib';
import { IdentityStack } from '../stacks/identity-stack.js';
import { MemoryStack } from '../stacks/memory-stack.js';
import { RuntimeStack } from '../stacks/runtime-stack.js';
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
// AgentCore Identity providers. Nothing reads them since the assistant moved
// into the workflows (the keys ride in EventBridge Connections); the stack
// stays until it is retired on purpose (`cdk destroy wnk-identity-dev`).
new IdentityStack(app, 'wnk-identity-dev', {
  prefix,
  env,
  openaiSecret: voice.openaiSecret,
  composioSecret: voice.composioSecret,
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

// One stack per tenant (tenants/<id>.ts): its automations, its rules filtered
// on its id. Deploying one touches no other tenant and nothing above.
for (const t of tenants) new TenantStack(app, `wnk-tenant-${t.tenantId}-dev`, { ...t, prefix, env, ...platform });
