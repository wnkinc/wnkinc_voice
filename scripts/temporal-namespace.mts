/**
 * Check the namespace has the configuration the worker's code depends on
 * (the custom search attributes it sets). CI runs it before the deploy, so
 * a build that names an attribute the namespace lacks never goes live; the
 * release runs it too. A missing one is created by a person, once
 * (ops/README.md): this prints the command.
 *
 * On a fresh stage the Temporal secret does not exist until the worker
 * stack deploys, and is empty until a person puts the connection in. Until
 * then no worker can start anything, so there is nothing to guard: the
 * check says so and passes. The release, which needs the connection, is
 * what fails on an empty secret.
 *
 *   npx tsx scripts/temporal-namespace.mts
 */
import { missingSearchAttributes } from './lib/temporal-namespace.mts';
import { TEMPORAL_SECRET, temporalEnv } from './lib/temporal-env.mts';

let env: Record<string, string>;
try {
  env = await temporalEnv();
} catch (err) {
  const e = err as { name?: string; message?: string };
  if (e.name === 'ResourceNotFoundException' || /put the namespace connection in first/.test(e.message ?? '')) {
    console.log(`no Temporal connection in ${TEMPORAL_SECRET} yet: nothing can start a workflow, nothing to check`);
    process.exit(0);
  }
  throw err;
}
const missing = missingSearchAttributes(env.TEMPORAL_NAMESPACE!, { TEMPORAL_API_KEY: env.TEMPORAL_API_KEY!, TEMPORAL_CONFIG_FILE: '/dev/null' });
if (missing.length > 0) {
  console.error(`the namespace lacks search attribute(s) the worker sets: ${missing.map((m) => m.name).join(', ')}. A person creates each once (temporal cloud login, or the namespace's Search Attributes in the Cloud UI):\n  ${missing.map((m) => m.command).join('\n  ')}`);
  process.exit(1);
}
console.log('search attributes: present');
