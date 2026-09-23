/**
 * The Temporal Cloud connection, from the secret the stack points at: read
 * once per container under the execution role, checked whole. Nothing
 * Temporal-specific is in the environment, and the API key is never a
 * plaintext variable on a function.
 */
import { env, secret } from '../activities/config.js';

export interface TemporalConnection { address: string; namespace: string; apiKey: string }

export async function temporalConnection(): Promise<TemporalConnection> {
  const s = await secret(env('TEMPORAL_SECRET_ARN'));
  for (const key of ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_API_KEY']) if (!s[key]) throw new Error(`${key} is empty in the Temporal secret`);
  return { address: s.TEMPORAL_ADDRESS!, namespace: s.TEMPORAL_NAMESPACE!, apiKey: s.TEMPORAL_API_KEY! };
}
