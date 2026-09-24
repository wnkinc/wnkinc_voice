/** The build-id rule CI enforces: what the worker runs cannot change without a new build. */
import { describe, expect, it } from 'vitest';
import { buildGuard, reachesTheWorker } from '../../../scripts/lib/build-guard.js';

const v = (id: string) => `export const BUILD_ID = '${id}';`;

describe('build guard', () => {
  it('knows what reaches the worker: its source, its image, the contracts it bundles, the stack that sets its environment; not tests or docs', () => {
    for (const p of ['packages/worker/src/workflows/assistant/loop.ts', 'packages/worker/Dockerfile', 'packages/worker/package.json', 'packages/infrastructure/stacks/worker-stack.ts', 'packages/shared/src/contracts.ts', '.dockerignore']) expect(reachesTheWorker(p)).toBe(true);
    for (const p of ['packages/worker/test/sms-turn.test.ts', 'packages/worker/lib/workflow-bundle.js', 'packages/worker/.gitignore', 'packages/worker/README.md', 'packages/infrastructure/stacks/platform-stack.ts', 'README.md', 'scripts/temporal-release.mts', 'packages/shared/test/contracts.test.ts']) expect(reachesTheWorker(p)).toBe(false);
  });
  it('passes a change that bumps, or one that touches nothing the worker runs', () => {
    expect(buildGuard(['packages/worker/src/activities/twilio.ts'], v('build-8'), v('build-9')).ok).toBe(true);
    expect(buildGuard(['README.md', 'packages/worker/test/fakes.ts'], v('build-8'), v('build-8')).ok).toBe(true);
  });
  it('fails a worker change without a bump, naming the files', () => {
    const r = buildGuard(['packages/worker/src/activities/twilio.ts', 'README.md'], v('build-8'), v('build-8'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('packages/worker/src/activities/twilio.ts');
    expect(r.message).not.toContain('README.md');
  });
  it('fails when the version file lost its build id', () => {
    expect(buildGuard(['packages/worker/src/version.ts'], v('build-8'), '// nothing').ok).toBe(false);
  });
});
