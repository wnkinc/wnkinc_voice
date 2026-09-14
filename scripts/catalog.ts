/**
 * Platform catalog: every service the platform runs, in plain language, with
 * the AWS and rented pieces each one touches.
 *
 *   npm run synth && npx tsx scripts/catalog.ts     -> tenant-profiles/catalog.md
 *
 * Two sources, neither maintained by hand for this purpose:
 *   - the synthesized CloudFormation in cdk.out (what actually deploys): state
 *     machines and their definitions, Lambdas, rules, routes, queues, alarms,
 *     logging. Resources, tables, endpoints, emitted events, tenant gates and
 *     once-markers are read out of the definitions, so they cannot drift.
 *   - the doc comment at the top of each workflow / Lambda source file: the
 *     "what it does" paragraph. A service without one shows as UNDESCRIBED.
 * Nothing tenant-specific here; tenant-profile.ts is the per-tenant view.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

type Json = any;
const manifest = JSON.parse(readFileSync('cdk.out/manifest.json', 'utf8'));
const stackNames: string[] = Object.entries(manifest.artifacts).filter(([, a]: any) => a.type === 'aws:cloudformation:stack').map(([k]) => k);
const resources: Record<string, { stack: string; type: string; props: Json; path?: string }> = {};
for (const s of stackNames) {
  const t = JSON.parse(readFileSync(`cdk.out/${s}.template.json`, 'utf8'));
  for (const [id, r] of Object.entries<Json>(t.Resources)) resources[id] = { stack: s, type: r.Type, props: r.Properties ?? {}, path: r.Metadata?.['aws:cdk:path'] };
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

// ---- Descriptions from source doc comments ---------------------------------
const kebab = (id: string) => id.replace(/Workflow$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
function docComment(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, 'utf8').match(/^\/\*\*([\s\S]*?)\*\//);
  return m?.[1]?.split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim();
}

// ---- Walk a state machine definition -----------------------------------------
interface Facts { services: Set<string>; tables: Map<string, Set<string>>; emits: Set<string>; gates: Set<string>; markers: Set<string>; starts: Set<string>; queues: Set<string>; harness: Set<string>; memory: Set<string> }
const host = (url: string) => (url.match(/https?:\/\/([^/'"\s]+)/)?.[1] ?? url);
const RENTED: Record<string, string> = { 'backend.composio.dev': 'Composio', 'api.openai.com': 'OpenAI Realtime', 'api.browserbase.com': 'Browserbase', 'api.telegram.org': 'Telegram' };
function walk(states: Json, f: Facts) {
  for (const st of Object.values<Json>(states ?? {})) {
    if (st.Branches) st.Branches.forEach((b: Json) => walk(b.States, f));
    if (st.ItemProcessor) walk(st.ItemProcessor.States, f);
    for (const c of st.Choices ?? []) if (/\$tenant\./.test(c.Condition ?? '')) f.gates.add(c.Condition.replace(/^\{% |%\}$/g, '').trim());
    const res: string = st.Resource ?? '';
    const a = st.Arguments ?? st.Parameters ?? {};
    if (res.includes(':dynamodb:')) {
      const op = res.split(':').pop()!; const table = pretty(a.TableName ?? '?');
      f.services.add('DynamoDB'); (f.tables.get(table) ?? f.tables.set(table, new Set()).get(table)!).add(op);
      const k = a.ExpressionAttributeNames?.['#k']; if (k && /done:/.test(k)) f.markers.add(k.replace(/^\{% |%\}$/g, '').trim());
    } else if (res.includes(':events:putEvents')) {
      f.services.add('EventBridge'); for (const e of a.Entries ?? []) f.emits.add(e.DetailType);
    } else if (res.includes(':http:invoke')) {
      const h = host(a.ApiEndpoint ?? ''); const label = RENTED[h] ?? h;
      const tool = (a.ApiEndpoint ?? '').match(/tools\/execute\/([A-Z_]+)/)?.[1];
      f.services.add(tool ? `${label} (${tool})` : `${label} (${(a.ApiEndpoint ?? '').replace(/^\{% '|' & .*$/g, '').replace(/^https?:\/\/[^/]+/, '') || '/'})`);
    } else if (res.includes(':bedrockagentcore:invokeHarness')) { f.services.add('AgentCore Runtime (harness)'); f.harness.add(pretty(a.HarnessId ?? a.HarnessArn ?? '?')); }
    else if (res.includes(':bedrockagentcore:')) { f.services.add('AgentCore Memory'); f.memory.add(res.split(':').pop()!); }
    else if (res.includes(':sqs:')) { f.services.add('SQS'); f.queues.add(pretty(a.QueueUrl ?? '?')); }
    else if (res.includes(':states:startExecution')) { f.services.add('Step Functions'); f.starts.add(pretty(a.StateMachineArn ?? '?')); }
    else if (res.includes(':lambda:')) { f.services.add('Lambda'); }
  }
}

// ---- Services: state machines, Lambdas, the harness -------------------------
interface Service { id: string; kind: string; name: string; stack: string; description?: string; triggers: string[]; facts?: Facts; type?: string; logging?: string; alarms: string[]; extra: string[] }
const services: Service[] = [];
const byArn: Record<string, Service> = {};

for (const [id, r] of Object.entries(resources)) {
  if (r.type === 'AWS::StepFunctions::StateMachine') {
    const def = JSON.parse(flat(r.props.DefinitionString));
    const f: Facts = { services: new Set(), tables: new Map(), emits: new Set(), gates: new Set(), markers: new Set(), starts: new Set(), queues: new Set(), harness: new Set(), memory: new Set() };
    walk(def.States, f);
    const lc = r.props.LoggingConfiguration;
    const type = r.props.StateMachineType === 'EXPRESS' ? 'Express' : 'Standard';
    const s: Service = {
      id, kind: 'Step Functions workflow', name: r.props.StateMachineName, stack: r.stack, triggers: [], facts: f, type, alarms: [], extra: [],
      description: docComment(`packages/infrastructure/workflows/${kebab(construct(id))}.ts`),
      logging: lc ? `CloudWatch Logs, level ${lc.Level}, execution data ${lc.IncludeExecutionData ? 'included' : 'not logged'}` : `${type === 'Standard' ? 'Step Functions execution history (90 days)' : 'none'}`,
    };
    if (r.props.TracingConfiguration?.Enabled) s.extra.push('X-Ray tracing on');
    services.push(s); byArn[id] = s;
  } else if (r.type === 'AWS::Lambda::Function' && !/^AWS[0-9a-f]{32}/.test(id)) {
    const s: Service = { id, kind: 'Lambda', name: r.props.FunctionName ?? construct(id), stack: r.stack, triggers: [], alarms: [], extra: [], description: docComment(`packages/voice-session/src/${construct(id)}.ts`) };
    const env = r.props.Environment?.Variables ?? {};
    for (const [k, v] of Object.entries<Json>(env)) { const t = refId(v); if (t && resources[t]?.type === 'AWS::StepFunctions::StateMachine') s.extra.push(`starts ${resources[t].props.StateMachineName} (${k})`); }
    s.extra.push(`tables: ${Object.entries<Json>(env).filter(([k]) => k.endsWith('_TABLE')).map(([, v]) => pretty(flat(v))).join(', ') || 'none'}`);
    if (r.props.Timeout) s.extra.push(`timeout ${r.props.Timeout}s`);
    if (r.props.TracingConfig?.Mode === 'Active') s.extra.push('X-Ray tracing on');
    services.push(s); byArn[id] = s;
  } else if (r.type === 'AWS::BedrockAgentCore::Harness') {
    const p = r.props; const model = Object.values<Json>(p.Model ?? {})[0] ?? {}; const mem = p.Memory?.AgentCoreMemoryConfiguration;
    services.push({ id, kind: 'AgentCore harness', name: p.HarnessName, stack: r.stack, triggers: [], alarms: [], extra: [
      `model ${model.ModelId ?? '?'} (${model.ApiFormat ?? '?'} API, max ${model.MaxTokens ?? '?'} tokens), key from AgentCore Identity`, `max ${p.MaxIterations} iterations`, `allowed tools ${(p.AllowedTools ?? []).join(', ')}`,
      mem ? `memory ${pretty(flat(mem.Arn))}: last ${mem.MessagesCount} messages + ${Object.keys(mem.RetrievalConfig ?? {}).join(', ')}` : 'no memory',
    ], description: 'Rented agent loop for "My Assistant". The Telegram workflow invokes it per message with the tenant\'s prompt and Composio MCP session; the model never chooses the tenant.' });
    byArn[id] = services.at(-1)!;
  }
}

// ---- Triggers: rules, routes, queues, other machines, Lambdas ---------------
for (const [id, r] of Object.entries(resources)) {
  if (r.type === 'AWS::Events::Rule') {
    for (const t of r.props.Targets ?? []) {
      const s = byArn[refId(t.Arn) ?? '']; if (!s) continue;
      const p = r.props.EventPattern; const rp = t.RetryPolicy;
      const what = r.props.ScheduleExpression ? `schedule ${r.props.ScheduleExpression}` : `bus event ${(p?.source ?? []).join('|')} / ${(p?.['detail-type'] ?? ['*']).join('|')}`;
      s.triggers.push(`${what}${rp ? ` (retry ${rp.MaximumRetryAttempts}, max age ${rp.MaximumEventAgeInSeconds / 60}m` : ''}${t.DeadLetterConfig ? `, DLQ ${construct(refId(t.DeadLetterConfig.Arn)!)}` : ''}${rp ? ')' : ''}`);
    }
  } else if (r.type === 'AWS::ApiGatewayV2::Route') {
    const integ = resources[flat(r.props.Target).replace(/^integrations\/«|»$/g, '')];
    const target = refId(integ?.props.RequestParameters?.StateMachineArn) ?? (integ?.props.IntegrationUri && Object.keys(resources).find((k) => flat(integ.props.IntegrationUri).includes(`«${k}»`)));
    const s = byArn[target ?? '']; if (s) s.triggers.push(`HTTP ${pretty(flat(r.props.RouteKey)).replace(/\{\{resolve:secretsmanager:[^}]+\}\}/, '<secret path>')}`);
  } else if (r.type === 'AWS::Lambda::EventSourceMapping') {
    const s = byArn[refId(r.props.FunctionName) ?? '']; if (s) s.triggers.push(`SQS ${construct(refId(r.props.EventSourceArn)!)} (batch ${r.props.BatchSize ?? 10})`);
  } else if (r.type === 'AWS::CloudWatch::Alarm') {
    for (const d of r.props.Dimensions ?? []) { const s = byArn[refId(d.Value) ?? '']; if (s) s.alarms.push(`${r.props.MetricName}: ${r.props.AlarmDescription ?? ''}`); }
  }
}
for (const s of services) {
  for (const target of s.facts?.starts ?? []) { const t = services.find((x) => x.name.endsWith(target) || construct(x.id) === target); if (t) t.triggers.push(`started by ${s.name}`); }
  for (const e of s.extra) { const m = e.match(/^starts (\S+)/); const t = m && services.find((x) => x.name === m[1]); if (t) t.triggers.push(`started by ${s.name}`); }
  for (const q of s.facts?.queues ?? []) { const t = services.find((x) => x.triggers.some((tr) => tr.startsWith(`SQS ${q}`))); if (t) t.triggers.push(`fed by ${s.name} via ${q}`); }
  for (const h of s.facts?.harness ?? []) { const t = services.find((x) => x.kind === 'AgentCore harness'); if (t) t.triggers.push(`invoked by ${s.name}`); }
}

// ---- Render ------------------------------------------------------------------
const order = ['webhook', 'accept', 'session', 'call-ended', 'lead-email', 'crm-lead', 'crm-call', 'owner-alert', 'telegram', 'assistant', 'browser-login', 'composio-health'];
services.sort((a, b) => order.findIndex((o) => a.name.includes(o)) - order.findIndex((o) => b.name.includes(o)));
const rented = (s: Service) => [...(s.facts?.services ?? [])].map((x) => x.replace(/ \(.*\)$/, '')).filter((x, i, arr) => arr.indexOf(x) === i);

const L: string[] = [`# Platform catalog`, '', `Generated from cdk.out (${stackNames.join(', ')}) and source doc comments. ${services.length} services.`, '',
  '| Service | Kind | Triggered by | Rented pieces | Tenant gate |', '|---|---|---|---|---|'];
for (const s of services) L.push(`| ${s.name} | ${s.kind} | ${s.triggers[0] ?? '—'} | ${rented(s).join(', ') || '—'} | ${s.facts?.gates.size ? 'yes' : 'no'} |`);

for (const s of services) {
  L.push('', `## ${s.name}`, '', `${s.kind}${s.type ? `, ${s.type}` : ''}, stack ${s.stack}.`, '', s.description ?? '**UNDESCRIBED** — add a doc comment at the top of the source file.', '');
  L.push(`- Triggered by: ${s.triggers.join('; ') || '—'}`);
  if (s.facts) {
    const f = s.facts;
    L.push(`- Calls out to: ${[...f.services].join(', ') || 'nothing'}`);
    if (f.tables.size) L.push(`- Tables: ${[...f.tables].map(([t, ops]) => `${t} (${[...ops].join(', ')})`).join(', ')}`);
    if (f.emits.size) L.push(`- Emits: ${[...f.emits].join(', ')}`);
    if (f.memory.size) L.push(`- Caller memory: ${[...f.memory].join(', ')}`);
    L.push(`- Tenant gate: ${f.gates.size ? [...f.gates].map((g) => `\`${g}\``).join('; ') : 'none (acts for every tenant the event names)'}`);
    L.push(`- Once-marker: ${f.markers.size ? [...f.markers].join(', ') : 'none'}`);
    L.push(`- Logging: ${s.logging}`);
  }
  for (const e of s.extra) L.push(`- ${e.charAt(0).toUpperCase()}${e.slice(1)}`);
  L.push(`- Alarms: ${s.alarms.join('; ') || 'none'}`);
}

mkdirSync('tenant-profiles', { recursive: true });
writeFileSync('tenant-profiles/catalog.md', L.join('\n') + '\n');
console.log('tenant-profiles/catalog.md');
