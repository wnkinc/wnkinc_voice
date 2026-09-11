/**
 * Builders shared by the JSONata state machines in the voice and runtime
 * stacks. Expressions are exported unwrapped (plain JSONata) so the tests can
 * evaluate them with the jsonata package; `q()` wraps one for a definition.
 *
 * JSONata strings in definitions: no quotes or apostrophes inside a string
 * literal (Step Functions rejects the escapes). Validate a synthesized
 * definition offline before deploying: see the sfn-jsonata memory note.
 */
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';

export const q = (expr: string) => `{% ${expr} %}`;
/** '' for a missing or null field (HubSpot returns null for unset properties). */
export const strOrEmpty = (expr: string) => `($exists(${expr}) and ${expr} != null ? ${expr} : '')`;
/** HTML-escape a JSONata string expression (HubSpot note bodies are HTML). */
export const esc = (expr: string) => `$replace($replace($replace(${expr}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;

/** v3.1: the path the Composio SDK uses; v3 does not resolve every HubSpot slug. */
export const COMPOSIO_API = 'https://backend.composio.dev/api/v3.1/';
export const OPENAI_API = 'https://api.openai.com/v1/';

/** An HTTP task through an EventBridge Connection. One retry, as the SDK adapter had. */
export function httpTask(connection: events.IConnection, method: 'GET' | 'POST', url: string, body?: Record<string, unknown> | string, query?: Record<string, string>) {
  return {
    Type: 'Task', Resource: 'arn:aws:states:::http:invoke',
    Arguments: {
      ApiEndpoint: url, Method: method,
      Authentication: { ConnectionArn: connection.connectionArn },
      ...(body ? { RequestBody: body } : {}), ...(query ? { QueryParameters: query } : {}),
    },
    Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 2, MaxAttempts: 1 }],
  };
}

/**
 * Express with execution data NOT logged: for workflows whose inputs or
 * fetched payloads carry transcripts, CRM notes, or SIP headers. State
 * transitions and errors still log (and the failed-executions alarm still
 * fires); payloads are persisted nowhere.
 */
export function expressNoData(scope: Construct, logId: string) {
  return {
    stateMachineType: sfn.StateMachineType.EXPRESS,
    logs: {
      destination: new logs.LogGroup(scope, logId, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      level: sfn.LogLevel.ALL,
      includeExecutionData: false,
    },
  };
}

/** What an HTTP task needs: the endpoint allow-list, the connection, and the secret EventBridge keeps for it. */
export function grantHttp(wf: sfn.StateMachine, connections: events.IConnection[], endpointPatterns: string[]) {
  const stack = cdk.Stack.of(wf);
  wf.addToRolePolicy(new iam.PolicyStatement({
    actions: ['states:InvokeHTTPEndpoint'], resources: ['*'],
    conditions: { StringLike: { 'states:HTTPEndpoint': endpointPatterns } },
  }));
  wf.addToRolePolicy(new iam.PolicyStatement({ actions: ['events:RetrieveConnectionCredentials'], resources: connections.map((c) => c.connectionArn) }));
  wf.addToRolePolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:events!connection/*`],
  }));
}

// ---- Expressions ------------------------------------------------------------

/** Headers (in priority order) that may carry the called / calling number. Twilio puts the dialed number in Diversion. */
export const SIP_CALLED_HEADERS = ['To', 'Diversion', 'X-Called-Number', 'P-Called-Party-ID', 'X-Twilio-To'];
export const SIP_CALLER_HEADERS = ['From', 'P-Asserted-Identity', 'X-Twilio-From'];

/**
 * E.164 ('+15551234567') from the first of `names` present in the SIP header
 * list `headersExpr` ([{name, value}]) whose value carries a phone number
 * (sip:/tel: URI, or a bare number). '' when none.
 */
export function sipNumberExpr(headersExpr: string, names: string[]): string {
  return [
    `( $h := ${headersExpr};`,
    '$val := function($n) { $h[$lowercase(name) = $lowercase($n)][0].value };',
    '$e164 := function($v) { (',
    '  $m := $exists($v) ? $match($v, /(?:sips?|tel):\\+?([0-9][0-9().\\- ]*)/i) : [];',
    "  $raw := $count($m) > 0 ? $m[0].groups[0] : (($exists($v) and $contains($v, /^\\s*\\+?[0-9().\\- ]+\\s*$/)) ? $v : '');",
    "  $d := $replace($raw, /[^0-9]/, '');",
    "  ($length($d) >= 7 and $length($d) <= 15) ? '+' & $d : ''",
    ') };',
    `$c := ${JSON.stringify(names)} ~> $map(function($n) { $e164($val($n)) });`,
    "$c := $c[$ != ''];",
    "$count($c) > 0 ? $c[0] : '' )",
  ].join(' ');
}

/**
 * ISO timestamp of the next weekday at 9:00 tenant-local. `offsetExpr` is the
 * seed's sessionDayOffsetMinutes (= 180 - zoneOffsetMinutes). JSONata has no
 * tz database, so after a DST change the hour drifts by one until the next seed.
 */
export function nextBusinessMorningExpr(offsetExpr: string, nowExpr = '$millis()'): string {
  return [
    `( $zone := (180 - ${offsetExpr}) * 60000; $nowMs := ${nowExpr};`,
    '$day := $floor(($nowMs + $zone) / 86400000);',
    '$due := [0..7] ~> $map(function($i) { ( $d := $day + $i; $dow := ($d + 4) % 7; ($dow != 0 and $dow != 6) ? ($d * 86400000 + 9 * 3600000 - $zone) : 0 ) }) ~> $filter(function($t) { $t > $nowMs });',
    '$fromMillis($due[0]) )',
  ].join(' ');
}

/** HubSpot note HTML -> one-line text, as the prompt wants it. */
export const htmlToTextExpr = (expr: string) => `$trim($replace($replace($replace(${expr}, /<br[^>]*>/, ' '), /<[^>]+>/, ' '), /\\s+/, ' '))`;
