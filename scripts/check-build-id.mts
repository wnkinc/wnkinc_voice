/**
 * CI: fail a change that reaches the worker without a new BUILD_ID.
 *
 *   npx tsx scripts/check-build-id.mts <base sha> <head sha>
 *
 * Compares the files changed between the two commits (a PR's base and head,
 * or the previous and new tip of main) against the rule in lib/build-guard.mts.
 */
import { execFileSync } from 'node:child_process';
import { buildGuard } from './lib/build-guard.js';

const [base, head] = process.argv.slice(2);
if (!base || !head || /^0+$/.test(base)) { console.log('no base commit to compare against; skipping'); process.exit(0); }
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
const changed = git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean);
const versionAt = (sha: string) => { try { return git('show', `${sha}:packages/worker/src/version.ts`); } catch { return ''; } };
const verdict = buildGuard(changed, versionAt(base), versionAt(head));
console.log(verdict.message);
process.exit(verdict.ok ? 0 : 1);
