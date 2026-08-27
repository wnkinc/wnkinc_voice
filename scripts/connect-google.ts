/**
 * 3LO consent flow: connect a user's Google account to the AgentCore Identity
 * token vault, delegated to the email-responder workload identity.
 *
 *   npx tsx scripts/connect-google.ts [userId]
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

const REGION = 'us-west-2';
const WORKLOAD_NAME = 'wnkinc-voice-dev-email-responder';
const PROVIDER_NAME = 'wnkinc_voice_dev_google';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

const userId = process.argv[2] ?? 'wesley';
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
  // Google only issues a REFRESH token with offline access + forced consent;
  // without it the vault dies when the 1-hour access token expires.
  customParameters: { access_type: 'offline', prompt: 'consent' },
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
