/**
 * The grammar every workflow definition shares. Four things, on purpose:
 * the expression wrapper, the HTTP task (retry + Connection auth), the
 * Composio calls (every one names the tenant), and the once-marker pair. A
 * helper earns a place here only when it encodes a rule every workflow must
 * get identical; anything else lives in the workflow's own file, duplicated
 * if need be. No CDK imports: definitions built from these are plain objects
 * a test can import and walk.
 *
 * JSONata strings in definitions: no quotes or apostrophes inside a string
 * literal (Step Functions rejects the escapes). The definitions test
 * validates every synthesized machine with the service before a deploy.
 */

export const q = (expr: string) => `{% ${expr} %}`;

/**
 * The CRM gate, as a JSONata fragment over a tenant row bound to `$tenant`
 * (or the row expression you pass). One definition: every read of the
 * tenant's CRM (caller lookup, email enrichment, lead and call sync) and the
 * health canary must agree on what "this tenant has a CRM" means.
 */
export const hasCrm = (row = '$tenant') => `${row}.crm.M.type.S = 'hubspot' and ${row}.crm.M.via.S = 'composio'`;

/** v3.1: the path the Composio SDK uses; v3 does not resolve every HubSpot slug. */
export const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1/';
export const OPENAI_API = 'https://api.openai.com/v1/';
export const BROWSERBASE_API = 'https://api.browserbase.com/v1/';

/** An HTTP task through an EventBridge Connection. One retry, as the SDK adapter had. */
export function httpTask(connectionArn: string, method: 'GET' | 'POST', url: string, body?: Record<string, unknown> | string, query?: Record<string, string>) {
  return {
    Type: 'Task', Resource: 'arn:aws:states:::http:invoke',
    Arguments: {
      ApiEndpoint: url, Method: method,
      Authentication: { ConnectionArn: connectionArn },
      ...(body ? { RequestBody: body } : {}), ...(query ? { QueryParameters: query } : {}),
    },
    Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 2, MaxAttempts: 1 }],
  };
}

// ---- Composio ------------------------------------------------------------------
// The tenant's SaaS credentials live in Composio's vault under our tenant id
// (Composio user_id = tenantId), so every call names the tenant, and the
// definitions test checks that no Composio task lacks it. These are the
// three shapes a workflow uses; the tool slugs and arguments stay in the
// workflow file. `tenantId` is a q() expression for the tenant id in scope.
// This changes the edit surface when Composio moves an endpoint (one place),
// not the blast radius (still one deploy): there is no runtime fallback.

/** Composio's HTTP API for one tenant, through the Connection that holds the platform key. */
export function composio(connectionArn: string, tenantId: string) {
  return {
    /**
     * Run a toolkit tool (`HUBSPOT_CREATE_NOTE`, `GMAIL_SEND_EMAIL`, ...) with the tenant's connected account. `args` may be a q() expression.
     * `version` pins the toolkit release. Without it the REST API runs the toolkit's oldest release (`00000000_00`), not the newest:
     * fine where that one works (Gmail, HubSpot today), wrong where it does not (Facebook's cannot post to a Page).
     */
    execute: (slug: string, args: Record<string, unknown> | string, version?: string) =>
      httpTask(connectionArn, 'POST', `${COMPOSIO_API}tools/execute/${slug}`, { user_id: tenantId, arguments: args, ...(version ? { version } : {}) }),
    /** The tenant's ACTIVE connected accounts, for one toolkit or all. */
    accounts: (toolkit?: string) =>
      httpTask(connectionArn, 'GET', `${COMPOSIO_API}connected_accounts`, undefined, { user_ids: tenantId, ...(toolkit ? { toolkit_slugs: toolkit } : {}), statuses: 'ACTIVE' }),
    /** The toolkit's own REST API on one of those accounts (`accountId` from `accounts`), for what no tool covers. */
    proxy: (accountId: string, method: 'GET' | 'POST', endpoint: string, body?: Record<string, unknown>) =>
      httpTask(connectionArn, 'POST', `${COMPOSIO_API}tools/execute/proxy`, { endpoint, method, connected_account_id: accountId, ...(body ? { body } : {}) }),
  };
}

// ---- Once-marker on the call row --------------------------------------------
// For side effects that run under at-least-once delivery (EventBridge rule
// retries, our own HTTP retries). Pattern: CheckDone -> Choice on $done ->
// the side effect -> MarkDone. The marker is an attribute on the call row
// named by `key`, a literal or a q() expression built from DOMAIN identity
// (e.g. done:email:lead:<leadId>), never the EventBridge event id, which
// differs between two PutEvents of the same fact. `$states.input.detail.callId`
// is the bus event's call id.
//
// This is the low-risk level: it narrows the duplicate window to a crash
// between the side effect and the mark. It is not exactly-once. Actions that
// cost money or reach a customer irreversibly need a ledger (pending ->
// completed with a lease) plus reconciliation instead; that need is the
// trigger for building the ledger.

/** Reads the marker (and any extra attributes) from the call row; the caller assigns `done` from the result. */
export function checkDone(callsTable: string, key: string, extraProjection = '') {
  return {
    Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
    Arguments: {
      TableName: callsTable, Key: { callId: { S: q('$states.input.detail.callId') } },
      ProjectionExpression: `#k${extraProjection ? `, ${extraProjection}` : ''}`, ExpressionAttributeNames: { '#k': key },
    },
  };
}

/** Writes the marker with a timestamp (and a TTL if the row has none). `conditional` fails on a marker written meanwhile. The caller adds End or Next. */
export function markDone(callsTable: string, key: string, opts: { conditional?: boolean } = {}) {
  return {
    Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
    Arguments: {
      TableName: callsTable, Key: { callId: { S: q('$states.input.detail.callId') } },
      UpdateExpression: 'SET #k = :at, expiresAt = if_not_exists(expiresAt, :ttl)',
      ...(opts.conditional ? { ConditionExpression: 'attribute_not_exists(#k)' } : {}),
      ExpressionAttributeNames: { '#k': key },
      ExpressionAttributeValues: { ':at': { S: q('$now()') }, ':ttl': { N: q('$string($floor($millis() / 1000) + 90 * 86400)') } },
    },
  };
}
