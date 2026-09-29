/**
 * The three names Temporal must see agree: the Worker announces them, the
 * registered Worker Deployment Version carries them, and a Lambda version is
 * published per build id. A mismatch is an invocation loop: Temporal invokes,
 * the Worker polls as a version nothing routes to, Temporal invokes again.
 * Bump BUILD_ID with every change to workflow code, then register the new
 * version (scripts/temporal-release.mts).
 *
 * The build id is the code's. The deployment and the task queue are the
 * stage's: the worker stack sets them from its prefix
 * (packages/infrastructure/names.ts), and a missing one fails closed.
 */
export const BUILD_ID = 'build-20';

const fromStack = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
export const deploymentName = () => fromStack('WORKER_DEPLOYMENT_NAME');
export const taskQueue = () => fromStack('WORKER_TASK_QUEUE');
