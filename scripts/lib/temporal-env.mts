/** The platform namespace connection, from the worker stack's secret, as the environment the Temporal CLI and SDK read. */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PREFIX, temporalSecretName } from '../../packages/infrastructure/names.js';

export const REGION = 'us-west-2';
export const TEMPORAL_SECRET = temporalSecretName(PREFIX);

export async function temporalSecret(): Promise<Record<string, string>> {
  const r = await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: TEMPORAL_SECRET }));
  const s = JSON.parse(r.SecretString ?? '{}') as Record<string, string>;
  for (const key of ['TEMPORAL_ADDRESS', 'TEMPORAL_NAMESPACE', 'TEMPORAL_API_KEY', 'EXTERNAL_ID']) {
    if (!s[key]) throw new Error(`${key} is empty in ${TEMPORAL_SECRET}: put the namespace connection in first`);
  }
  return s;
}

export async function temporalEnv(): Promise<Record<string, string>> {
  const s = await temporalSecret();
  return { TEMPORAL_ADDRESS: s.TEMPORAL_ADDRESS!, TEMPORAL_NAMESPACE: s.TEMPORAL_NAMESPACE!, TEMPORAL_API_KEY: s.TEMPORAL_API_KEY! };
}
