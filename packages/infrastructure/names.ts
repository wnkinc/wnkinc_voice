/**
 * The platform's names, from two words: the project and the stage. A stage is
 * a complete copy of the platform (every stack, its own tables, secrets,
 * webhooks, Temporal namespace), and the two words are its deployment's
 * (deployment.json, read by ./deployment.ts). Nothing here knows which
 * deployment it is: every name is a function of the prefix. With `wnk` and
 * `dev`:
 *
 *   stack names     wnk-dev-<layer>       what the CloudFormation console lists
 *   physical names  wnk-dev-<resource>    what the Lambda, EventBridge, SNS consoles list
 *   secrets         wnk-dev/<name>
 *   Temporal        wnk-dev-worker (the deployment), wnk-dev (the task queue):
 *                   the worker stack hands both to the worker by environment
 *                   variable (packages/worker/src/version.ts reads them).
 *
 * Resources the code leaves unnamed (the tables, the queues) get CloudFormation's
 * generated name, which starts with the stack name: wnk-dev-platform-Tenants....
 */
export interface Deployment {
  readonly project: string;
  readonly stage: string;
  readonly region: string;
}

/** Every physical name starts with this. */
export const prefixOf = (d: Pick<Deployment, 'project' | 'stage'>) => `${d.project}-${d.stage}`;

/** The stacks, bottom up: each layer takes handles only from the ones above it in this list. */
export const stacksOf = (prefix: string) => ({
  memory: `${prefix}-memory`,
  platform: `${prefix}-platform`,
  receptionist: `${prefix}-receptionist`,
  worker: `${prefix}-worker`,
  tenant: (tenantId: string) => `${prefix}-tenant-${tenantId}`,
  telegramMcp: (tenantId: string) => `${prefix}-telegram-mcp-${tenantId}`,
}) as const;

/** What Temporal knows the worker by: the Worker Deployment and the task queue it polls. */
export const workerNames = (prefix: string) => ({ deploymentName: `${prefix}-worker`, taskQueue: prefix }) as const;

/** The platform secret holding the Temporal Cloud connection and the invocation guard. */
export const temporalSecretName = (prefix: string) => `${prefix}/temporal`;
