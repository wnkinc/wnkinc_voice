/**
 * The platform's names, from two words. `wnk` is the project, `dev` the
 * stage: a stage is a complete copy of the platform (every stack, its own
 * tables, secrets, webhooks, Temporal namespace), and a second stage is a
 * second value here. A client is never a stage: a client is a tenant, a row
 * and a small stack inside one.
 *
 *   stack names     wnk-dev-<layer>       what the CloudFormation console lists
 *   physical names  wnk-dev-<resource>    what the Lambda, EventBridge, SNS consoles list
 *   secrets         wnk-dev/<name>
 *   Temporal        wnk-dev-worker (the deployment), wnk-dev (the task queue):
 *                   packages/worker/src/version.ts, which cannot import this
 *                   file, spells them out; a test holds them in step.
 *
 * Resources the code leaves unnamed (the tables, the queues) get CloudFormation's
 * generated name, which starts with the stack name: wnk-dev-platform-Tenants....
 */
export const PROJECT = 'wnk';
export const STAGE = 'dev';
/** Every physical name starts with this. */
export const PREFIX = `${PROJECT}-${STAGE}`;

/** The stacks, bottom up: each layer takes handles only from the ones above it in this list. */
export const STACKS = {
  memory: `${PREFIX}-memory`,
  platform: `${PREFIX}-platform`,
  receptionist: `${PREFIX}-receptionist`,
  worker: `${PREFIX}-worker`,
  tenant: (tenantId: string) => `${PREFIX}-tenant-${tenantId}`,
  telegramMcp: (tenantId: string) => `${PREFIX}-telegram-mcp-${tenantId}`,
} as const;

/** The platform secret holding the Temporal Cloud connection and the invocation guard. */
export const temporalSecretName = (prefix: string) => `${prefix}/temporal`;
