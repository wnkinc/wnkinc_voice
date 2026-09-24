// src/entry/starter.ts
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

// ../shared/src/contracts.ts
var AUTOMATIONS = {
  /** lead.recorded -> the owner's email from their own Gmail, with what the CRM and memory already know. */
  leadEmail: { on: "lead.recorded" },
  /** lead.recorded -> the contact upserted, a note, a follow-up task the next business morning. */
  crmLead: { on: "lead.recorded" },
  /** call.ended -> a transcript note on the caller's contact, when they are already one. */
  crmCall: { on: "call.ended" },
  /** owner.notify -> the owner's Telegram. */
  ownerAlert: { on: "owner.notify" }
};
var PLATFORM_AUTOMATIONS = {
  /** call.ended -> the transcript into the caller's memory, the minutes metered. */
  callEnded: { on: "call.ended" }
};
var isAutomation = (name) => name in AUTOMATIONS || name in PLATFORM_AUTOMATIONS;

// src/rules/sms.ts
function parseForm(body) {
  const out = {};
  if (!body) return out;
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const key = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, " "));
    const value = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
    out[key] = value;
  }
  return out;
}
function isRoutable(sms) {
  return Boolean(sms.From && sms.To && sms.AccountSid && sms.MessageSid && sms.Body !== void 0);
}

// src/search-attributes.ts
import { defineSearchAttributeKey, SearchAttributeType } from "@temporalio/common";
var TENANT_ID = defineSearchAttributeKey("TenantId", SearchAttributeType.KEYWORD);

// src/version.ts
var TASK_QUEUE = "wnk-dev";

// ../shared/src/secrets.ts
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
var secrets = /* @__PURE__ */ new Map();
function jsonSecret(arn) {
  let p = secrets.get(arn);
  if (!p) {
    p = new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn })).then((r) => JSON.parse(r.SecretString ?? "{}"));
    p.catch(() => secrets.delete(arn));
    secrets.set(arn, p);
  }
  return p;
}

// src/activities/config.ts
function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// src/entry/temporal.ts
async function temporalConnection() {
  const s = await jsonSecret(env("TEMPORAL_SECRET_ARN"));
  for (const key of ["TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_API_KEY"]) if (!s[key]) throw new Error(`${key} is empty in the Temporal secret`);
  return { address: s.TEMPORAL_ADDRESS, namespace: s.TEMPORAL_NAMESPACE, apiKey: s.TEMPORAL_API_KEY };
}

// src/entry/starter.ts
var client;
async function connect() {
  const t = await temporalConnection();
  const connection = await Connection.connect({ address: t.address, tls: true, apiKey: t.apiKey });
  return new Client({ connection, namespace: t.namespace });
}
var handler = async (event) => {
  client ??= connect().catch((err) => {
    client = void 0;
    throw err;
  });
  const c = await client;
  for (const record of event.Records) {
    const sms = parseForm(record.body);
    if (!isRoutable(sms)) {
      console.log(JSON.stringify({ msg: "not a text; ignored", keys: Object.keys(sms) }));
      continue;
    }
    try {
      await c.workflow.start("smsTurn", { taskQueue: TASK_QUEUE, workflowId: `sms-${sms.MessageSid}`, args: [{ sms }], workflowIdReusePolicy: "REJECT_DUPLICATE" });
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        console.log(JSON.stringify({ msg: "already started", messageSid: sms.MessageSid }));
        continue;
      }
      throw err;
    }
  }
};
var telegram = async (event) => {
  client ??= connect().catch((err) => {
    client = void 0;
    throw err;
  });
  const c = await client;
  let update;
  try {
    update = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "{}");
  } catch {
    return { statusCode: 200, body: "" };
  }
  if (typeof update.update_id !== "number") return { statusCode: 200, body: "" };
  try {
    await c.workflow.start("telegramTurn", { taskQueue: TASK_QUEUE, workflowId: `telegram-${update.update_id}`, args: [update], workflowIdReusePolicy: "REJECT_DUPLICATE" });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
  return { statusCode: 200, body: "" };
};
var automation = async (event) => {
  const name = event.workflow;
  if (!isAutomation(name)) throw new Error(`not an automation: ${name}`);
  const d = event.detail;
  if (!d?.tenantId) throw new Error("the event names no tenant");
  const key = d.lead?.leadId ?? (name === "ownerAlert" ? `${d.callId}-${event.id ?? Date.now()}` : d.callId);
  client ??= connect().catch((err) => {
    client = void 0;
    throw err;
  });
  const c = await client;
  try {
    await c.workflow.start(name, {
      taskQueue: TASK_QUEUE,
      workflowId: `${name}-${d.tenantId}-${key}`,
      args: [d, event.options ?? {}],
      workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
      typedSearchAttributes: [{ key: TENANT_ID, value: d.tenantId }]
    });
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  }
};
export {
  automation,
  handler,
  telegram
};
//# sourceMappingURL=starter.js.map
