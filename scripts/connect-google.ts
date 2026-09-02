/**
 * 3LO consent flow: connect a tenant owner's Google account to the AgentCore
 * Identity token vault, delegated to the email-responder workload identity.
 * The vault user id is derived from the tenant id (ownerUserId), which is how
 * the email agent finds the token later.
 *
 *   npx tsx scripts/connect-google.ts [tenantId]      (default: wnk)
 *
 * Prints the Google consent URL, then polls until the vault has the token.
 * After consent, proves it by reading the Gmail profile with the vault token.
 */
import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { execFileSync } from 'node:child_process';
import { GOOGLE_GMAIL_SCOPES, GOOGLE_OAUTH_PARAMS, ownerUserId } from '@wnk/shared';

const REGION = 'us-west-2';
const WORKLOAD_NAME = 'wnkinc-voice-dev-email-responder';
const PROVIDER_NAME = 'wnkinc_voice_dev_google';
const SCOPES = GOOGLE_GMAIL_SCOPES;

const tenantId = process.argv[2] ?? 'wnk';
const userId = ownerUserId(tenantId);
const client = new BedrockAgentCoreClient({ region: REGION });

const { workloadAccessToken } = await client.send(
  new GetWorkloadAccessTokenForUserIdCommand({ workloadName: WORKLOAD_NAME, userId }),
);
if (!workloadAccessToken) throw new Error('no workload access token');
console.log(`workload access token for user "${userId}" (${WORKLOAD_NAME})`);

const returnUrl = execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', 'wnk-identity-dev', '--query', "Stacks[0].Outputs[?OutputKey=='oauthReturnUrl'].OutputValue | [0]", '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();

const tokenArgs = {
  workloadIdentityToken: workloadAccessToken,
  resourceCredentialProviderName: PROVIDER_NAME,
  scopes: SCOPES,
  oauth2Flow: 'USER_FEDERATION' as const,
  resourceOauth2ReturnUrl: returnUrl,
  // DEV: the callback Lambda reads the user id from `state`. Real onboarding
  // must derive it from its own logged-in session instead.
  customState: userId,
  // Shared constants: params are part of the vault's token cache key AND what
  // makes Google issue a refresh token. See @wnk/shared google-oauth.ts.
  customParameters: GOOGLE_OAUTH_PARAMS,
};

let res = await client.send(new GetResourceOauth2TokenCommand(tokenArgs));
if (!res.accessToken && res.authorizationUrl) {
  console.log('\n=== OPEN THIS URL AND CONSENT ===');
  console.log(res.authorizationUrl);
  console.log('=================================\n');
  const deadline = Date.now() + 5 * 60_000;
  while (!res.accessToken && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    res = await client.send(new GetResourceOauth2TokenCommand({ ...tokenArgs, sessionUri: res.sessionUri }));
    if (res.sessionStatus) process.stdout.write(`status: ${res.sessionStatus}\n`);
  }
}
if (!res.accessToken) throw new Error('timed out waiting for consent');
console.log('vault has a Google access token for this user+workload.');

const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
  headers: { authorization: `Bearer ${res.accessToken}` },
});
console.log('gmail profile:', profile.status, JSON.stringify(await profile.json()));
