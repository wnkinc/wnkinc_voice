/**
 * Activities: the side effects. Everything that touches a table, a secret, a
 * SaaS, or a model lives here; workflow code stays deterministic and only
 * decides. Each activity that acts for a tenant takes the tenant id as an
 * argument; none reads it from anywhere else.
 */

/** Proves the pipe end to end without touching anything. */
export async function echo(name: string): Promise<string> {
  return `pong: ${name}`;
}
