var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/entry/handler.ts
import { fileURLToPath } from "node:url";
import { runWorker } from "@temporalio/lambda-worker";

// src/activities/index.ts
var activities_exports = {};
__export(activities_exports, {
  browserLiveView: () => browserLiveView,
  callModel: () => callModel,
  cancelDraft: () => cancelDraft,
  claimLoginWindow: () => claimLoginWindow,
  clearLoginWindow: () => clearLoginWindow,
  composioAccounts: () => composioAccounts,
  composioProxy: () => composioProxy,
  composioToolDefs: () => composioToolDefs,
  createBrowserContext: () => createBrowserContext,
  createDraft: () => createDraft,
  describeImages: () => describeImages,
  describePhotoRows: () => describePhotoRows,
  echo: () => echo,
  executeTool: () => executeTool,
  findPending: () => findPending,
  listPhotos: () => listPhotos,
  listTenants: () => listTenants,
  loadHistory: () => loadHistory,
  lockDraft: () => lockDraft,
  lookupPerson: () => lookupPerson,
  lookupTenant: () => lookupTenant,
  markCompleted: () => markCompleted,
  markDone: () => markDone,
  markFailed: () => markFailed,
  markPhotosPosted: () => markPhotosPosted,
  markShown: () => markShown,
  markUnconfirmed: () => markUnconfirmed,
  presign: () => presign,
  putPhotos: () => putPhotos,
  readCall: () => readCall,
  recall: () => recall,
  recallPreferences: () => recallPreferences,
  recordMeter: () => recordMeter,
  recordUsage: () => recordUsage,
  releaseBrowserSession: () => releaseBrowserSession,
  rememberCall: () => rememberCall,
  reviseDraft: () => reviseDraft,
  saveBrowserContext: () => saveBrowserContext,
  saveTurn: () => saveTurn,
  sendTelegram: () => sendTelegram,
  sendText: () => sendText,
  startBrowserSession: () => startBrowserSession,
  storePhotos: () => storePhotos
});

// src/activities/clients.ts
import { DynamoDBClient as DynamoDBClient2 } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient as DynamoDBDocumentClient2 } from "@aws-sdk/lib-dynamodb";

// ../shared/src/composio-api.ts
var COMPOSIO_API = "https://backend.composio.dev/api/v3.1/";
function composioApi(apiKey) {
  const call = async (path, init, what) => {
    const res = await fetch(`${COMPOSIO_API}${path}`, { ...init, headers: { "x-api-key": await apiKey(), "content-type": "application/json", ...init.headers ?? {} } });
    if (!res.ok) throw new Error(`Composio ${what}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  return {
    async executeTool(tenantId, slug, args, opts = {}) {
      if (!tenantId) throw new Error("executeTool: no tenant");
      return await call(`tools/execute/${slug}`, { method: "POST", body: JSON.stringify({ user_id: tenantId, arguments: args, ...opts.version ? { version: opts.version } : {} }), signal: opts.signal }, slug);
    },
    async accounts(tenantId, opts = {}) {
      if (!tenantId) throw new Error("composioAccounts: no tenant");
      const q = new URLSearchParams({ user_ids: tenantId, statuses: "ACTIVE", ...opts.toolkit ? { toolkit_slugs: opts.toolkit } : {} });
      const body = await call(`connected_accounts?${q}`, { signal: opts.signal }, "connected_accounts");
      return (body.items ?? []).map((i) => ({ id: i.id, toolkit: i.toolkit?.slug ?? "" }));
    },
    async toolSchemas(slugs, signal) {
      if (slugs.length === 0) return [];
      const body = await call(`tools?${new URLSearchParams({ tool_slugs: slugs.join(",") })}`, { signal }, "tools");
      const bySlug = new Map((body.items ?? []).map((i) => [i.slug, i]));
      const missing = slugs.filter((s) => !bySlug.has(s));
      if (missing.length) throw new Error(`Composio has no tool ${missing.join(", ")}`);
      const newest = (v = []) => v.filter((x) => /^\d{8}_\d{2}$/.test(x) && x !== "00000000_00").sort().at(-1);
      return slugs.map((s) => {
        const i = bySlug.get(s);
        const version = newest(i.available_versions);
        return { slug: s, description: i.description ?? s, parameters: i.input_parameters ?? { type: "object", properties: {} }, ...version ? { version } : {} };
      });
    },
    async proxy(tenantId, accountId, method, endpoint, body, signal) {
      if (!tenantId || !accountId) throw new Error("composioProxy: no tenant or account");
      return await call("tools/execute/proxy", { method: "POST", body: JSON.stringify({ endpoint, method, connected_account_id: accountId, ...body ? { body } : {} }), signal }, `proxy ${endpoint}`);
    }
  };
}

// ../shared/src/memory.ts
import { BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand, RetrieveMemoryRecordsCommand } from "@aws-sdk/client-bedrock-agentcore";
function callerMemory(memoryId) {
  const client = new BedrockAgentCoreClient({});
  const texts = (r) => (r.memoryRecordSummaries ?? []).flatMap((m) => m.content?.text ? [m.content.text] : []);
  return {
    async retrieve(actorId, namespace, query, topK, signal) {
      if (!memoryId) return [];
      const r = await client.send(new RetrieveMemoryRecordsCommand({ memoryId, namespacePath: `/callers/${actorId}${namespace}`, searchCriteria: { searchQuery: query, topK } }), { abortSignal: signal });
      return texts(r);
    },
    async history(actorId, sessionId, max = 20) {
      if (!memoryId) return [];
      const r = await client.send(new ListEventsCommand({ memoryId, actorId, sessionId, includePayloads: true, maxResults: max }));
      return (r.events ?? []).sort((a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0)).flatMap((e) => (e.payload ?? []).flatMap((p) => p.conversational?.role && p.conversational.content?.text ? [{ role: p.conversational.role.toLowerCase(), text: p.conversational.content.text }] : []));
    },
    async write(actorId, sessionId, lines) {
      if (!memoryId || lines.length === 0) return;
      await client.send(new CreateEventCommand({
        memoryId,
        actorId,
        sessionId,
        eventTimestamp: /* @__PURE__ */ new Date(),
        payload: lines.map((l) => ({ conversational: { role: l.role === "user" ? "USER" : "ASSISTANT", content: { text: l.text } } }))
      }));
    }
  };
}

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
async function secretValue(arn, key) {
  const v = (await jsonSecret(arn))[key];
  if (!v) throw new Error(`${key} is not filled in (secret ${arn.split(":").pop()})`);
  return v;
}

// ../shared/src/store.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// ../shared/src/config.ts
var env = {
  get tenantsTable() {
    return process.env.TENANTS_TABLE ?? "";
  },
  get callsTable() {
    return process.env.CALLS_TABLE ?? "";
  },
  get peopleTable() {
    return process.env.PEOPLE_TABLE ?? "";
  },
  get eventBusName() {
    return process.env.EVENT_BUS_NAME ?? "";
  },
  get eventSource() {
    return process.env.EVENT_SOURCE ?? "wnkinc.voice";
  },
  get openaiSecretArn() {
    return process.env.OPENAI_SECRET_ARN ?? "";
  }
};

// ../shared/src/types.ts
import { z } from "zod";

// ../shared/src/contracts.ts
var ASSISTANT_TOOL_NAMES = ["draft_facebook_post", "cancel_facebook_draft"];
var ACTION_APPROVAL_WORDS = { facebook_post: "POST" };
var ACTION_STATUSES = ["pending", "executing", "completed", "failed", "rejected"];

// ../shared/src/types.ts
var E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164 (+15555550100)");
var PhotoRefSchema = z.object({ sk: z.string(), key: z.string(), description: z.string() });
var ActionSchema = z.object({
  tenantId: z.string().min(1),
  sk: z.string().min(1),
  type: z.enum(Object.keys(ACTION_APPROVAL_WORDS)),
  status: z.enum(ACTION_STATUSES),
  /** Channel id (`sms:<e164>`) of the person who may approve it. */
  approver: z.string().min(1),
  proposedBy: z.literal("assistant"),
  /** Bumped on every change to the payload. Approval counts only when `shownRevision` equals it. */
  revision: z.number().int().positive(),
  /** The revision last texted to the approver, word for word from this row; 0 before the first send. */
  shownRevision: z.number().int().nonnegative(),
  shownAt: z.string().optional(),
  /** Epoch seconds after which a pending row can no longer be approved. */
  approveBy: z.number().int().positive(),
  payload: z.object({
    caption: z.string(),
    /** The photos it goes out with, by row; their links are presigned when needed, never stored. */
    media: z.array(PhotoRefSchema)
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvedAt: z.string().optional(),
  approvedBy: z.string().optional(),
  /** The approver's message as received. */
  approvalText: z.string().optional(),
  completedAt: z.string().optional(),
  result: z.object({ postId: z.string() }).optional(),
  error: z.string().optional(),
  /** Table TTL (epoch seconds): when the log row itself is deleted. */
  expiresAt: z.number().int().positive()
});
var PersonSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["owner", "employee"]),
  /** Telegram user id (numeric; the bot sees it on every message). */
  telegramId: z.number().int().positive().optional(),
  /** Mobile number, the identity for SMS (the person texts the tenant's number). */
  phone: E164.optional()
});
function channelKey(channel, id) {
  return `${channel}:${id}`;
}
function personChannelKeys(p) {
  const keys = [];
  if (p.telegramId !== void 0) keys.push(channelKey("telegram", p.telegramId));
  if (p.phone) keys.push(channelKey("sms", p.phone));
  return keys;
}
var TenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  phoneNumber: E164,
  active: z.boolean().default(true),
  /**
   * Minutes to subtract from UTC so that calendar days roll at 3 AM in the
   * tenant's timezone — the assistant starts a fresh conversation session each
   * day at that cutoff. COMPUTED by the seed from `business.timezone` (Step
   * Functions cannot evaluate IANA zones); reflects DST as of the last seed, so
   * the cutoff drifts an hour across DST changes until the next re-seed. Not in the file.
   */
  sessionDayOffsetMinutes: z.number().int().optional(),
  /** The business facts every service draws on: the receptionist's prompt, the assistant's prompt, the lead email, the CRM notes. */
  business: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    services: z.array(z.string()).default([]),
    hours: z.string().optional(),
    timezone: z.string().default("America/Los_Angeles")
  }),
  /**
   * Humans allowed to talk to this tenant's assistant, with the channel
   * identities that prove who they are. Telegram vouches for the user id on
   * every message; a phone number is the SMS identity (later). The seed script
   * mirrors each identity into the People table, which is what a channel
   * workflow looks up — an identity not listed here reaches nothing.
   */
  people: z.array(PersonSchema).default([]),
  /**
   * The phone receptionist (OpenAI Realtime over SIP). `session` is passed to
   * OpenAI as the session config under these same keys; `instructions` names
   * what the platform composes into the session's instructions string alongside
   * `business`; the greeting is spoken through a separate response request on
   * connect; the call cap is ours (the session Lambda's deadline), not OpenAI's.
   * Every lever the platform has built appears here with its default; the
   * levers table in packages/receptionist/README.md lists the rest.
   */
  receptionist: z.object({
    session: z.object({
      model: z.string().default("gpt-realtime-2.1"),
      audio: z.object({
        output: z.object({ voice: z.string().default("marin") }).prefault({})
      }).prefault({}),
      /** Tool names (see receptionist/src/agent.ts) enabled for this tenant. */
      tools: z.array(z.string()).default(["record_lead", "notify_owner", "end_call"])
    }).prefault({}),
    instructions: z.object({
      agentName: z.string().default("Alex"),
      /** Free-form additions appended to the generated system prompt. */
      extra: z.string().optional()
    }).prefault({}),
    /** Spoken verbatim when the call connects. Defaults to a template if omitted. */
    greeting: z.string().optional(),
    /** Hard cap; the agent is asked to wrap up and the call is hung up after this. The session Lambda's 15-minute timeout is the ceiling. */
    maxCallSeconds: z.number().int().positive().max(840).default(600)
  }).prefault({}),
  /**
   * CRM. `via: composio` (the target state) means the owner consented in
   * HubSpot through Composio and the credential lives in Composio's vault under
   * this tenant id. `via: token` is the legacy private-app token in Secrets
   * Manager at `<CRM_SECRET_PREFIX><tenantId>`, removed at the cutover.
   */
  crm: z.object({ type: z.literal("hubspot"), via: z.enum(["token", "composio"]).default("token") }).optional(),
  // ---- Platform services, one block each. Every agent checks its own block's
  // `enabled` before acting and refuses otherwise (fail closed). A service's
  // own data (minted URLs, ids) lives in its block. Adding a service adds a
  // block here; onboarding a tenant sets the blocks — nothing else.
  /** Owner follow-up email per lead, sent from the owner's Gmail through Composio. */
  emailResponder: z.object({ enabled: z.boolean().default(false) }).prefault({}),
  /** Chat assistant for the tenant's own people, over Telegram and SMS. */
  assistant: z.object({
    enabled: z.boolean().default(false),
    /**
     * The tools this tenant's assistant may use, by name from
     * ASSISTANT_TOOL_NAMES: the allow-list the loop's Gate state enforces.
     * Each runs through Composio naming the tenant, so a tool needs the
     * matching connected account (HubSpot for the CRM tools). Empty means
     * the assistant answers from the prompt and memory alone.
     */
    tools: z.array(z.enum(ASSISTANT_TOOL_NAMES)).default([]),
    /**
     * The Composio toolkits this tenant's assistant reaches natively, each with
     * the tool slugs it may use: `{ googlecalendar: ['GOOGLECALENDAR_FIND_EVENT', ...] }`.
     * The model sees Composio's own descriptions and schemas for exactly these;
     * each call the model makes runs as the worker's own activity, as the tenant.
     * The connection canary expects each toolkit ACTIVE; the consent is the same
     * connect script. The catalog (`tools` above) is for a tool that needs our
     * own shaping.
     */
    composioTools: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({})
  }).prefault({}),
  /**
   * Posts to the business's Facebook Page, drafted by the assistant over SMS
   * and published only on the person's POST (the Actions ledger). Needs the
   * Facebook consent (`scripts/connect-composio.mts <id> facebook`) and the
   * `draft_facebook_post` / `cancel_facebook_draft` assistant tools.
   */
  facebookPosts: z.object({
    enabled: z.boolean().default(false),
    /** The Page's numeric id and its name as the draft message states it (FACEBOOK_GET_USER_PAGES after the consent). */
    pageId: z.string().regex(/^\d+$/).optional(),
    pageName: z.string().min(1).optional()
  }).prefault({}).refine((f) => !f.enabled || f.pageId && f.pageName, "facebookPosts.enabled needs pageId and pageName"),
  /** A saved browser for the business: the owner signs into sites over a live view (`/login` on Telegram); logins persist in Browserbase. */
  browser: z.object({
    enabled: z.boolean().default(false),
    /**
     * The tenant's saved browser: a Browserbase context (cookies and logins,
     * encrypted in their vault) created by the browser-login workflow on the
     * owner's first `/login` and written to the row. Copy it into the file when
     * the workflow says so; a re-seed without it starts a fresh browser.
     */
    contextId: z.string().optional(),
    /** Owned by whoever holds the browser (the browser-login workflow today): ISO time until which a window is open on it, one at a time. Cleared at release; a re-seed clears it too. */
    loginUntil: z.string().optional()
  }).prefault({})
});

// ../shared/src/store.ts
function peopleRecords(tenant) {
  return tenant.people.flatMap((p) => personChannelKeys(p).map((channelId) => ({ channelId, tenantId: tenant.tenantId, tenantPhone: tenant.phoneNumber, name: p.name, role: p.role })));
}
function dynamoStore(client) {
  const db = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const table2 = (name, value) => {
    if (!value) throw new Error(`${name} not set`);
    return value;
  };
  const tenants = () => table2("TENANTS_TABLE", env.tenantsTable);
  const calls = () => table2("CALLS_TABLE", env.callsTable);
  const people = () => table2("PEOPLE_TABLE", env.peopleTable);
  const appendList = (callId, attr, item) => db.send(new UpdateCommand({
    TableName: calls(),
    Key: { callId },
    UpdateExpression: `SET ${attr} = list_append(if_not_exists(${attr}, :empty), :e)`,
    ExpressionAttributeValues: { ":empty": [], ":e": [item] }
  }));
  return {
    async getTenant(phoneNumber) {
      const res = await db.send(new GetCommand({ TableName: tenants(), Key: { phoneNumber } }));
      return res.Item ? TenantConfigSchema.parse(res.Item) : void 0;
    },
    async listTenants() {
      const res = await db.send(new ScanCommand({ TableName: tenants() }));
      return (res.Items ?? []).map((i) => TenantConfigSchema.parse(i));
    },
    async getPerson(channelId) {
      const res = await db.send(new GetCommand({ TableName: people(), Key: { channelId } }));
      return res.Item;
    },
    async putTenant(input) {
      const tenant = TenantConfigSchema.parse(input);
      await db.send(new PutCommand({ TableName: tenants(), Item: tenant }));
      return tenant;
    },
    async syncPeople(tenant) {
      const wanted = peopleRecords(tenant);
      const existing = await db.send(new ScanCommand({
        TableName: people(),
        FilterExpression: "tenantId = :t",
        ExpressionAttributeValues: { ":t": tenant.tenantId }
      }));
      const keep = new Set(wanted.map((p) => p.channelId));
      for (const item of existing.Items ?? []) {
        if (!keep.has(item.channelId)) await db.send(new DeleteCommand({ TableName: people(), Key: { channelId: item.channelId } }));
      }
      for (const p of wanted) await db.send(new PutCommand({ TableName: people(), Item: p }));
      return wanted;
    },
    async getCall(callId) {
      const res = await db.send(new GetCommand({ TableName: calls(), Key: { callId } }));
      return res.Item;
    },
    async setCallStatus(callId, status, extra = {}) {
      const names = { "#status": "status" };
      const values = { ":status": status };
      const sets = ["#status = :status"];
      for (const [k, v] of Object.entries(extra)) {
        if (v === void 0) continue;
        names[`#${k}`] = k;
        values[`:${k}`] = v;
        sets.push(`#${k} = :${k}`);
      }
      await db.send(new UpdateCommand({
        TableName: calls(),
        Key: { callId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values
      }));
    },
    appendTranscript: (callId, entry) => appendList(callId, "transcript", entry).then(() => {
    }),
    appendToolCall: (callId, tc) => appendList(callId, "toolCalls", tc).then(() => {
    }),
    async findTenantById(tenantId) {
      const res = await db.send(new ScanCommand({
        TableName: tenants(),
        FilterExpression: "tenantId = :t",
        ExpressionAttributeValues: { ":t": tenantId }
      }));
      const item = res.Items?.[0];
      return item ? TenantConfigSchema.parse(item) : void 0;
    }
  };
}

// src/activities/config.ts
function env2(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var epoch = () => Math.floor(Date.now() / 1e3);

// src/activities/clients.ts
var ddb = DynamoDBDocumentClient2.from(new DynamoDBClient2({}), { marshallOptions: { removeUndefinedValues: true } });
var store = dynamoStore(ddb);
var composio = composioApi(() => secretValue(env2("COMPOSIO_SECRET_ARN"), "COMPOSIO_API_KEY"));
var memory = callerMemory(process.env.MEMORY_ID);

// src/activities/identity.ts
var lookupPerson = (channelId) => store.getPerson(channelId);
var lookupTenant = (phoneNumber) => store.getTenant(phoneNumber);

// src/activities/ledger.ts
import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand as PutCommand2, QueryCommand, UpdateCommand as UpdateCommand2 } from "@aws-sdk/lib-dynamodb";

// src/rules/facebook.ts
var ACTION_TYPE = "facebook_post";
var APPROVAL_WORD = ACTION_APPROVAL_WORDS.facebook_post;
var APPROVAL_HOURS = 48;
var LOG_DAYS = 400;
var PHOTO_LIST_DAYS = 7;
var PHOTO_LIST_MAX = 20;

// src/activities/ledger.ts
var table = () => env2("ACTIONS_TABLE");
var conditional = async (run) => {
  try {
    await run();
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
};
async function findPending(tenantId, approver) {
  const r = await ddb.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: "tenantId = :t AND begins_with(sk, :p)",
    FilterExpression: "#s = :pending AND approveBy > :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":t": tenantId, ":p": `${approver}#${ACTION_TYPE}#`, ":pending": "pending", ":now": epoch() },
    ScanIndexForward: false
  }));
  return r.Items?.[0];
}
async function createDraft(tenantId, approver, caption, media) {
  const at = now();
  const sk = `${approver}#${ACTION_TYPE}#${at}#${randomUUID().slice(0, 8)}`;
  await ddb.send(new PutCommand2({
    TableName: table(),
    ConditionExpression: "attribute_not_exists(sk)",
    Item: {
      tenantId,
      sk,
      type: ACTION_TYPE,
      status: "pending",
      approver,
      proposedBy: "assistant",
      revision: 1,
      shownRevision: 0,
      approveBy: epoch() + APPROVAL_HOURS * 3600,
      payload: { caption, media },
      createdAt: at,
      updatedAt: at,
      expiresAt: epoch() + LOG_DAYS * 86400
    }
  }));
  return { sk };
}
function reviseDraft(tenantId, sk, revision, caption, media) {
  return conditional(() => ddb.send(new UpdateCommand2({
    TableName: table(),
    Key: { tenantId, sk },
    UpdateExpression: "SET payload = :payload, revision = revision + :one, approveBy = :by, updatedAt = :now",
    ConditionExpression: "#s = :pending AND revision = :rev",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":payload": { caption, media }, ":one": 1, ":rev": revision, ":pending": "pending", ":by": epoch() + APPROVAL_HOURS * 3600, ":now": now() }
  })));
}
function cancelDraft(tenantId, sk) {
  return conditional(() => ddb.send(new UpdateCommand2({
    TableName: table(),
    Key: { tenantId, sk },
    UpdateExpression: "SET #s = :rejected, updatedAt = :now",
    ConditionExpression: "#s = :pending",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":rejected": "rejected", ":pending": "pending", ":now": now() }
  })));
}
function lockDraft(tenantId, sk, revision, approver, approvalText) {
  return conditional(() => ddb.send(new UpdateCommand2({
    TableName: table(),
    Key: { tenantId, sk },
    UpdateExpression: "SET #s = :executing, approvedAt = :now, approvedBy = :who, approvalText = :text, updatedAt = :now",
    ConditionExpression: "#s = :pending AND revision = :rev AND shownRevision = :rev AND approveBy > :epoch",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":executing": "executing", ":pending": "pending", ":now": now(), ":who": approver, ":text": approvalText, ":rev": revision, ":epoch": epoch() }
  })));
}
function markShown(tenantId, sk, revision) {
  return conditional(() => ddb.send(new UpdateCommand2({
    TableName: table(),
    Key: { tenantId, sk },
    UpdateExpression: "SET shownRevision = :rev, shownAt = :now",
    ConditionExpression: "#s = :pending AND revision = :rev",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":rev": revision, ":pending": "pending", ":now": now() }
  })));
}
async function markCompleted(tenantId, sk, postId) {
  await ddb.send(new UpdateCommand2({
    TableName: table(),
    Key: { tenantId, sk },
    UpdateExpression: "SET #s = :completed, completedAt = :now, #r = :result, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status", "#r": "result" },
    ExpressionAttributeValues: { ":completed": "completed", ":now": now(), ":result": { postId } }
  }));
}
async function markFailed(tenantId, sk, error) {
  await ddb.send(new UpdateCommand2({
    TableName: table(),
    Key: { tenantId, sk },
    UpdateExpression: "SET #s = :failed, #e = :error, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status", "#e": "error" },
    ExpressionAttributeValues: { ":failed": "failed", ":error": error.slice(0, 500), ":now": now() }
  }));
}
async function markUnconfirmed(tenantId, sk) {
  await ddb.send(new UpdateCommand2({
    TableName: table(),
    Key: { tenantId, sk },
    UpdateExpression: "SET #e = :error, updatedAt = :now",
    ExpressionAttributeNames: { "#e": "error" },
    ExpressionAttributeValues: { ":error": "outcome unknown: the publish call did not answer", ":now": now() }
  }));
}
async function putPhotos(rows) {
  for (const row of rows) await ddb.send(new PutCommand2({ TableName: table(), Item: row }));
}
async function listPhotos(tenantId, approver) {
  const since = new Date(Date.now() - PHOTO_LIST_DAYS * 864e5).toISOString();
  const r = await ddb.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: "tenantId = :t AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: { ":t": tenantId, ":from": `${approver}#photo#${since}`, ":to": `${approver}#photo#~` },
    ScanIndexForward: false,
    Limit: PHOTO_LIST_MAX
  }));
  return (r.Items ?? []).reverse();
}
async function describePhotoRows(tenantId, sks, descriptions) {
  for (const [i, sk] of sks.entries()) {
    const description = descriptions[i];
    if (!description) continue;
    await ddb.send(new UpdateCommand2({ TableName: table(), Key: { tenantId, sk }, UpdateExpression: "SET description = :d", ExpressionAttributeValues: { ":d": description } }));
  }
}
async function markPhotosPosted(tenantId, sks, actionSk) {
  for (const sk of sks) {
    await ddb.send(new UpdateCommand2({ TableName: table(), Key: { tenantId, sk }, UpdateExpression: "SET postedIn = :a, postedAt = :now", ExpressionAttributeValues: { ":a": actionSk, ":now": now() } }));
  }
}

// src/activities/twilio.ts
var TWILIO_API = "https://api.twilio.com/2010-04-01/";
async function twilioCredentials() {
  const s = await jsonSecret(env2("TWILIO_SECRET_ARN"));
  if (!s.TWILIO_ACCOUNT_SID?.startsWith("AC") || !s.TWILIO_AUTH_TOKEN) throw new Error("the Twilio secret is not filled in");
  return { accountSid: s.TWILIO_ACCOUNT_SID, authToken: s.TWILIO_AUTH_TOKEN };
}
async function sendText(accountSid, from, to, body) {
  const c = await twilioCredentials();
  const res = await fetch(`${TWILIO_API}Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body })
  });
  if (!res.ok) throw new Error(`Twilio refused the text: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// src/activities/media.ts
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
var MESSAGE_SID = /^(MM|SM)[0-9a-f]{32}$/;
var MEDIA_SID = /^ME[0-9a-f]{32}$/;
var TENANT_ID = /^[a-z0-9-]{1,40}$/;
var LINK_SECONDS = 3600;
var MAX_PHOTO_BYTES = 5 * 1024 * 1024;
var EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" };
function photoKey(tenantId, p) {
  return `${tenantId}/${p.messageSid}/${p.mediaSid}.${EXT[p.contentType] ?? "bin"}`;
}
function createStore(deps) {
  const call = deps.fetch ?? fetch;
  return async (tenantId, tenantPhone, photos) => {
    if (!TENANT_ID.test(tenantId) || !tenantPhone) throw new Error("tenantId and tenantPhone are required");
    for (const p of photos) {
      if (!MESSAGE_SID.test(p.messageSid ?? "") || !MEDIA_SID.test(p.mediaSid ?? "")) throw new Error("messageSid and mediaSid must be Twilio ids");
    }
    if (photos.length === 0) return [];
    const { accountSid, authToken } = await deps.credentials();
    const headers = { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` };
    const out = [];
    const checked = /* @__PURE__ */ new Set();
    for (const p of photos) {
      const message = `${TWILIO_API}Accounts/${accountSid}/Messages/${p.messageSid}`;
      if (!checked.has(p.messageSid)) {
        const sent = await call(`${message}.json`, { headers });
        if (!sent.ok) throw new Error(`Twilio message lookup failed: ${sent.status}`);
        if ((await sent.json()).to !== tenantPhone) throw new Error("that message was not sent to this tenant");
        checked.add(p.messageSid);
      }
      const res = await call(`${message}/Media/${p.mediaSid}`, { headers, redirect: "follow" });
      if (!res.ok) throw new Error(`Twilio media fetch failed: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) throw new Error(`photo is ${bytes.byteLength} bytes`);
      const contentType = res.headers.get("content-type")?.split(";")[0] || p.contentType;
      const key = photoKey(tenantId, { ...p, contentType });
      await deps.put(key, bytes, contentType);
      out.push({ messageSid: p.messageSid, mediaSid: p.mediaSid, key, contentType });
    }
    return out;
  };
}
var s3 = new S3Client({});
var bucket = () => env2("MEDIA_BUCKET");
var store2 = createStore({
  credentials: twilioCredentials,
  put: async (key, body, contentType) => {
    await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
  }
});
function storePhotos(tenantId, tenantPhone, photos) {
  return store2(tenantId, tenantPhone, photos);
}
async function presign(keys) {
  const out = [];
  for (const key of keys) out.push(await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: LINK_SECONDS }));
  return out;
}

// src/activities/model.ts
import { ApplicationFailure } from "@temporalio/activity";

// src/rules/assistant.ts
var MAX_OUTPUT_TOKENS = 1200;
var ASSISTANT_TOOLS = {
  // These write the Actions ledger (the workflow runs them). There is no
  // publish tool and there must never be one: the person's POST publishes,
  // matched by the workflow before the model runs.
  draft_facebook_post: {
    description: "Create or change the draft of a post for the business Facebook Page. This never publishes. The system texts the exact draft to the person, and only their reply POST publishes it. Call it again to change the caption or the photos; each call replaces the whole draft.",
    parameters: {
      type: "object",
      properties: {
        caption: { type: "string", description: "The full text of the post, as it should appear on the Page" },
        photos: { type: "array", items: { type: "string" }, description: 'The photos the post carries, by label from the photo list in your instructions (for example ["p2", "p3"]); [] for a post with no photos. The whole list, not a change: name every photo the draft should have. The result names the photos on the draft; tell the person if there are none.' }
      },
      required: ["caption", "photos"],
      additionalProperties: false
    }
  },
  cancel_facebook_draft: {
    description: "Discard the pending Facebook post draft when the person no longer wants it.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
  }
};
var TOOL_NAMES = Object.keys(ASSISTANT_TOOLS);

// src/activities/model.ts
var OPENAI_API = "https://api.openai.com/v1/";
async function responses(body) {
  const key = (await jsonSecret(env2("OPENAI_SECRET_ARN"))).OPENAI_API_KEY;
  if (!key || key === "REPLACE_ME") throw ApplicationFailure.nonRetryable("the OpenAI secret is not filled in");
  const res = await fetch(`${OPENAI_API}responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env2("ASSISTANT_MODEL"), ...body })
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    if (res.status === 429 || res.status >= 500) throw new Error(`OpenAI ${res.status}: ${text}`);
    throw ApplicationFailure.nonRetryable(`OpenAI ${res.status}: ${text}`);
  }
  return res.json();
}
var textOf = (body) => (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => (o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "")).join(" ");
async function callModel(req) {
  const body = await responses({
    store: true,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    instructions: req.instructions,
    tools: req.tools,
    input: req.input,
    ...req.previousResponseId ? { previous_response_id: req.previousResponseId } : {}
  });
  const output = body.output ?? [];
  return {
    responseId: body.id,
    calls: output.filter((o) => o.type === "function_call").map((o) => ({ call_id: o.call_id, name: o.name, arguments: o.arguments ?? "{}" })),
    reply: textOf(body),
    tokens: body.usage?.total_tokens ?? 0,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0
  };
}
async function describeImages(urls) {
  if (urls.length === 0) return { descriptions: [], tokens: 0, inputTokens: 0, outputTokens: 0 };
  const body = await responses({
    store: false,
    max_output_tokens: 40 * urls.length + 40,
    instructions: `Describe each photo in one short lowercase phrase of at most eight words, naming what it shows (the subject, not the quality). Answer with exactly ${urls.length} lines, one per photo in order, no numbering, no other text.`,
    input: [{ role: "user", content: urls.map((image_url) => ({ type: "input_image", image_url })) }]
  });
  const lines = textOf(body).split("\n").map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
  const descriptions = urls.map((_, i) => (lines[i] ?? "photo").slice(0, 80));
  return { descriptions, tokens: body.usage?.total_tokens ?? 0, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
}

// src/activities/composio.ts
var executeTool = (tenantId, slug, args, version) => composio.executeTool(tenantId, slug, args, { version });
var composioAccounts = (tenantId, toolkit) => composio.accounts(tenantId, { toolkit });
var defs = /* @__PURE__ */ new Map();
function composioToolDefs(slugs) {
  const key = [...slugs].sort().join(",");
  let p = defs.get(key);
  if (!p) {
    p = composio.toolSchemas(slugs);
    p.catch(() => defs.delete(key));
    defs.set(key, p);
  }
  return p;
}
var composioProxy = (tenantId, accountId, method, endpoint, body) => composio.proxy(tenantId, accountId, method, endpoint, body);

// src/activities/memory.ts
var loadHistory = async (actorId, sessionId) => (await memory.history(actorId, sessionId)).map((l) => ({ role: l.role, content: l.text }));
var recall = (actorId, text) => memory.retrieve(actorId, "", text, 8);
var saveTurn = (actorId, sessionId, text, reply) => memory.write(actorId, sessionId, [{ role: "user", text }, { role: "assistant", text: reply }]);
var recallPreferences = (actorId) => memory.retrieve(actorId, "/preferences", "how and when this caller prefers to be contacted", 4);
var rememberCall = (actorId, callId, lines) => memory.write(actorId, callId, lines);

// src/activities/usage.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { PutCommand as PutCommand3 } from "@aws-sdk/lib-dynamodb";
async function recordUsage(tenantId, ref, tokens, inputTokens, outputTokens) {
  await ddb.send(new PutCommand3({ TableName: env2("USAGE_TABLE"), Item: { tenantId, sk: `${now()}#llm_tokens#${randomUUID2()}`, meter: "llm_tokens", units: tokens, inputTokens, outputTokens, ref } }));
}
async function recordMeter(tenantId, meter, units, ref) {
  await ddb.send(new PutCommand3({ TableName: env2("USAGE_TABLE"), Item: { tenantId, sk: `${now()}#${meter}#${randomUUID2()}`, meter, units, ref } }));
}

// src/activities/calls.ts
import { ConditionalCheckFailedException as ConditionalCheckFailedException2 } from "@aws-sdk/client-dynamodb";
import { GetCommand as GetCommand2, UpdateCommand as UpdateCommand3 } from "@aws-sdk/lib-dynamodb";
async function readCall(callId, key, transcript = false) {
  const r = await ddb.send(new GetCommand2({
    TableName: env2("CALLS_TABLE"),
    Key: { callId },
    ProjectionExpression: transcript ? "#k, transcript" : "#k",
    ExpressionAttributeNames: { "#k": key }
  }));
  const item = r.Item;
  return { done: Boolean(item?.[key]), transcript: item?.transcript ?? [] };
}
async function markDone(callId, key, conditional2 = false) {
  try {
    await ddb.send(new UpdateCommand3({
      TableName: env2("CALLS_TABLE"),
      Key: { callId },
      UpdateExpression: "SET #k = :at, expiresAt = if_not_exists(expiresAt, :ttl)",
      ...conditional2 ? { ConditionExpression: "attribute_not_exists(#k)" } : {},
      ExpressionAttributeNames: { "#k": key },
      ExpressionAttributeValues: { ":at": now(), ":ttl": epoch() + 90 * 86400 }
    }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException2) return false;
    throw err;
  }
}

// src/activities/telegram.ts
async function sendTelegram(chatId, text) {
  const s = await jsonSecret(env2("TELEGRAM_SECRET_ARN"));
  if (!s.TELEGRAM_BOT_TOKEN || s.TELEGRAM_BOT_TOKEN === "set-me") throw new Error("the Telegram secret is not filled in");
  const res = await fetch(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(`Telegram refused the message: ${res.status} ${body.description ?? ""}`);
}

// src/activities/browser.ts
var BROWSERBASE_API = "https://api.browserbase.com/v1/";
async function api(method, path, body) {
  const s = await jsonSecret(env2("BROWSERBASE_SECRET_ARN"));
  if (!s.BROWSERBASE_API_KEY) throw new Error("the Browserbase secret is not filled in");
  const res = await fetch(BROWSERBASE_API + path, {
    method,
    headers: { "X-BB-API-Key": s.BROWSERBASE_API_KEY, ...body ? { "content-type": "application/json" } : {} },
    body: body ? JSON.stringify(body) : void 0
  });
  if (!res.ok) throw new Error(`Browserbase ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}
var project = () => env2("BROWSERBASE_PROJECT_ID");
async function createBrowserContext(tenantId) {
  return (await api("POST", "contexts", { projectId: project(), name: tenantId })).id;
}
async function startBrowserSession(contextId, timeoutSeconds) {
  return (await api("POST", "sessions", {
    projectId: project(),
    browserSettings: { context: { id: contextId, persist: true }, solveCaptchas: true },
    keepAlive: true,
    timeout: timeoutSeconds
  })).id;
}
async function browserLiveView(sessionId) {
  return (await api("GET", `sessions/${sessionId}/debug`)).debuggerUrl;
}
async function releaseBrowserSession(sessionId) {
  await api("POST", `sessions/${sessionId}`, { projectId: project(), status: "REQUEST_RELEASE" });
}

// src/activities/tenants.ts
import { ConditionalCheckFailedException as ConditionalCheckFailedException3 } from "@aws-sdk/client-dynamodb";
import { UpdateCommand as UpdateCommand4 } from "@aws-sdk/lib-dynamodb";
var listTenants = () => store.listTenants();
async function claimLoginWindow(phoneNumber, untilIso) {
  try {
    await ddb.send(new UpdateCommand4({
      TableName: env2("TENANTS_TABLE"),
      Key: { phoneNumber },
      UpdateExpression: "SET #b.loginUntil = :until",
      ConditionExpression: "attribute_not_exists(#b.loginUntil) OR #b.loginUntil < :now",
      ExpressionAttributeNames: { "#b": "browser" },
      ExpressionAttributeValues: { ":until": untilIso, ":now": now() }
    }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException3) return false;
    throw err;
  }
}
async function clearLoginWindow(phoneNumber) {
  await ddb.send(new UpdateCommand4({ TableName: env2("TENANTS_TABLE"), Key: { phoneNumber }, UpdateExpression: "REMOVE #b.loginUntil", ExpressionAttributeNames: { "#b": "browser" } }));
}
async function saveBrowserContext(phoneNumber, contextId) {
  await ddb.send(new UpdateCommand4({ TableName: env2("TENANTS_TABLE"), Key: { phoneNumber }, UpdateExpression: "SET #b.contextId = :c", ExpressionAttributeNames: { "#b": "browser" }, ExpressionAttributeValues: { ":c": contextId } }));
}

// src/activities/index.ts
async function echo(name) {
  return `pong: ${name}`;
}

// src/version.ts
var DEPLOYMENT_NAME = "wnk-dev-worker";
var BUILD_ID = "build-18";
var TASK_QUEUE = "wnk-dev";

// src/entry/temporal.ts
async function temporalConnection() {
  const s = await jsonSecret(env2("TEMPORAL_SECRET_ARN"));
  for (const key of ["TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_API_KEY"]) if (!s[key]) throw new Error(`${key} is empty in the Temporal secret`);
  return { address: s.TEMPORAL_ADDRESS, namespace: s.TEMPORAL_NAMESPACE, apiKey: s.TEMPORAL_API_KEY };
}

// src/entry/handler.ts
var config;
var worker = runWorker({ deploymentName: DEPLOYMENT_NAME, buildId: BUILD_ID }, (c) => {
  config = c;
  c.workerOptions.taskQueue = TASK_QUEUE;
  c.workerOptions.workflowBundle = { codePath: fileURLToPath(new URL("./workflow-bundle.js", import.meta.url)) };
  c.workerOptions.activities = activities_exports;
});
async function connect() {
  const t = await temporalConnection();
  config.connectionOptions = { address: t.address, apiKey: t.apiKey, tls: true };
  config.namespace = t.namespace;
}
var connection;
var handler = async (event, context) => {
  connection ??= connect().catch((err) => {
    connection = void 0;
    throw err;
  });
  await connection;
  return worker(event, context);
};
export {
  handler
};
//# sourceMappingURL=handler.js.map
