import { describe, expect, it } from 'vitest';
import { splitTelegramText } from '../src/telegram.js';

describe('splitTelegramText', () => {
  it('returns short text as one message', () => {
    expect(splitTelegramText('hello')).toEqual(['hello']);
  });
  it('splits long text at paragraph boundaries under the limit', () => {
    const para = 'x'.repeat(30);
    const text = Array.from({ length: 10 }, () => para).join('\n\n');
    const parts = splitTelegramText(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
    expect(parts.join('\n\n')).toBe(text);
  });
  it('hard-splits a single unbroken run', () => {
    const parts = splitTelegramText('y'.repeat(250), 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
  });
});
