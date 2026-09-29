/**
 * Core names no tenant. A workflow, an activity, a handler or a stack that
 * compares a tenant id to a literal is a behavior one tenant gets inside code
 * another runs on: the variation belongs in an option or a workflow of its
 * own. A deployment checks the other half, that none of its tenant ids is a
 * literal here (deployments/<name>/test).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const CORE = ['packages/shared/src', 'packages/receptionist/src', 'packages/worker/src', 'packages/infrastructure/stacks', 'packages/infrastructure/infra_utils', 'packages/infrastructure/platform.ts', 'packages/infrastructure/names.ts', 'packages/telegram-mcp', 'scripts'];
const files = (path: string): string[] => statSync(path).isDirectory()
  ? readdirSync(path).filter((n) => n !== 'node_modules').flatMap((n) => files(join(path, n)))
  : /\.(ts|mts|py)$/.test(path) ? [path] : [];
const lines = CORE.flatMap((p) => files(join(ROOT, p))).flatMap((file) => readFileSync(file, 'utf8').split('\n').map((text, i) => ({ at: `${file.slice(ROOT.length + 1)}:${i + 1}`, text })));
const found = (pattern: RegExp) => lines.filter((l) => pattern.test(l.text)).map((l) => l.at);

describe('core names no tenant', () => {
  it('reads core', () => expect(lines.length).toBeGreaterThan(1000));

  it('never compares a tenant id to a literal', () => {
    const quote = '[\'"`]';
    expect(found(new RegExp(`tenant_?id\\s*(===?|!==?)\\s*${quote}`, 'i'))).toEqual([]);
    expect(found(new RegExp(`${quote}\\s*(===?|!==?)\\s*[\\w.]*tenant_?id\\b`, 'i'))).toEqual([]);
    expect(found(/switch\s*\(\s*[\w.]*tenant_?id\s*\)/i)).toEqual([]);
  });
});
