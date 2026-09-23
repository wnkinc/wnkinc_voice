/**
 * The contracts module is pure: no runtime import, so the workflow bundle and
 * a CDK stack can take it with nothing behind it. Held on the source itself,
 * since a bundler would only tell you at image build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTOMATIONS, PLATFORM_AUTOMATIONS, isAutomation } from '../src/contracts.js';

const source = readFileSync(fileURLToPath(new URL('../src/contracts.ts', import.meta.url)), 'utf8');

describe('the contracts', () => {
  it('import nothing at runtime', () => {
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]+from\s+'([^']+)';/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [line, typeOnly] of imports) expect(typeOnly, line).toBeTruthy();
    expect(source).not.toMatch(/^export \* from/m);
  });
  it('keep the platform automations out of the tenant registry, and the starter knows both', () => {
    for (const name of Object.keys(PLATFORM_AUTOMATIONS)) expect(name in AUTOMATIONS).toBe(false);
    for (const name of [...Object.keys(AUTOMATIONS), ...Object.keys(PLATFORM_AUTOMATIONS)]) expect(isAutomation(name)).toBe(true);
    expect(isAutomation('smsTurn')).toBe(false);
  });
});
