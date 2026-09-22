/** What the stack hands the worker: resource names by environment variable, secrets by ARN, read once per container. Missing config fails closed. */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const secrets = new Map<string, Promise<Record<string, string>>>();
/** A JSON secret by ARN, cached for the container's life. */
export function secret(arn: string): Promise<Record<string, string>> {
  let p = secrets.get(arn);
  if (!p) {
    p = new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn })).then((r) => JSON.parse(r.SecretString ?? '{}') as Record<string, string>);
    p.catch(() => secrets.delete(arn));
    secrets.set(arn, p);
  }
  return p;
}

export const now = () => new Date().toISOString();
export const epoch = () => Math.floor(Date.now() / 1000);
