/**
 * The build-id rule, as a function: a change to what the worker runs must
 * come with a new BUILD_ID in packages/worker/src/version.ts. A published
 * Lambda version freezes its code and its environment, and Temporal routes
 * work only to a registered build, so without the bump the change is deployed
 * and never runs.
 */

/** Paths whose change reaches the worker: its source and image, the contracts it bundles, and the stack that sets its environment. Tests and docs do not. */
export function reachesTheWorker(path: string): boolean {
  if (path === 'packages/infrastructure/stacks/worker-stack.ts') return true;
  if (path === '.dockerignore') return true;
  if (path.startsWith('packages/shared/src/')) return true;
  if (!path.startsWith('packages/worker/')) return false;
  if (path.startsWith('packages/worker/test/')) return false;
  // Build output: the image builds its own from src; a stray commit of it changes nothing that runs.
  if (path.startsWith('packages/worker/lib/')) return false;
  // Git's, not the image's (.dockerignore is the image's, above).
  if (path.endsWith('.gitignore')) return false;
  return !path.endsWith('.md');
}

export const buildIdOf = (versionTs: string): string | undefined => /BUILD_ID = '([^']+)'/.exec(versionTs)?.[1];

export function buildGuard(changed: string[], versionBefore: string, versionAfter: string): { ok: boolean; message: string } {
  const touched = changed.filter(reachesTheWorker);
  const before = buildIdOf(versionBefore);
  const after = buildIdOf(versionAfter);
  if (!after) return { ok: false, message: 'packages/worker/src/version.ts has no BUILD_ID' };
  if (touched.length === 0) return { ok: true, message: `nothing the worker runs changed (build ${after})` };
  if (before !== after) return { ok: true, message: `${touched.length} worker file(s) changed, build ${before} -> ${after}` };
  return {
    ok: false,
    message: `${touched.length} file(s) the worker runs changed but BUILD_ID is still ${after}:\n  ${touched.join('\n  ')}\nBump BUILD_ID in packages/worker/src/version.ts; a published Lambda version is immutable and Temporal routes only to a registered build.`,
  };
}
