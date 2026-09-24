/**
 * The three names Temporal must see agree, in one place: the Worker announces
 * them, the registered Worker Deployment Version carries them, and a Lambda
 * version is published per build id. A mismatch is an invocation loop: Temporal
 * invokes, the Worker polls as a version nothing routes to, Temporal invokes
 * again. Bump BUILD_ID with every change to workflow code, then register the
 * new version (scripts/temporal-release.mts).
 *
 * The deployment and the task queue follow the platform's prefix
 * (packages/infrastructure/names.ts, which this package cannot import); a
 * test on the infrastructure holds them in step.
 */
export const DEPLOYMENT_NAME = 'wnk-dev-worker';
export const BUILD_ID = 'build-18';
export const TASK_QUEUE = 'wnk-dev';
