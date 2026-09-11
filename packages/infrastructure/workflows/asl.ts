/**
 * The grammar every workflow definition shares. Three things, on purpose:
 * the expression wrapper, the HTTP task (retry + Connection auth), and the
 * once-marker pair. A helper earns a place here only when it encodes a rule
 * every workflow must get identical; anything else lives in the workflow's
 * own file, duplicated if need be. No CDK imports: definitions built from
 * these are plain objects a test can import and walk.
 *
 * JSONata strings in definitions: no quotes or apostrophes inside a string
 * literal (Step Functions rejects the escapes). The definitions test
 * validates every synthesized machine with the service before a deploy.
 */

export const q = (expr: string) => `{% ${expr} %}`;

/** v3.1: the path the Composio SDK uses; v3 does not resolve every HubSpot slug. */
export const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1/';
export const OPENAI_API = 'https://api.openai.com/v1/';

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

// ---- Once-marker on the call row --------------------------------------------
// Mark-after-success is hardening against redelivery, not exactly-once. The
// marker is an attribute on the call row named by `key` (a literal or a q()
// expression); `$states.input.detail.callId` is the bus event's call id.

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
