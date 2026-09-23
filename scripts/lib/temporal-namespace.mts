/**
 * The namespace configuration the platform's code depends on: the custom
 * search attributes the worker sets (packages/worker/src/search-attributes.ts).
 * Namespace configuration lives on Temporal Cloud's control plane
 * (`temporal cloud ...`), not the namespace's own frontend. The worker's key
 * (a namespace service account) may list it but not change it: a person
 * creates a missing attribute once, with their own Cloud login or in the UI
 * (ops/README.md). This checks, and names what is missing and the command.
 * Deleting one is not supported on Cloud, so a name here is for good.
 */
import { execFileSync } from 'node:child_process';
import { SEARCH_ATTRIBUTES } from '../../packages/worker/src/search-attributes.js';

/** The CLI's spelling of the SDK's type name: KEYWORD -> Keyword, KEYWORD_LIST -> KeywordList. */
export const cliType = (t: string) => t.toLowerCase().split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');

/** The search attributes the worker sets that the namespace lacks, with the command that creates each. */
export function missingSearchAttributes(namespace: string, env: NodeJS.ProcessEnv): { name: string; command: string }[] {
  const out = execFileSync('temporal', ['cloud', 'namespace', 'search-attribute', 'list', '--namespace', namespace, '-o', 'json'], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const listed = JSON.parse(out) as { SearchAttributes?: { Name: string }[] | null };
  const have = new Set((listed.SearchAttributes ?? []).map((a) => a.Name));
  return SEARCH_ATTRIBUTES.filter((k) => !have.has(k.name)).map((k) => ({
    name: k.name,
    command: `temporal cloud namespace search-attribute create --name ${k.name} --type ${cliType(k.type)} --namespace ${namespace}`,
  }));
}
