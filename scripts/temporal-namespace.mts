/**
 * Check the namespace has the configuration the worker's code depends on
 * (the custom search attributes it sets). CI runs it before the deploy, so
 * a build that names an attribute the namespace lacks never goes live; the
 * release runs it too. A missing one is created by a person, once
 * (ops/README.md): this prints the command.
 *
 *   npx tsx scripts/temporal-namespace.mts
 */
import { missingSearchAttributes } from './lib/temporal-namespace.mts';
import { temporalEnv } from './lib/temporal-env.mts';

const env = await temporalEnv();
const missing = missingSearchAttributes(env.TEMPORAL_NAMESPACE!, { TEMPORAL_API_KEY: env.TEMPORAL_API_KEY!, TEMPORAL_CONFIG_FILE: '/dev/null' });
if (missing.length > 0) {
  console.error(`the namespace lacks search attribute(s) the worker sets: ${missing.map((m) => m.name).join(', ')}. A person creates each once (temporal cloud login, or the namespace's Search Attributes in the Cloud UI):\n  ${missing.map((m) => m.command).join('\n  ')}`);
  process.exit(1);
}
console.log('search attributes: present');
