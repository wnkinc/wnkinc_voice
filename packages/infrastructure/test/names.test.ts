/** The names the worker spells out (it cannot import names.ts) follow the platform's prefix. */
import { describe, expect, it } from 'vitest';
import { PREFIX, STACKS } from '../names.js';
import { DEPLOYMENT_NAME, TASK_QUEUE } from '../../worker/src/version.js';

describe('names', () => {
  it('the Temporal deployment and task queue carry the prefix', () => {
    expect(DEPLOYMENT_NAME).toBe(`${PREFIX}-worker`);
    expect(TASK_QUEUE).toBe(PREFIX);
  });
  it('every stack name carries the prefix and its layer', () => {
    for (const [layer, name] of Object.entries(STACKS)) {
      const n = typeof name === 'function' ? name('x') : name;
      expect(n.startsWith(`${PREFIX}-`)).toBe(true);
      expect(n).toContain(layer === 'telegramMcp' ? 'telegram-mcp' : layer);
    }
  });
});
