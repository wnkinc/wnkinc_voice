/** What the stack hands the worker: resource names by environment variable, secrets by ARN (read once per container, @wnk/shared). Missing config fails closed. */
export { jsonSecret as secret } from '@wnk/shared/secrets';

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const now = () => new Date().toISOString();
export const epoch = () => Math.floor(Date.now() / 1000);
