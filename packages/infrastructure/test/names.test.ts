/** Every name is the prefix's: a second stage shares none with the first. */
import { describe, expect, it } from 'vitest';
import { prefixOf, stacksOf, temporalSecretName, workerNames } from '../names.js';

const PREFIX = prefixOf({ project: 'p', stage: 'test' });
const STACKS = stacksOf(PREFIX);

describe('names', () => {
  it('the Temporal deployment and task queue carry the prefix', () => {
    expect(PREFIX).toBe('p-test');
    expect(workerNames(PREFIX)).toEqual({ deploymentName: 'p-test-worker', taskQueue: 'p-test' });
    expect(temporalSecretName(PREFIX)).toBe('p-test/temporal');
  });
  it('every stack name carries the prefix and its layer', () => {
    for (const [layer, name] of Object.entries(STACKS)) {
      const n = typeof name === 'function' ? name('x') : name;
      expect(n.startsWith(`${PREFIX}-`)).toBe(true);
      expect(n).toContain(layer === 'telegramMcp' ? 'telegram-mcp' : layer);
    }
  });
});
