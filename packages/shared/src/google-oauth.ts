/**
 * Google 3LO constants shared by every caller of the Identity vault.
 *
 * HARD-WON: the vault keys stored tokens by scopes AND customParameters —
 * a retrieval with different params is treated as a NEW authorization (it
 * returns an authorizationUrl instead of the cached token). Every consumer
 * (consent flow, agents, pre-flight checker) must use these exact values.
 * access_type=offline + prompt=consent are also what make Google issue a
 * refresh token, so the vault can renew itself past the first hour.
 */
export const GOOGLE_GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export const GOOGLE_OAUTH_PARAMS = { access_type: 'offline', prompt: 'consent' };

/**
 * The vault user id a tenant's owner consents under. Derived from the tenant
 * id so the vault is addressed by tenant by construction — the consent flow,
 * the email agent, and the pre-flight check all go through this one function.
 */
export function ownerUserId(tenantId: string): string {
  return `${tenantId}_owner`;
}
