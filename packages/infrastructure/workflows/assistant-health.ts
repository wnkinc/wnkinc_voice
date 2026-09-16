/**
 * Assistant health canary: on a schedule, prove each tenant's assistant can
 * still complete a turn, before one of its people finds out it cannot.
 *
 * composio-health proves the tenant's *connections* are ACTIVE. This proves
 * the rest of the path, none of which an ACTIVE connection vouches for: that
 * the harness answers at all (a cold start slow enough to outrun its caller
 * looks exactly like a healthy idle one), that the model key resolves from
 * the vault, that Memory threads a session, and that the tenant's own
 * Composio MCP session — minted once by the seed — still serves tools.
 *
 * The probe reads and never writes: it asks after a phone number no contact
 * has. What it asserts is deliberately thin — the invoke returned, with text.
 * Asserting on what the model *said* would make the canary flaky, and a flaky
 * canary only teaches you to ignore the alarm it rings.
 *
 * Known blind spot: if the MCP session is dead the model may apologize in
 * prose instead of failing, and prose passes here. The connection behind it
 * is composio-health's job; this is liveness.
 */
import { q } from './asl.js';

export interface AssistantHealthRefs {
  tenantsTable: string;
  harnessArn: string;
  composioProviderArn: string;
}

/** Read-only, and no contact carries this number, so the answer is "nothing found" however it is worded. */
export const PROBE_TEXT = 'Search the CRM for the phone number +15555550100 and reply in one short sentence with what you find.';

/**
 * A tenant row whose assistant is on and has a session to use. Note `Bool`, not
 * `BOOL`: this row comes from the aws-sdk scan integration, which spells the
 * all-caps AttributeValue tags in SDK case. The optimized `dynamodb:getItem`
 * used elsewhere returns `BOOL`, so the two are not interchangeable.
 */
export const assistantUsableExpr = (rowExpr: string) =>
  `${rowExpr}.assistant.M.enabled.Bool = true and $exists(${rowExpr}.assistant.M.composioMcpUrl.S)`;

export function assistantHealthDefinition(refs: AssistantHealthRefs) {
  return {
    QueryLanguage: 'JSONata',
    StartAt: 'ListTenants',
    States: {
      // The Tenants table is tiny (one row per called number); a scan is the
      // read. A new tenant is covered by it; nothing here names one.
      ListTenants: {
        Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:dynamodb:scan',
        Arguments: { TableName: refs.tenantsTable },
        Assign: { tenants: q('[$states.result.Items]') },
        Output: q('$states.input'), Next: 'EachTenant',
      },
      EachTenant: {
        Type: 'Map',
        Items: q('$tenants'),
        MaxConcurrency: 2,
        ItemProcessor: {
          ProcessorConfig: { Mode: 'INLINE' },
          StartAt: 'AssistantOn',
          States: {
            AssistantOn: {
              Type: 'Choice',
              Choices: [{ Condition: q(assistantUsableExpr('$states.input')), Next: 'Probe' }],
              Default: 'NotUsed',
            },
            NotUsed: { Type: 'Succeed' },
            Probe: {
              Type: 'Task', Resource: 'arn:aws:states:::bedrockagentcore:invokeHarness',
              Arguments: {
                HarnessArn: refs.harnessArn,
                // Its own actor, and a session per day, so the canary's turns
                // never land in a real person's memory. Ids must be >= 33 chars.
                RuntimeSessionId: q("'canary-' & $states.input.tenantId.S & '-' & $fromMillis($millis(), '[Y0001][M01][D01]') & '-0000000000000000'"),
                ActorId: q("$states.input.tenantId.S & '_canary'"),
                Messages: [{ Role: 'user', Content: [{ Text: PROBE_TEXT }] }],
                SystemPrompt: [{ Text: 'You are a scheduled health probe for a small business assistant. Use your tools to answer, and reply in one short sentence.' }],
                // The tenant's own Composio session, chosen by its row; the key
                // rides by ARN and is resolved from the vault at invocation.
                Tools: [{ Type: 'remote_mcp', Name: 'crm', Config: { RemoteMcp: { Url: q('$states.input.assistant.M.composioMcpUrl.S'), Headers: { 'x-api-key': `\${${refs.composioProviderArn}}` } } } }],
                AllowedTools: ['@crm/*'],
                TimeoutSeconds: 120,
              },
              // A first invoke against a cold microVM can outrun AgentCore's 120s
              // init budget and come back 424 — reliably so after a deploy, when the
              // image is pulled again. The next invoke finds it warm, so one retry
              // separates that self-healing miss from a harness that is actually
              // down. Measured: ~62s cold, ~13s warm, failure only on the first
              // invoke after a deploy.
              Retry: [
                { ErrorEquals: ['BedrockAgentCore.ThrottlingException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 },
                { ErrorEquals: ['BedrockAgentCore.RuntimeClientErrorException'], IntervalSeconds: 10, MaxAttempts: 1 },
              ],
              Assign: { reply: q('$states.result.Output.Message.Content[0].Text') },
              Output: q('$states.input'), Next: 'Answered',
            },
            Answered: {
              Type: 'Choice',
              Choices: [{ Condition: q('$exists($reply) and $length($trim($reply)) > 0'), Next: 'Healthy' }],
              Default: 'Silent',
            },
            Healthy: { Type: 'Succeed' },
            Silent: {
              Type: 'Fail', Error: 'AssistantSilent',
              Cause: q("'tenant ' & $states.input.tenantId.S & ': the assistant harness returned no text. Check its log group, then reproduce with scripts/test-assistant.mts against this tenant.'"),
            },
          },
        },
        End: true,
      },
    },
  };
}
