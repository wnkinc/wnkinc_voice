/**
 * Harness probes (throwaway resources; `down` deletes everything):
 *
 *   npx tsx scripts/probe-harness.mts up       # OpenAI key provider, wnk OAuth provider, role, harness (waits READY)
 *   npx tsx scripts/probe-harness.mts invoke   # probe 1: harness -> Gateway as wnk (identity chain)
 *   npx tsx scripts/probe-harness.mts sfn      # probe 2: Step Functions InvokeHarness round trip
 *   npx tsx scripts/probe-harness.mts down     # delete all of the above
 *
 * State (ARNs) is kept in .probe-harness.json next to this file (gitignored by name here).
 */
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient, CreateApiKeyCredentialProviderCommand, CreateHarnessCommand, CreateOauth2CredentialProviderCommand,
  DeleteApiKeyCredentialProviderCommand, DeleteHarnessCommand, DeleteOauth2CredentialProviderCommand, GetHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const REGION = 'us-west-2';
const ACCOUNT = '123456789012';
const NAME = 'wnk_probe_harness';
const PNAME = 'wnk-probe-harness'; // credential provider names: no underscores allowed in their ARNs
const STATE = new URL('./.probe-harness.json', import.meta.url).pathname;
const out = (stack: string, key: string) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, '--output', 'text', '--region', REGION], { encoding: 'utf8' }).trim();
const control = new BedrockAgentCoreControlClient({ region: REGION });
const data = new BedrockAgentCoreClient({ region: REGION });
// IAM and Step Functions through the CLI (no extra SDK packages for a throwaway probe).
const aws = (args: string[]): string => execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8' });
const awsJson = <T>(args: string[]): T => JSON.parse(aws(args) || '{}') as T;
const createRole = (name: string, service: string, policy: object): string => {
  const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }] };
  const r = awsJson<{ Role: { Arn: string } }>(['iam', 'create-role', '--role-name', name, '--assume-role-policy-document', JSON.stringify(trust)]);
  aws(['iam', 'put-role-policy', '--role-name', name, '--policy-name', 'probe', '--policy-document', JSON.stringify(policy)]);
  return r.Role.Arn;
};
const deleteRole = (name: string) => { aws(['iam', 'delete-role-policy', '--role-name', name, '--policy-name', 'probe']); aws(['iam', 'delete-role', '--role-name', name]); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type State = { openaiProviderArn?: string; oauthProviderArn?: string; roleArn?: string; harnessArn?: string; harnessId?: string; stateMachineArn?: string };
const load = (): State => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : {});
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const SESSION = 'probe-harness-session-000000000000000000000000';

async function up(): Promise<void> {
  const st = load();
  const wnk = JSON.parse(readFileSync('tenants/wnk.json', 'utf8')) as { cognitoClientId: string };
  const userPoolId = out('wnk-auth-dev', 'userPoolId');
  const gatewayArn = `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/${out('wnk-gateway-dev', 'gatewayId')}`;

  // 1. OpenAI key -> Identity API key provider
  if (!st.openaiProviderArn) {
    const sm = new SecretsManagerClient({ region: REGION });
    const s = await sm.send(new GetSecretValueCommand({ SecretId: out('wnk-voice-dev', 'openaiSecretArn') }));
    const { OPENAI_API_KEY } = JSON.parse(s.SecretString ?? '{}') as { OPENAI_API_KEY: string };
    const r = await control.send(new CreateApiKeyCredentialProviderCommand({ name: `${PNAME}-openai`, apiKey: OPENAI_API_KEY }));
    st.openaiProviderArn = r.credentialProviderArn; save(st); console.log('openai provider:', st.openaiProviderArn);
  }
  // 2. wnk's Gateway identity -> Identity OAuth2 provider (client credentials vs Cognito)
  if (!st.oauthProviderArn) {
    const cognito = new CognitoIdentityProviderClient({ region: REGION });
    const { UserPoolClient } = await cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: wnk.cognitoClientId }));
    const r = await control.send(new CreateOauth2CredentialProviderCommand({
      name: `${PNAME}-wnk-gateway`,
      credentialProviderVendor: 'CustomOauth2',
      oauth2ProviderConfigInput: { customOauth2ProviderConfig: {
        clientId: wnk.cognitoClientId,
        clientSecret: UserPoolClient!.ClientSecret!,
        oauthDiscovery: { discoveryUrl: `https://cognito-idp.${REGION}.amazonaws.com/${userPoolId}/.well-known/openid-configuration` },
      } },
    }));
    st.oauthProviderArn = r.credentialProviderArn; save(st); console.log('oauth provider:', st.oauthProviderArn);
  }
  // 3. Execution role (documented sample, scoped to these providers)
  if (!st.roleArn) {
    const ac = (r: string) => `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:${r}`;
    const roleArn = createRole(NAME, 'bedrock-agentcore.amazonaws.com', { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'xray:GetSamplingRules', 'xray:GetSamplingTargets', 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups', 'logs:PutResourcePolicy'], Resource: '*' },
      { Effect: 'Allow', Action: 'cloudwatch:PutMetricData', Resource: '*', Condition: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } } },
      { Effect: 'Allow', Action: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT', 'bedrock-agentcore:GetResourceApiKey', 'bedrock-agentcore:GetResourceOauth2Token'], Resource: [ac('workload-identity-directory/default'), ac('workload-identity-directory/default/workload-identity/*'), ac('token-vault/default'), ac('token-vault/default/apikeycredentialprovider/*'), ac('token-vault/default/oauth2credentialprovider/*')] },
      { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bedrock-agentcore-identity!*` },
      { Effect: 'Allow', Action: 'bedrock-agentcore:InvokeGateway', Resource: gatewayArn },
    ] });
    st.roleArn = roleArn; save(st); console.log('role:', st.roleArn);
    await sleep(10_000); // IAM propagation
  }
  // 4. The harness
  if (!st.harnessArn) {
    let last: unknown;
    for (let i = 0; i < 6; i++) {
      try {
        const r = await control.send(new CreateHarnessCommand({
          harnessName: NAME,
          executionRoleArn: st.roleArn!,
          model: { openAiModelConfig: { modelId: process.env.ASSISTANT_MODEL ?? 'gpt-5-mini', apiKeyArn: st.openaiProviderArn!, apiFormat: 'responses' } },
          systemPrompt: [{ text: 'You are My Assistant for WNK Home Services, chatting with the owner. Be brief and plain. Use your CRM tools to look things up; say what you found.' }],
          tools: [{ type: 'agentcore_gateway', name: 'wnkgateway', config: { agentCoreGateway: { gatewayArn, outboundAuth: { oauth: { providerArn: st.oauthProviderArn!, scopes: ['gateway/assistant'], grantType: 'CLIENT_CREDENTIALS' } } } } }],
          allowedTools: ['@wnkgateway/*'],
          memory: { disabled: {} },
          maxIterations: 8,
          timeoutSeconds: 120,
        }));
        st.harnessArn = r.harness?.arn; st.harnessId = r.harness?.harnessId; save(st); console.log('harness:', st.harnessArn); break;
      } catch (err) { last = err; console.log('create harness retry:', String(err).slice(0, 160)); await sleep(8_000); }
    }
    if (!st.harnessArn) throw last;
  }
  for (let i = 0; i < 60; i++) {
    const g = await control.send(new GetHarnessCommand({ harnessId: st.harnessId! }));
    const status = g.harness?.status;
    console.log(`harness status: ${status}`);
    if (status === 'READY') return;
    if (String(status).endsWith('FAILED')) throw new Error(`harness ${status}: ${JSON.stringify(g.harness).slice(0, 400)}`);
    await sleep(10_000);
  }
  throw new Error('harness not READY after 10 minutes');
}

async function invoke(text: string): Promise<void> {
  const st = load();
  const res = await data.send(new InvokeHarnessCommand({
    harnessArn: st.harnessArn!, runtimeSessionId: SESSION,
    messages: [{ role: 'user', content: [{ text }] }],
  }));
  let answer = ''; const tools: string[] = []; let stop = ''; let usage: unknown;
  for await (const ev of res.stream ?? []) {
    if ('contentBlockStart' in ev) { const tu = (ev.contentBlockStart as { start?: { toolUse?: { name?: string } } }).start?.toolUse; if (tu?.name) tools.push(tu.name); }
    if ('contentBlockDelta' in ev) { const d = (ev.contentBlockDelta as { delta?: { text?: string } }).delta; if (d?.text) answer += d.text; }
    if ('messageStop' in ev) stop = String((ev.messageStop as { stopReason?: string }).stopReason);
    if ('metadata' in ev) usage = (ev.metadata as { usage?: unknown }).usage;
    if ('internalServerException' in ev || 'validationException' in ev || 'runtimeClientError' in ev) console.log('stream error:', JSON.stringify(ev).slice(0, 400));
  }
  console.log('tool uses:', tools.join(', ') || '(none)');
  console.log('stop:', stop, '| usage:', JSON.stringify(usage));
  console.log('answer:', answer.trim());
}

async function sfnProbe(text: string): Promise<void> {
  const st = load();
  if (!st.stateMachineArn) {
    const sfnRoleArn = createRole(`${NAME}_sfn`, 'states.amazonaws.com', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'], Resource: [st.harnessArn, `${st.harnessArn}/*`] }] });
    await sleep(10_000);
    const def = { QueryLanguage: 'JSONata', StartAt: 'Invoke', States: { Invoke: { Type: 'Task', Resource: 'arn:aws:states:::bedrockagentcore:invokeHarness', Arguments: {
      HarnessArn: st.harnessArn, RuntimeSessionId: 'probe-sfn-session-0000000000000000000000000000',
      Messages: [{ Role: 'user', Content: [{ Text: '{% $states.input.text %}' }] }],
      TimeoutSeconds: 120,
    }, End: true } } };
    const sm = awsJson<{ stateMachineArn: string }>(['stepfunctions', 'create-state-machine', '--name', `${NAME}_sfn`, '--type', 'EXPRESS', '--role-arn', sfnRoleArn, '--definition', JSON.stringify(def)]);
    st.stateMachineArn = sm.stateMachineArn; save(st); console.log('state machine:', st.stateMachineArn);
  }
  const ex = awsJson<{ status: string; error?: string; cause?: string; output?: string }>(['stepfunctions', 'start-sync-execution', '--state-machine-arn', st.stateMachineArn!, '--input', JSON.stringify({ text })]);
  console.log('status:', ex.status, ex.error ? `| error: ${ex.error} ${ex.cause?.slice(0, 300)}` : '');
  console.log('output:', (ex.output ?? '').slice(0, 1200));
}

async function down(): Promise<void> {
  const st = load();
  const tryDo = async (label: string, f: () => Promise<unknown>) => { try { await f(); console.log('deleted', label); } catch (err) { console.log('skip', label, String(err).slice(0, 120)); } };
  if (st.stateMachineArn) await tryDo('state machine', async () => aws(['stepfunctions', 'delete-state-machine', '--state-machine-arn', st.stateMachineArn!]));
  await tryDo('sfn role', async () => deleteRole(`${NAME}_sfn`));
  if (st.harnessId) await tryDo('harness', () => control.send(new DeleteHarnessCommand({ harnessId: st.harnessId, deleteManagedMemory: true })));
  await tryDo('role', async () => deleteRole(NAME));
  await tryDo('oauth provider', () => control.send(new DeleteOauth2CredentialProviderCommand({ name: `${PNAME}-wnk-gateway` })));
  await tryDo('openai provider', () => control.send(new DeleteApiKeyCredentialProviderCommand({ name: `${PNAME}-openai` })));
  if (existsSync(STATE)) unlinkSync(STATE);
}

const cmd = process.argv[2] ?? 'up';
const text = process.argv[3] ?? 'Do we have a contact named Composio Smoke Test? If so give me their phone number.';
if (cmd === 'up') await up();
else if (cmd === 'invoke') await invoke(text);
else if (cmd === 'sfn') await sfnProbe(text);
else if (cmd === 'down') await down();
else throw new Error(`unknown command ${cmd}`);
