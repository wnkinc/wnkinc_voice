import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { env } from './config.js';
import { personChannelKeys, TenantConfigSchema, type CallRecord, type CallStatus, type PersonRecord, type TenantConfig, type TenantConfigInput, type ToolCallRecord, type TranscriptEntry } from './types.js';

/**
 * The persistence the CODE still does: the session Lambda's call row and the
 * seed's writes. Claiming a call, the once-markers, and
 * the People lookup are Step Functions states now (workflows/).
 * DynamoDB in AWS, in-memory in tests.
 */
export interface Store {
  getTenant(phoneNumber: string): Promise<TenantConfig | undefined>;
  putTenant(input: TenantConfigInput): Promise<TenantConfig>;
  /**
   * Mirror a tenant's `people` into the People table (one row per channel
   * identity) and remove rows of this tenant that are no longer listed, so
   * taking someone off the tenant file takes their access away at the next seed.
   */
  syncPeople(tenant: TenantConfig): Promise<PersonRecord[]>;
  getCall(callId: string): Promise<CallRecord | undefined>;
  setCallStatus(callId: string, status: CallStatus, extra?: Partial<CallRecord>): Promise<void>;
  appendTranscript(callId: string, entry: TranscriptEntry): Promise<void>;
  appendToolCall(callId: string, tc: ToolCallRecord): Promise<void>;
  /** Tenant by id (table is keyed by phone; scan — tenant tables are tiny). */
  findTenantById(tenantId: string): Promise<TenantConfig | undefined>;
  /** Newest-first calls for a tenant (byTenant GSI). */
  listCalls(tenantId: string, limit?: number): Promise<CallRecord[]>;
  /**
   * Claim the tenant's saved browser until `untilIso` (one window at a time:
   * two sessions on one Browserbase context race on release). False when a
   * window is already open. The same row field the browser-login workflow claims.
   */
  claimBrowser(phoneNumber: string, untilIso: string): Promise<boolean>;
  releaseBrowser(phoneNumber: string): Promise<void>;
  /** One usage row (the same shape the workflows write): what was metered, how much, and for what. */
  putUsage(row: { tenantId: string; meter: string; units: number; ref: string }): Promise<void>;
}

function peopleRecords(tenant: TenantConfig): PersonRecord[] {
  return tenant.people.flatMap((p) =>
    personChannelKeys(p).map((channelId) => ({ channelId, tenantId: tenant.tenantId, tenantPhone: tenant.phoneNumber, name: p.name, role: p.role })));
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
  const people = () => table('PEOPLE_TABLE', env.peopleTable);
  const usage = () => table('USAGE_TABLE', env.usageTable);

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
    async syncPeople(tenant) {
      const wanted = peopleRecords(tenant);
      const existing = await db.send(new ScanCommand({
        TableName: people(), FilterExpression: 'tenantId = :t', ExpressionAttributeValues: { ':t': tenant.tenantId },
      }));
      const keep = new Set(wanted.map((p) => p.channelId));
      for (const item of (existing.Items ?? []) as PersonRecord[]) {
        if (!keep.has(item.channelId)) await db.send(new DeleteCommand({ TableName: people(), Key: { channelId: item.channelId } }));
      }
      for (const p of wanted) await db.send(new PutCommand({ TableName: people(), Item: p }));
      return wanted;
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
    async findTenantById(tenantId) {
      const res = await db.send(new ScanCommand({
        TableName: tenants(),
        FilterExpression: 'tenantId = :t',
        ExpressionAttributeValues: { ':t': tenantId },
      }));
      const item = res.Items?.[0];
      return item ? TenantConfigSchema.parse(item) : undefined;
    },
    async claimBrowser(phoneNumber, untilIso) {
      try {
        await db.send(new UpdateCommand({
          TableName: tenants(), Key: { phoneNumber },
          UpdateExpression: 'SET #b.loginUntil = :until',
          ConditionExpression: 'attribute_exists(phoneNumber) AND (attribute_not_exists(#b.loginUntil) OR #b.loginUntil < :now)',
          ExpressionAttributeNames: { '#b': 'browser' },
          ExpressionAttributeValues: { ':until': untilIso, ':now': new Date().toISOString() },
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async releaseBrowser(phoneNumber) {
      await db.send(new UpdateCommand({ TableName: tenants(), Key: { phoneNumber }, UpdateExpression: 'REMOVE #b.loginUntil', ExpressionAttributeNames: { '#b': 'browser' } }));
    },
    async putUsage({ tenantId, meter, units, ref }) {
      await db.send(new PutCommand({ TableName: usage(), Item: { tenantId, sk: `${new Date().toISOString()}#${meter}#${randomUUID()}`, meter, units, ref } }));
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
  };
}

/** In-memory store for tests. */
export function memoryStore(tenants: TenantConfigInput[] = []): Store & { calls: Map<string, CallRecord>; people: Map<string, PersonRecord>; usage: { tenantId: string; meter: string; units: number; ref: string }[] } {
  const tenantMap = new Map(tenants.map((t) => {
    const parsed = TenantConfigSchema.parse(t);
    return [parsed.phoneNumber, parsed] as const;
  }));
  const calls = new Map<string, CallRecord>();
  const peopleMap = new Map<string, PersonRecord>();
  const usageRows: { tenantId: string; meter: string; units: number; ref: string }[] = [];
  const must = (id: string) => {
    const c = calls.get(id);
    if (!c) throw new Error(`unknown call ${id}`);
    return c;
  };
  return {
    calls,
    people: peopleMap,
    usage: usageRows,
    getTenant: async (n) => tenantMap.get(n),
    async putTenant(input) {
      const t = TenantConfigSchema.parse(input);
      tenantMap.set(t.phoneNumber, t);
      return t;
    },
    getCall: async (id) => calls.get(id),
    async setCallStatus(id, status, extra = {}) { Object.assign(must(id), extra, { status }); },
    async appendTranscript(id, e) { (must(id).transcript ??= []).push(e); },
    async appendToolCall(id, tc) { (must(id).toolCalls ??= []).push(tc); },
    async findTenantById(tenantId) {
      return [...tenantMap.values()].find((t) => t.tenantId === tenantId);
    },
    async claimBrowser(phoneNumber, untilIso) {
      const t = tenantMap.get(phoneNumber);
      if (!t || (t.browser.loginUntil && t.browser.loginUntil >= new Date().toISOString())) return false;
      t.browser.loginUntil = untilIso;
      return true;
    },
    async releaseBrowser(phoneNumber) {
      const t = tenantMap.get(phoneNumber);
      if (t) delete t.browser.loginUntil;
    },
    async putUsage(row) { usageRows.push(row); },
    async syncPeople(tenant) {
      for (const [k, v] of peopleMap) if (v.tenantId === tenant.tenantId) peopleMap.delete(k);
      const wanted = peopleRecords(tenant);
      for (const p of wanted) peopleMap.set(p.channelId, p);
      return wanted;
    },
    async listCalls(tenantId, limit = 50) {
      return [...calls.values()].filter((c) => c.tenantId === tenantId)
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, limit);
    },
  };
}
