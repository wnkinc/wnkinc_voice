/**
 * Platform catalog: every unit the platform runs, described by the four
 * answers that matter to the operator, with the deployed facts under each.
 *
 *   npm run synth && npx tsx scripts/catalog.ts     -> tenant-profiles/catalog.md
 *
 * A unit is anything that runs: a Step Functions state machine, a Lambda, or
 * the harness. Two sources:
 *   - the synthesized CloudFormation in cdk.out (what actually deploys):
 *     triggers, side effects, exits, gates, once-markers, alarms, logging are
 *     read out of the templates and the state machine definitions, so they
 *     cannot drift.
 *   - the unit's source file: `outcomes` (UnitOutcomes, the four answers) and
 *     the doc comment at the top (the how). A unit without outcomes shows as
 *     UNDESCRIBED.
 * Nothing tenant-specific here; tenant-profile.ts is the per-tenant view.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { UnitOutcomes } from '@wnk/shared';

type Json = any;
const manifest = JSON.parse(readFileSync('cdk.out/manifest.json', 'utf8'));
const stackNames: string[] = Object.entries(manifest.artifacts).filter(([, a]: any) => a.type === 'aws:cloudformation:stack').map(([k]) => k);
const resources: Record<string, { stack: string; type: string; props: Json }> = {};
for (const s of stackNames) {
  const t = JSON.parse(readFileSync(`cdk.out/${s}.template.json`, 'utf8'));
  for (const [id, r] of Object.entries<Json>(t.Resources)) resources[id] = { stack: s, type: r.Type, props: r.Properties ?? {} };
}

// ---- Tokens: CloudFormation intrinsics -> readable construct names ---------
const construct = (logicalId: string) => logicalId.replace(/^ExportsOutput(?:Ref|FnGetAtt)/, '').replace(/[0-9A-F]{8}.*$/, '');
function flat(v: Json): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (v['Fn::Join']) return v['Fn::Join'][1].map(flat).join('');
  if (v.Ref) return `«${v.Ref}»`;
  if (v['Fn::GetAtt']) return `«${v['Fn::GetAtt'][0]}»`;
  if (v['Fn::ImportValue']) return `«${v['Fn::ImportValue'].split(':')[1]}»`;
  return `«?»`;
}
const pretty = (s: string) => s.replace(/«([^»]+)»/g, (_, id) => construct(id));
const refId = (v: Json): string | undefined => v?.Ref ?? v?.['Fn::GetAtt']?.[0];
const unwrap = (expr: string) => expr.replace(/^\{% |%\}$/g, '').trim();

// ---- The unit's source file: outcomes + doc comment --------------------------
const kebab = (id: string) => id.replace(/Workflow$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
async function fromSource(file: string): Promise<{ outcomes?: UnitOutcomes; how?: string }> {
  if (!existsSync(file)) return {};
  const m = readFileSync(file, 'utf8').match(/^\/\*\*([\s\S]*?)\*\//);
  const how = m?.[1]?.split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim();
  const mod = await import(pathToFileURL(file).href).catch(() => ({}));
  return { outcomes: mod.outcomes, how };
}

// ---- Walk a state machine definition -----------------------------------------
interface Facts {
  services: Set<string>; tables: Map<string, Set<string>>; writes: Set<string>; posts: Set<string>; emits: Set<string>;
  gates: Set<string>; markers: Set<string>; starts: Set<string>; queues: Set<string>; harness: Set<string>; memory: Set<string>;
  ok: Set<string>; fail: Map<string, string>;
}
const newFacts = (): Facts => ({ services: new Set(), tables: new Map(), writes: new Set(), posts: new Set(), emits: new Set(), gates: new Set(), markers: new Set(), starts: new Set(), queues: new Set(), harness: new Set(), memory: new Set(), ok: new Set(), fail: new Map() });
const host = (url: string) => (url.match(/https?:\/\/([^/'"\s]+)/)?.[1] ?? url);
const RENTED: Record<string, string> = { 'backend.composio.dev': 'Composio', 'api.openai.com': 'OpenAI Realtime', 'api.browserbase.com': 'Browserbase', 'api.telegram.org': 'Telegram' };
function walk(states: Json, f: Facts, prefix = '') {
  for (const [name, st] of Object.entries<Json>(states ?? {})) {
    if (st.Branches) st.Branches.forEach((b: Json) => walk(b.States, f, `${name}/`));
    if (st.ItemProcessor) walk(st.ItemProcessor.States, f, `${name}/`);
    if (st.Type === 'Succeed') f.ok.add(prefix + name);
    if (st.Type === 'Fail') f.fail.set(prefix + name, typeof st.Cause === 'string' && !st.Cause.startsWith('{%') ? st.Cause : (st.Error ?? ''));
    for (const c of st.Choices ?? []) if (/\$tenant\./.test(c.Condition ?? '')) f.gates.add(unwrap(c.Condition));
    const res: string = st.Resource ?? '';
    const a = st.Arguments ?? st.Parameters ?? {};
    if (res.includes(':dynamodb:')) {
      const op = res.split(':').pop()!; const table = pretty(a.TableName ?? '?');
      f.services.add('DynamoDB'); (f.tables.get(table) ?? f.tables.set(table, new Set()).get(table)!).add(op);
      if (/put|update|delete/i.test(op)) f.writes.add(`${table} (${op})`);
      const k = a.ExpressionAttributeNames?.['#k']; if (k && /done:/.test(k)) f.markers.add(unwrap(k));
    } else if (res.includes(':events:putEvents')) {
      f.services.add('EventBridge'); for (const e of a.Entries ?? []) f.emits.add(e.DetailType);
    } else if (res.includes(':http:invoke')) {
      const h = host(a.ApiEndpoint ?? ''); const label = RENTED[h] ?? h;
      const tool = (a.ApiEndpoint ?? '').match(/tools\/execute\/([A-Z_]+)/)?.[1];
      const path = unwrap(a.ApiEndpoint ?? '').replace(/' & \$(\w+) & '/g, '{$1}').replace(/^'|'$/g, '').replace(/^https?:\/\/[^/]+/, '') || '/';
      const call = tool ? `${label} ${tool}` : `${label} ${path}`;
      f.services.add(tool ? `${label} (${tool})` : `${label} (${path})`);
      if (a.Method === 'POST' && !/SEARCH|GET_|RETRIEVE|connected_accounts|proxy/.test(call)) f.posts.add(call);
    } else if (res.includes(':bedrockagentcore:invokeHarness')) { f.services.add('AgentCore Runtime (harness)'); f.harness.add(pretty(a.HarnessId ?? a.HarnessArn ?? '?')); }
    else if (res.includes(':bedrockagentcore:')) { const op = res.split(':').pop()!; f.services.add('AgentCore Memory'); f.memory.add(op); if (/create/i.test(op)) f.writes.add(`caller memory (${op})`); }
    else if (res.includes(':sqs:')) { f.services.add('SQS'); f.queues.add(pretty(a.QueueUrl ?? '?')); }
    else if (res.includes(':states:startExecution')) { f.services.add('Step Functions'); f.starts.add(pretty(a.StateMachineArn ?? '?')); }
    else if (res.includes(':lambda:')) { f.services.add('Lambda'); }
  }
}

// ---- Units: state machines, Lambdas, the harness ------------------------------
interface Unit { id: string; kind: string; name: string; stack: string; file: string; outcomes?: UnitOutcomes; how?: string; triggers: string[]; facts?: Facts; type?: string; logging?: string; alarms: string[]; dlq: string[]; extra: string[] }
const units: Unit[] = [];
const byId: Record<string, Unit> = {};

for (const [id, r] of Object.entries(resources)) {
  if (r.type === 'AWS::StepFunctions::StateMachine') {
    const def = JSON.parse(flat(r.props.DefinitionString));
    const f = newFacts(); walk(def.States, f);
    const lc = r.props.LoggingConfiguration;
    const type = r.props.StateMachineType === 'EXPRESS' ? 'Express' : 'Standard';
    const u: Unit = {
      id, kind: 'Step Functions workflow', name: r.props.StateMachineName, stack: r.stack, file: `packages/infrastructure/workflows/${kebab(construct(id))}.ts`,
      triggers: [], facts: f, type, alarms: [], dlq: [], extra: [],
      logging: lc ? `CloudWatch Logs, level ${lc.Level}, execution data ${lc.IncludeExecutionData ? 'included' : 'not logged'}` : `${type === 'Standard' ? 'Step Functions execution history (90 days)' : 'none'}`,
    };
    if (r.props.TracingConfiguration?.Enabled) u.extra.push('X-Ray tracing on');
    units.push(u); byId[id] = u;
  } else if (r.type === 'AWS::Lambda::Function' && !/^AWS[0-9a-f]{32}/.test(id)) {
    const u: Unit = { id, kind: 'Lambda', name: r.props.FunctionName ?? construct(id), stack: r.stack, file: `packages/voice-session/src/${construct(id)}.ts`, triggers: [], alarms: [], dlq: [], extra: [] };
    const env = r.props.Environment?.Variables ?? {};
    for (const [k, v] of Object.entries<Json>(env)) { const t = refId(v); if (t && resources[t]?.type === 'AWS::StepFunctions::StateMachine') u.extra.push(`starts ${resources[t].props.StateMachineName} (${k})`); }
    u.extra.push(`env names tables: ${Object.entries<Json>(env).filter(([k]) => k.endsWith('_TABLE')).map(([, v]) => pretty(flat(v))).join(', ') || 'none'}`);
    if (r.props.Timeout) u.extra.push(`timeout ${r.props.Timeout}s, ${r.props.MemorySize ?? 128} MB`);
    if (r.props.TracingConfig?.Mode === 'Active') u.extra.push('X-Ray tracing on');
    u.logging = `CloudWatch Logs /aws/lambda/${u.name}`;
    units.push(u); byId[id] = u;
  } else if (r.type === 'AWS::BedrockAgentCore::Harness') {
    const p = r.props; const model = Object.values<Json>(p.Model ?? {})[0] ?? {}; const mem = p.Memory?.AgentCoreMemoryConfiguration;
    const u: Unit = { id, kind: 'AgentCore harness', name: p.HarnessName, stack: r.stack, file: 'packages/infrastructure/workflows/assistant-harness.ts', triggers: [], alarms: [], dlq: [], extra: [
      `model ${model.ModelId ?? '?'} (${model.ApiFormat ?? '?'} API, max ${model.MaxTokens ?? '?'} tokens), key from AgentCore Identity`, `max ${p.MaxIterations} iterations`, `allowed tools ${(p.AllowedTools ?? []).join(', ')}`,
      mem ? `memory ${pretty(flat(mem.Arn))}: last ${mem.MessagesCount} messages + ${Object.keys(mem.RetrievalConfig ?? {}).join(', ')}` : 'no memory',
    ] };
    u.logging = 'AgentCore Runtime (CloudWatch under bedrock-agentcore)';
    units.push(u); byId[id] = u;
  }
}
for (const u of units) Object.assign(u, await fromSource(u.file));

// ---- Triggers, alarms, DLQs --------------------------------------------------
for (const [, r] of Object.entries(resources)) {
  if (r.type === 'AWS::Events::Rule') {
    for (const t of r.props.Targets ?? []) {
      const u = byId[refId(t.Arn) ?? '']; if (!u) continue;
      const p = r.props.EventPattern; const rp = t.RetryPolicy;
      const what = r.props.ScheduleExpression ? `schedule ${r.props.ScheduleExpression}` : `bus event ${(p?.source ?? []).join('|')} / ${(p?.['detail-type'] ?? ['*']).join('|')}`;
      u.triggers.push(`${what}${rp ? ` (retry ${rp.MaximumRetryAttempts}, max age ${rp.MaximumEventAgeInSeconds / 60}m)` : ''}`);
      if (t.DeadLetterConfig) u.dlq.push(`a start the rule could not deliver parks in ${construct(refId(t.DeadLetterConfig.Arn)!)}`);
    }
  } else if (r.type === 'AWS::ApiGatewayV2::Route') {
    const integ = resources[flat(r.props.Target).replace(/^integrations\/«|»$/g, '')];
    const target = refId(integ?.props.RequestParameters?.StateMachineArn) ?? (integ?.props.IntegrationUri && Object.keys(resources).find((k) => flat(integ.props.IntegrationUri).includes(`«${k}»`)));
    const u = byId[target ?? '']; if (u) u.triggers.push(`HTTP ${pretty(flat(r.props.RouteKey)).replace(/\{\{resolve:secretsmanager:[^}]+\}\}/, '<secret path>')}`);
  } else if (r.type === 'AWS::Lambda::EventSourceMapping') {
    const u = byId[refId(r.props.FunctionName) ?? '']; if (!u) continue;
    const qid = refId(r.props.EventSourceArn)!; const q = resources[qid]?.props ?? {};
    u.triggers.push(`SQS ${construct(qid)} (batch ${r.props.BatchSize ?? 10}, message kept ${(q.MessageRetentionPeriod ?? 345600) / 60}m)`);
    const rd = q.RedrivePolicy; if (rd) u.dlq.push(`after ${rd.maxReceiveCount} failed receive(s) the message moves to ${construct(refId(rd.deadLetterTargetArn)!)}`);
  } else if (r.type === 'AWS::CloudWatch::Alarm') {
    for (const d of r.props.Dimensions ?? []) { const u = byId[refId(d.Value) ?? '']; if (u) u.alarms.push(`${r.props.MetricName} ≥ ${r.props.Threshold} in ${r.props.Period}s: "${r.props.AlarmDescription ?? ''}"`); }
  }
}
for (const u of units) {
  for (const target of u.facts?.starts ?? []) { const t = units.find((x) => x.name.endsWith(target) || construct(x.id) === target); if (t) t.triggers.push(`started by ${u.name}`); }
  for (const e of u.extra) { const m = e.match(/^starts (\S+)/); const t = m && units.find((x) => x.name === m[1]); if (t) t.triggers.push(`started by ${u.name}`); }
  for (const q of u.facts?.queues ?? []) { const t = units.find((x) => x.triggers.some((tr) => tr.startsWith(`SQS ${q}`))); if (t) t.triggers.push(`fed by ${u.name} via ${q}`); }
  for (const _ of u.facts?.harness ?? []) { const t = units.find((x) => x.kind === 'AgentCore harness'); if (t) t.triggers.push(`invoked by ${u.name}`); }
}

// ---- Render ------------------------------------------------------------------
const order = ['webhook', 'accept', 'session', 'call-ended', 'lead-email', 'crm-lead', 'crm-call', 'owner-alert', 'telegram', 'assistant', 'browser-login', 'composio-health'];
units.sort((a, b) => order.findIndex((o) => a.name.includes(o)) - order.findIndex((o) => b.name.includes(o)));
const rented = (u: Unit) => [...(u.facts?.services ?? [])].map((x) => x.replace(/ \(.*\)$/, '')).filter((x, i, arr) => arr.indexOf(x) === i);
const list = (xs: Iterable<string>) => [...xs].join('; ');
const isRead = (op: string) => /get|query|scan/i.test(op);

const L: string[] = [`# Platform catalog`, '', `Generated from cdk.out (${stackNames.join(', ')}) and each unit's source file. ${units.length} units.`, '',
  '| Unit | Kind | What comes in | Rented pieces | Tenant gate |', '|---|---|---|---|---|'];
for (const u of units) L.push(`| ${u.name} | ${u.kind}${u.type ? ` (${u.type})` : ''} | ${u.triggers[0] ?? '—'} | ${rented(u).join(', ') || '—'} | ${u.facts?.gates.size ? 'yes' : 'no'} |`);

for (const u of units) {
  const o = u.outcomes; const f = u.facts;
  L.push('', `## ${u.name}`, '', `${u.kind}${u.type ? `, ${u.type}` : ''}, stack ${u.stack}, source ${u.file}.`);
  if (!o) L.push('', '**UNDESCRIBED** — export `outcomes: UnitOutcomes` from the source file.');

  L.push('', `**What comes in.** ${o?.in ?? ''}`, '', `- Triggered by: ${u.triggers.join('; ') || '—'}`);
  if (f?.gates.size) L.push(`- Tenant-row conditions it branches on: ${[...f.gates].map((g) => `\`${g}\``).join('; ')}`);

  L.push('', `**What goes out when it works.** ${o?.out ?? ''}`, '');
  if (f) {
    const effects = [...f.writes, ...[...f.emits].map((e) => `emits ${e}`), ...[...f.queues].map((q) => `sends to ${q}`), ...[...f.starts].map((s) => `starts ${s}`), ...[...f.harness].map((h) => `invokes ${h}`), ...f.posts];
    L.push(`- Side effects: ${effects.join('; ') || 'none'}`);
    if (f.markers.size) L.push(`- Once-marker: ${list(f.markers)}`);
  }
  for (const e of u.extra.filter((x) => x.startsWith('starts '))) L.push(`- ${e}`);

  L.push('', `**What else it leaves behind.** ${o?.also ?? ''}`, '');
  if (f) {
    L.push(`- Quiet exits: ${list(f.ok) || 'none'}`);
    const reads = [...f.tables].filter(([, ops]) => [...ops].some(isRead)).map(([t, ops]) => `${t} (${[...ops].filter(isRead).join(', ')})`);
    if (f.memory.has('retrieveMemoryRecords')) reads.push('caller memory');
    L.push(`- Reads: ${reads.join(', ') || 'none'}`);
  }

  L.push('', `**How it can end badly, and who hears.** ${o?.fails ?? ''}`, '');
  if (f) L.push(`- Failure exits: ${[...f.fail].map(([n, c]) => `${n}${c ? ` — ${c}` : ''}`).join('; ') || 'none'}`);
  L.push(`- Alarms: ${u.alarms.join('; ') || 'none'}`);
  if (u.dlq.length) L.push(`- Dead letters: ${u.dlq.join('; ')}`);
  L.push(`- Record: ${u.logging}${u.extra.includes('X-Ray tracing on') ? '; X-Ray tracing on' : ''}`);

  L.push('', '<details><summary>How (from the source file)</summary>', '');
  if (f) L.push(`- Calls out to: ${list(f.services) || 'nothing'}`);
  for (const e of u.extra.filter((x) => !x.startsWith('starts ') && x !== 'X-Ray tracing on')) L.push(`- ${e.charAt(0).toUpperCase()}${e.slice(1)}`);
  L.push('', u.how ?? '(no doc comment)', '', '</details>');
}

mkdirSync('tenant-profiles', { recursive: true });
writeFileSync('tenant-profiles/catalog.md', L.join('\n') + '\n');
console.log('tenant-profiles/catalog.md');
