import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { env } from './config.js';
import { TenantConfigSchema, type CallRecord, type CallStatus, type Lead, type TenantConfig, type TenantConfigInput, type ToolCallRecord, type TranscriptEntry } from './types.js';

const CALL_TTL_DAYS = 90;

export type NewLead = Omit<Lead, 'sk' | 'leadId' | 'createdAt'>;

/** All persistence behind one interface: DynamoDB in AWS, in-memory in tests. */
export interface Store {
  getTenant(phoneNumber: string): Promise<TenantConfig | undefined>;
  putTenant(input: TenantConfigInput): Promise<TenantConfig>;
  /**
   * Atomically claim a call id. Returns false if already claimed (OpenAI retried
   * the webhook). A call whose previous attempt ended `failed` may be re-claimed.
   */
  claimCall(record: Omit<CallRecord, 'status' | 'expiresAt'>): Promise<boolean>;
  getCall(callId: string): Promise<CallRecord | undefined>;
  setCallStatus(callId: string, status: CallStatus, extra?: Partial<CallRecord>): Promise<void>;
  appendTranscript(callId: string, entry: TranscriptEntry): Promise<void>;
  appendToolCall(callId: string, tc: ToolCallRecord): Promise<void>;
  createLead(lead: NewLead): Promise<Lead>;
  /**
   * Once-markers for side effects that run under at-least-once delivery
   * (EventBridge, Lambda async retries, our own SDK retries). Pattern:
   * `if (await isDone(callId, key)) return;` ... do the side effect ...
   * `await markDone(callId, key)`. Keys are DOMAIN identity, e.g.
   * `notify:lead:<leadId>` — never the EventBridge event id, which differs
   * between two PutEvents of the same fact.
   *
   * This is the low-risk level: it narrows the duplicate window to a crash
   * between the side effect and the mark. It is not exactly-once. Actions
   * that cost money or reach a customer irreversibly need a ledger
   * (pending -> completed with a lease) plus reconciliation instead.
   */
  isDone(callId: string, key: string): Promise<boolean>;
  /** Marks `key` done for the call. False if it was already marked (a race lost). */
  markDone(callId: string, key: string): Promise<boolean>;
  /** Tenant by id (table is keyed by phone; scan — tenant tables are tiny). */
  findTenantById(tenantId: string): Promise<TenantConfig | undefined>;
  /** Newest-first calls for a tenant (byTenant GSI). */
  listCalls(tenantId: string, limit?: number): Promise<CallRecord[]>;
  /** Newest-first leads for a tenant. */
  listLeads(tenantId: string, limit?: number): Promise<Lead[]>;
}

function buildLead(input: NewLead): Lead {
  const leadId = randomUUID();
  const createdAt = new Date().toISOString();
  return { ...input, leadId, createdAt, sk: `${createdAt}#${leadId}` };
}

export function dynamoStore(): Store {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  // Resolved on use so a tool that only touches one table (e.g. the seed script) needs only that env var.
  const table = (name: string, value: string) => {
    if (!value) throw new Error(`${name} not set`);
    return value;
  };
  const tenants = () => table('TENANTS_TABLE', env.tenantsTable);
  const calls = () => table('CALLS_TABLE', env.callsTable);
  const leads = () => table('LEADS_TABLE', env.leadsTable);

  const appendList = (callId: string, attr: 'transcript' | 'toolCalls', item: unknown) =>
    db.send(new UpdateCommand({
      TableName: calls(),
      Key: { callId },
      UpdateExpression: `SET ${attr} = list_append(if_not_exists(${attr}, :empty), :e)`,
      ExpressionAttributeValues: { ':empty': [], ':e': [item] },
    }));

  return {
    async getTenant(phoneNumber) {
      const res = await db.send(new GetCommand({ TableName: tenants(), Key: { phoneNumber } }));
      return res.Item ? TenantConfigSchema.parse(res.Item) : undefined;
    },
    async putTenant(input) {
      const tenant = TenantConfigSchema.parse(input);
      await db.send(new PutCommand({ TableName: tenants(), Item: tenant }));
      return tenant;
    },
    async claimCall(record) {
      const item: CallRecord = { ...record, status: 'claimed', expiresAt: Math.floor(Date.now() / 1000) + CALL_TTL_DAYS * 86400 };
      try {
        await db.send(new PutCommand({
          TableName: calls(),
          Item: item,
          ConditionExpression: 'attribute_not_exists(callId) OR #status = :failed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'failed' },
        }));
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
    async getCall(callId) {
      const res = await db.send(new GetCommand({ TableName: calls(), Key: { callId } }));
      return res.Item as CallRecord | undefined;
    },
    async setCallStatus(callId, status, extra = {}) {
      const names: Record<string, string> = { '#status': 'status' };
      const values: Record<string, unknown> = { ':status': status };
      const sets = ['#status = :status'];
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) continue;
        names[`#${k}`] = k;
        values[`:${k}`] = v;
        sets.push(`#${k} = :${k}`);
      }
      await db.send(new UpdateCommand({
        TableName: calls(),
        Key: { callId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
    },
    appendTranscript: (callId, entry) => appendList(callId, 'transcript', entry).then(() => {}),
    appendToolCall: (callId, tc) => appendList(callId, 'toolCalls', tc).then(() => {}),
    async createLead(input) {
      const lead = buildLead(input);
      await db.send(new PutCommand({ TableName: leads(), Item: lead }));
      return lead;
    },
    async isDone(callId, key) {
      const res = await db.send(new GetCommand({
        TableName: calls(), Key: { callId },
        ProjectionExpression: '#k', ExpressionAttributeNames: { '#k': `done:${key}` },
      }));
      return Boolean(res.Item?.[`done:${key}`]);
    },
    async markDone(callId, key) {
      try {
        // Upsert: a marker on a call row that somehow doesn't exist still
        // expires (TTL), so nothing accumulates.
        await db.send(new UpdateCommand({
          TableName: calls(), Key: { callId },
          UpdateExpression: 'SET #k = :at, expiresAt = if_not_exists(expiresAt, :ttl)',
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': `done:${key}` },
          ExpressionAttributeValues: { ':at': new Date().toISOString(), ':ttl': Math.floor(Date.now() / 1000) + CALL_TTL_DAYS * 86400 },
        }));
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
    async findTenantById(tenantId) {
      const res = await db.send(new ScanCommand({
        TableName: tenants(),
        FilterExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId },
      }));
      const item = res.Items?.[0];
      return item ? TenantConfigSchema.parse(item) : undefined;
    },
    async listCalls(tenantId, limit = 50) {
      const res = await db.send(new QueryCommand({
        TableName: calls(),
        IndexName: 'byTenant',
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId },
        ScanIndexForward: false,
        Limit: limit,
      }));
      return (res.Items ?? []) as CallRecord[];
    },
    async listLeads(tenantId, limit = 50) {
      const res = await db.send(new QueryCommand({
        TableName: leads(),
        KeyConditionExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId },
        ScanIndexForward: false,
        Limit: limit,
      }));
      return (res.Items ?? []) as Lead[];
    },
  };
}

/** In-memory store for tests. */
export function memoryStore(tenants: TenantConfigInput[] = []): Store & { calls: Map<string, CallRecord>; leads: Lead[] } {
  const tenantMap = new Map(tenants.map((t) => {
    const parsed = TenantConfigSchema.parse(t);
    return [parsed.phoneNumber, parsed] as const;
  }));
  const calls = new Map<string, CallRecord>();
  const leads: Lead[] = [];
  const done = new Set<string>();
  const must = (id: string) => {
    const c = calls.get(id);
    if (!c) throw new Error(`unknown call ${id}`);
    return c;
  };
  return {
    calls,
    leads,
    getTenant: async (n) => tenantMap.get(n),
    async putTenant(input) {
      const t = TenantConfigSchema.parse(input);
      tenantMap.set(t.phoneNumber, t);
      return t;
    },
    async claimCall(record) {
      const existing = calls.get(record.callId);
      if (existing && existing.status !== 'failed') return false;
      calls.set(record.callId, { ...record, status: 'claimed' });
      return true;
    },
    getCall: async (id) => calls.get(id),
    async setCallStatus(id, status, extra = {}) { Object.assign(must(id), extra, { status }); },
    async appendTranscript(id, e) { (must(id).transcript ??= []).push(e); },
    async appendToolCall(id, tc) { (must(id).toolCalls ??= []).push(tc); },
    async findTenantById(tenantId) {
      return [...tenantMap.values()].find((t) => t.tenantId === tenantId);
    },
    async listCalls(tenantId, limit = 50) {
      return [...calls.values()].filter((c) => c.tenantId === tenantId)
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, limit);
    },
    async listLeads(tenantId, limit = 50) {
      return leads.filter((l) => l.tenantId === tenantId).slice().reverse().slice(0, limit);
    },
    async createLead(input) {
      const lead = buildLead(input);
      leads.push(lead);
      return lead;
    },
    isDone: async (id, key) => done.has(`${id}|${key}`),
    async markDone(id, key) {
      const k = `${id}|${key}`;
      if (done.has(k)) return false;
      done.add(k);
      return true;
    },
  };
}
