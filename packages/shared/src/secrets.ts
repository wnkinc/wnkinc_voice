/** A JSON secret by ARN, read once per process and cached; a failed read is retried on the next call, not cached. Missing config fails closed at the caller. */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secrets = new Map<string, Promise<Record<string, string>>>();

export function jsonSecret(arn: string): Promise<Record<string, string>> {
  let p = secrets.get(arn);
  if (!p) {
    p = new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn })).then((r) => JSON.parse(r.SecretString ?? '{}') as Record<string, string>);
    p.catch(() => secrets.delete(arn));
    secrets.set(arn, p);
  }
  return p;
}

/** One key of a JSON secret, or a clear failure naming what is missing. */
export async function secretValue(arn: string, key: string): Promise<string> {
  const v = (await jsonSecret(arn))[key];
  if (!v) throw new Error(`${key} is not filled in (secret ${arn.split(':').pop()})`);
  return v;
}
