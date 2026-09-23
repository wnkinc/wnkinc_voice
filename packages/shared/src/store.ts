import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { env } from './config.js';
import type { CallStatus, PersonRecord, TranscriptEntry } from './contracts.js';
import { personChannelKeys, TenantConfigSchema, type CallRecord, type TenantConfig, type TenantConfigInput, type ToolCallRecord } from './types.js';

/**
 * The rows, behind one interface: the tenant and people reads every side
 * makes (the receptionist, the worker's identity activities, the scripts),
 * the seed's writes, and the session Lambda's call row. What one side alone
 * writes (the worker's once-markers, ledger and browser window) stays in that
 * side's activities. DynamoDB in AWS, in-memory in tests.
 */
export interface Store {
  /** The tenant a called number routes to, validated on read: a row that no longer parses fails closed. */
  getTenant(phoneNumber: string): Promise<TenantConfig | undefined>;
  /** Every tenant (the table is one row per called number; a scan is the read). */
  listTenants(): Promise<TenantConfig[]>;
  /** Who a channel identity is: `telegram:<id>` or `sms:<e164>` -> the tenant and person, as the seed mirrored it. */
  getPerson(channelId: string): Promise<PersonRecord | undefined>;
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
  /** Tenant by id (the table is keyed by phone; a scan, the table is tiny). */
  findTenantById(tenantId: string): Promise<TenantConfig | undefined>;
}

function peopleRecords(tenant: TenantConfig): PersonRecord[] {
  return tenant.people.flatMap((p) =>
    personChannelKeys(p).map((channelId) => ({ channelId, tenantId: tenant.tenantId, tenantPhone: tenant.phoneNumber, name: p.name, role: p.role })));
}

/** Over the given DocumentClient, or one of its own. */
export function dynamoStore(client?: DynamoDBDocumentClient): Store {
  const db = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  // Resolved on use so a tool that only touches one table (e.g. the seed script) needs only that env var.
  const table = (name: string, value: string) => {
    if (!value) throw new Error(`${name} not set`);
    return value;
  };
  const tenants = () => table('TENANTS_TABLE', env.tenantsTable);
  const calls = () => table('CALLS_TABLE', env.callsTable);
  const people = () => table('PEOPLE_TABLE', env.peopleTable);

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
    async listTenants() {
      const res = await db.send(new ScanCommand({ TableName: tenants() }));
      return (res.Items ?? []).map((i) => TenantConfigSchema.parse(i));
    },
    async getPerson(channelId) {
      const res = await db.send(new GetCommand({ TableName: people(), Key: { channelId } }));
      return res.Item as PersonRecord | undefined;
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
  };
}

/** In-memory store for tests. */
export function memoryStore(tenants: TenantConfigInput[] = []): Store & { calls: Map<string, CallRecord>; people: Map<string, PersonRecord> } {
  const tenantMap = new Map(tenants.map((t) => {
    const parsed = TenantConfigSchema.parse(t);
    return [parsed.phoneNumber, parsed] as const;
  }));
  const calls = new Map<string, CallRecord>();
  const peopleMap = new Map<string, PersonRecord>();
  const must = (id: string) => {
    const c = calls.get(id);
    if (!c) throw new Error(`unknown call ${id}`);
    return c;
  };
  return {
    calls,
    people: peopleMap,
    getTenant: async (n) => tenantMap.get(n),
    listTenants: async () => [...tenantMap.values()],
    getPerson: async (id) => peopleMap.get(id),
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
    async syncPeople(tenant) {
      for (const [k, v] of peopleMap) if (v.tenantId === tenant.tenantId) peopleMap.delete(k);
      const wanted = peopleRecords(tenant);
      for (const p of wanted) peopleMap.set(p.channelId, p);
      return wanted;
    },
  };
}
