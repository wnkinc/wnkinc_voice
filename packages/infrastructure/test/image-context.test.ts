/**
 * The build guard and the image agree on what the image is made of: every
 * path the root .dockerignore lets into the build context is one the guard
 * asks a new build id for. A path added to one and not the other is a change
 * that deploys a new image under an old build id.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reachesTheWorker } from '../../../scripts/lib/build-guard.js';

const allowed = readFileSync(resolve(import.meta.dirname, '../../../.dockerignore'), 'utf8').split('\n').filter((l) => l.startsWith('!')).map((l) => l.slice(1).trim());

describe('image context', () => {
  it('is covered by the build guard, path by path', () => {
    expect(allowed.length).toBeGreaterThan(5);
    // A directory is covered through a file in it.
    for (const p of allowed) expect(reachesTheWorker(/\.[a-z]+$|Dockerfile$/.test(p) ? p : `${p}/x.ts`), p).toBe(true);
    expect(reachesTheWorker('.dockerignore')).toBe(true);
  });
});
