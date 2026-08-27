import { describe, expect, it } from 'vitest';
import { computeCosts, type UsageRecord } from '../src/usage.js';

const rec = (meter: UsageRecord['meter'], units: number): UsageRecord => ({
  tenantId: 'wnk',
  sk: `2026-08-27T00:00:00.000Z#${meter}#x`,
  meter,
  units,
});

const rates = {
  meters: {
    voice_minutes: { rate: 0.1, note: 'v' },
    llm_tokens: { rate: 0.000002, note: 't' },
    emails_sent: { rate: 0, note: 'e' },
    browser_tasks: { rate: 0.02, note: 'b' },
  },
  monthlyOverhead: 2,
} as const;

describe('computeCosts', () => {
  it('aggregates units per meter and prices them, costliest first', () => {
    const c = computeCosts('2026-08', [rec('voice_minutes', 3.5), rec('voice_minutes', 1.5), rec('llm_tokens', 50_000), rec('emails_sent', 1)], rates);
    expect(c.lines[0]).toMatchObject({ meter: 'voice_minutes', units: 5, cost: 0.5 });
    expect(c.lines[1]).toMatchObject({ meter: 'llm_tokens', units: 50_000, cost: 0.1 });
    expect(c.overhead).toBe(2);
    expect(c.total).toBe(2.6);
  });
  it('is zero-cost and zero-overhead with no usage', () => {
    const c = computeCosts('2026-08', [], rates);
    expect(c.lines).toEqual([]);
    expect(c.total).toBe(0);
  });
});
