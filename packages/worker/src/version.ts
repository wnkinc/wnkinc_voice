/**
 * The three names Temporal must see agree, in one place: the Worker announces
 * them, the registered Worker Deployment Version carries them, and a Lambda
 * version is published per build id. A mismatch is an invocation loop: Temporal
 * invokes, the Worker polls as a version nothing routes to, Temporal invokes
 * again. Bump BUILD_ID with every change to workflow code, then register the
 * new version (scripts/temporal-release.mts).
 */
export const DEPLOYMENT_NAME = 'wnkinc-voice-dev-worker';
export const BUILD_ID = 'build-8';
export const TASK_QUEUE = 'wnkinc-voice-dev';
