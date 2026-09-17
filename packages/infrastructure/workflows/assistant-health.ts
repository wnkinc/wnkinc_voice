/**
 * Assistant health canary: on a schedule, prove each tenant's assistant can
 * still complete a turn, before one of its people finds out it cannot.
 *
 * composio-health proves the tenant's *connections* are ACTIVE. This proves
 * the rest of the path, none of which an ACTIVE connection vouches for: that
 * the model answers through the OpenAI Connection, that Memory reads and
 * writes, and that a tool call reaches Composio and comes back. It runs the
 * same loop the Telegram and SMS workflows run (workflows/assistant-loop.ts),
 * with search_contacts as its one allowed tool.
 *
 * The probe reads and never writes: it asks after a phone number no contact
 * has. What it asserts is deliberately thin: the loop produced text. Asserting
 * on what the model *said* would make the canary flaky, and a flaky canary
 * only teaches you to ignore the alarm it rings.
 *
 * Known blind spot: a tenant whose HubSpot connection is gone gets a failed
 * tool result and the model apologizes in prose, and prose passes here. The
 * connection is composio-health's job; this is liveness.
 */
import { q } from './asl.js';
import { assistantLoopStart, assistantLoopStates, assistantPrepare, assistantSaveTurnState, type AssistantLoopRefs } from './assistant-loop.js';

export interface AssistantHealthRefs extends AssistantLoopRefs {
  tenantsTable: string;
}

/** Read-only, and no contact carries this number, so the answer is "nothing found" however it is worded. (+15555550100 is the Composio smoke-test contact.) */
export const PROBE_TEXT = 'Search the CRM for the phone number +15555550177 and reply in one short sentence with what you find.';

/**
 * A tenant row (DynamoDB AttributeValue shape) whose assistant is on. `Bool`,
 * as the aws-sdk scan integration returns it; the optimized getItem
 * used elsewhere returns `BOOL`, so the two are not interchangeable.
 */
export const assistantUsableExpr = (rowExpr: string) => `${rowExpr}.assistant.M.enabled.Bool = true`;

export function assistantHealthDefinition(refs: AssistantHealthRefs) {
  const save = assistantSaveTurnState(refs);
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
              Choices: [{ Condition: q(assistantUsableExpr('$states.input')), Next: 'Prepare' }],
              Default: 'NotUsed',
            },
            NotUsed: { Type: 'Succeed' },
            // Its own actor, and a session per day, so the canary's turns
            // never land in a real person's memory. The loop reads $tenant
            // as `tenantId.S`, which the scan row carries in the same shape.
            Prepare: {
              Type: 'Pass',
              Assign: {
                ...assistantPrepare(),
                tenant: q('$states.input'),
                text: PROBE_TEXT,
                systemPrompt: 'You are a scheduled health probe for a small business assistant. Use your tools to answer, and reply in one short sentence.',
                actorId: q("$states.input.tenantId.S & '_canary'"),
                sessionId: q("'canary-' & $states.input.tenantId.S & '-' & $fromMillis($millis(), '[Y0001][M01][D01]')"),
                allowedTools: ['search_contacts'],
              },
              Output: q('$states.input'), Next: assistantLoopStart(refs),
            },
            ...assistantLoopStates(refs, 'Answered'),
            Answered: {
              Type: 'Choice',
              Choices: [{ Condition: q('$exists($reply) and $length($trim($reply)) > 0'), Next: save ? 'SaveTurn' : 'Healthy' }],
              Default: 'Silent',
            },
            ...(save ? { SaveTurn: { ...save, Output: q('$states.input'), Next: 'Healthy' } } : {}),
            Healthy: { Type: 'Succeed' },
            Silent: {
              Type: 'Fail', Error: 'AssistantSilent',
              Cause: q("'tenant ' & $states.input.tenantId.S & ': the assistant loop produced no text. Check this execution, then reproduce with scripts/test-assistant.mts against this tenant.'"),
            },
          },
        },
        End: true,
      },
    },
  };
}
