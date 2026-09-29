/**
 * The platform, as stacks, bottom up. Each layer takes handles only from the
 * ones above it here; deploying one touches nothing below it. Every name is
 * the prefix's (./names.ts), and the tenants are handed in: nothing here
 * knows which deployment it is or who its tenants are.
 *
 *   memory        AgentCore Memory: the callers' memory across calls
 *   platform      the tables, the bus, the HTTP API, the alarm topic, the platform secrets
 *   receptionist  the call path: webhook, accept, session
 *   worker        the Temporal Worker, its starters (the SMS, Telegram, and automation
 *                 front doors), the channel secrets, the fallback
 *   tenant-<id>   one per tenant file with automations: rules filtered on its id
 *   telegram-mcp-<id>  one per tenant file asking for it; takes no platform handles
 */
import type * as cdk from 'aws-cdk-lib';
import type { TenantAutomations } from '@wnk/shared/contracts';
import { stacksOf } from './names.js';
import { MemoryStack } from './stacks/memory-stack.js';
import { PlatformStack } from './stacks/platform-stack.js';
import { ReceptionistStack } from './stacks/receptionist-stack.js';
import { TelegramMcpStack } from './stacks/telegram-mcp-stack.js';
import { TenantStack } from './stacks/tenant-stack.js';
import { WorkerStack } from './stacks/worker-stack.js';

export interface PlatformProps {
  readonly prefix: string;
  readonly env: cdk.Environment;
  readonly tenants: readonly TenantAutomations[];
  /** The Browserbase project id: the deployment's setting, not a secret. */
  readonly browserbaseProjectId: string;
}

export function definePlatform(app: cdk.App, props: PlatformProps): void {
  const { prefix, env } = props;
  const stacks = stacksOf(prefix);

  const memory = new MemoryStack(app, stacks.memory, { prefix, env });
  const callerMemory = { memoryId: memory.memory.memoryId, memoryArn: memory.memory.memoryArn };

  const platform = new PlatformStack(app, stacks.platform, { prefix, env });

  new ReceptionistStack(app, stacks.receptionist, {
    prefix, env, callerMemory,
    tenantsTable: platform.tenantsTable, callsTable: platform.callsTable, bus: platform.bus, api: platform.api, alarmTopic: platform.alarmTopic,
    openaiSecret: platform.openaiSecret, composioSecret: platform.composioSecret,
  });

  const worker = new WorkerStack(app, stacks.worker, {
    prefix, env, callerMemory,
    alarmTopic: platform.alarmTopic, tenantsTable: platform.tenantsTable, callsTable: platform.callsTable, usageTable: platform.usageTable,
    peopleTable: platform.peopleTable, actionsTable: platform.actionsTable, mediaBucket: platform.mediaBucket, api: platform.api, bus: platform.bus,
    openaiSecret: platform.openaiSecret, composioSecret: platform.composioSecret,
    browserbaseProjectId: props.browserbaseProjectId,
  });

  for (const t of props.tenants) {
    if (t.automations.length) new TenantStack(app, stacks.tenant(t.tenantId), { ...t, prefix, env, bus: platform.bus, alarmTopic: platform.alarmTopic, automationStarter: worker.automationStart });
    if (t.telegramMcp) new TelegramMcpStack(app, stacks.telegramMcp(t.tenantId), { tenantId: t.tenantId, prefix, env });
  }
}
