/**
 * Upsert tenant config(s) into the Tenants table.
 *
 *   TENANTS_TABLE=<from stack output> PEOPLE_TABLE=<from stack output> npm run seed -- tenants/example.json
 *   TENANTS_TABLE=... PEOPLE_TABLE=... npm run seed -- tenants/acme.json tenants/other.json
 *
 * Also mirrors the tenant's `people` into the People table (one row per channel
 * identity) and removes rows this tenant no longer lists — that is how someone
 * gains or loses access to the assistant. No deploy.
 *
 * And mints the tenant's Gateway identity if the file lacks it: a Cognito app
 * client (client-credentials, every agent scope) and an AgentCore Identity
 * OAuth2 provider wrapping it (what the assistant harness is handed per
 * invocation), both written back into the tenant file so they are committed
 * with the rest of the tenant's data. Needs COGNITO_USER_POOL_ID and
 * COGNITO_RESOURCE_SERVER_ID (auth stack outputs). The client secret stays in
 * Cognito and the vault; agents read it through IAM.
 */
import { BedrockAgentCoreControlClient, CreateOauth2CredentialProviderCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { CognitoIdentityProviderClient, CreateUserPoolClientCommand, DescribeResourceServerCommand, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { readFileSync, writeFileSync } from 'node:fs';
import { dynamoStore } from '@wnk/shared';

async function ensureGatewayIdentity(raw: { tenantId?: string; cognitoClientId?: string }, file: string): Promise<void> {
  if (raw.cognitoClientId || !raw.tenantId) return;
  const { COGNITO_USER_POOL_ID: UserPoolId, COGNITO_RESOURCE_SERVER_ID: resourceServerId } = process.env;
  if (!UserPoolId || !resourceServerId) {
    console.warn(`${raw.tenantId}: no cognitoClientId and COGNITO_USER_POOL_ID/COGNITO_RESOURCE_SERVER_ID unset; agents cannot act for this tenant until one exists`);
    return;
  }
  const cognito = new CognitoIdentityProviderClient({});
  const rs = await cognito.send(new DescribeResourceServerCommand({ UserPoolId, Identifier: resourceServerId }));
  const scopes = (rs.ResourceServer?.Scopes ?? []).map((s) => `${resourceServerId}/${s.ScopeName}`);
  const created = await cognito.send(new CreateUserPoolClientCommand({
    UserPoolId,
    ClientName: `tenant-${raw.tenantId}`,
    GenerateSecret: true,
    AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows: ['client_credentials'],
    AllowedOAuthScopes: scopes,
  }));
  const clientId = created.UserPoolClient?.ClientId;
  if (!clientId) throw new Error(`Cognito returned no client id for tenant ${raw.tenantId}`);
  raw.cognitoClientId = clientId;
  writeBack(file, raw.tenantId, 'cognitoClientId', clientId);
  console.log(`minted Gateway identity for ${raw.tenantId}: ${clientId} (scopes: ${scopes.join(' ')})`);
}

/** The vault-side wrapper of the tenant's client, for the assistant harness. */
async function ensureGatewayOauthProvider(raw: { tenantId?: string; cognitoClientId?: string; gatewayOauthProviderArn?: string }, file: string): Promise<void> {
  if (raw.gatewayOauthProviderArn || !raw.tenantId || !raw.cognitoClientId) return;
  const { COGNITO_USER_POOL_ID: UserPoolId } = process.env;
  if (!UserPoolId) return;
  const region = process.env.AWS_REGION ?? 'us-west-2';
  const cognito = new CognitoIdentityProviderClient({});
  const { UserPoolClient } = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId, ClientId: raw.cognitoClientId }));
  if (!UserPoolClient?.ClientSecret) throw new Error(`client ${raw.cognitoClientId} has no secret`);
  const control = new BedrockAgentCoreControlClient({});
  const r = await control.send(new CreateOauth2CredentialProviderCommand({
    name: `tenant-${raw.tenantId.replace(/[^A-Za-z0-9.-]/g, '-')}-gateway`, // ARN pattern forbids underscores
    credentialProviderVendor: 'CustomOauth2',
    oauth2ProviderConfigInput: { customOauth2ProviderConfig: {
      clientId: raw.cognitoClientId,
      clientSecret: UserPoolClient.ClientSecret,
      oauthDiscovery: { discoveryUrl: `https://cognito-idp.${region}.amazonaws.com/${UserPoolId}/.well-known/openid-configuration` },
    } },
  }));
  if (!r.credentialProviderArn) throw new Error(`Identity returned no provider ARN for tenant ${raw.tenantId}`);
  raw.gatewayOauthProviderArn = r.credentialProviderArn;
  writeBack(file, raw.tenantId, 'gatewayOauthProviderArn', r.credentialProviderArn);
  console.log(`minted Gateway OAuth provider for ${raw.tenantId}: ${r.credentialProviderArn}`);
}

/** Write a minted value back next to tenantId, keeping the file's formatting. */
function writeBack(file: string, tenantId: string, key: string, value: string): void {
  const text = readFileSync(file, 'utf8');
  const marker = `"tenantId": "${tenantId}"`;
  if (text.includes(marker) && !text.includes(`"${key}"`)) {
    writeFileSync(file, text.replace(marker, `${marker},\n  "${key}": "${value}"`));
  } else {
    console.warn(`add "${key}": "${value}" to ${file} by hand`);
  }
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run seed -- <tenant.json> [...]');
  process.exit(1);
}
const store = dynamoStore();
for (const file of files) {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const raw of list) {
    await ensureGatewayIdentity(raw as { tenantId?: string; cognitoClientId?: string }, file);
    await ensureGatewayOauthProvider(raw as { tenantId?: string; cognitoClientId?: string; gatewayOauthProviderArn?: string }, file);
    const t = await store.putTenant(raw as Parameters<typeof store.putTenant>[0]);
    const people = await store.syncPeople(t);
    console.log(`seeded ${t.tenantId} (${t.phoneNumber}) from ${file}; people: ${people.map((p) => `${p.name}=${p.channelId}`).join(', ') || 'none'}`);
  }
}
