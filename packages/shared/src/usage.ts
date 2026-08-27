/**
 * Usage metering (the fuel gauge, not a billing system). Every money-bearing
 * action leaves a record: (tenantId, timestamp#meter, units). Costs are
 * ESTIMATES — units x the rate card — reconciled against real invoices
 * monthly by editing rates.ts. Meters stay coarse and few: a meter earns its
 * place only if it changes a decision.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { RATES, type Meter } from './rates.js';

export interface UsageRecord {
  tenantId: string;
  /** `${ISO timestamp}#${meter}#${uuid}` — month-prefix queryable, collision-free. */
  sk: string;
  meter: Meter;
  units: number;
  /** What produced it (callId, message id, task id) — for spot-checking. */
  ref?: string;
}

let db: DynamoDBDocumentClient | undefined;
const table = (): string | undefined => process.env.USAGE_TABLE || undefined;

/**
 * Fire-and-forget: never throws, no-ops when USAGE_TABLE is unset (tests,
 * local dev). A metering failure must never hurt the work being metered.
 */
export async function recordUsage(tenantId: string, meter: Meter, units: number, ref?: string): Promise<void> {
  const t = table();
  if (!t || !(units > 0)) return;
  db ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const record: UsageRecord = { tenantId, sk: `${new Date().toISOString()}#${meter}#${randomUUID()}`, meter, units, ref };
  await db.send(new PutCommand({ TableName: t, Item: record })).catch((err) => {
    console.warn(JSON.stringify({ msg: 'usage record failed (ignored)', meter, err: String(err) }));
  });
}

/** All usage records for a tenant in a month ('YYYY-MM'). */
export async function listUsage(tenantId: string, month: string): Promise<UsageRecord[]> {
  const t = table();
  if (!t) return [];
  db ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const records: UsageRecord[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const res = await db.send(new QueryCommand({
      TableName: t,
      KeyConditionExpression: 'tenantId = :t AND begins_with(sk, :m)',
      ExpressionAttributeValues: { ':t': tenantId, ':m': month },
      ExclusiveStartKey: cursor,
    }));
    records.push(...((res.Items ?? []) as UsageRecord[]));
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return records;
}

export interface CostLine {
  meter: string;
  units: number;
  rate: number;
  cost: number;
  note: string;
}
export interface CostSummary {
  month: string;
  lines: CostLine[];
  overhead: number;
  total: number;
}

/** Pure: aggregate records per meter and price them with the rate card. */
export function computeCosts(month: string, records: UsageRecord[], rates = RATES): CostSummary {
  const byMeter = new Map<Meter, number>();
  for (const r of records) byMeter.set(r.meter, (byMeter.get(r.meter) ?? 0) + r.units);
  const lines: CostLine[] = [...byMeter.entries()]
    .map(([meter, units]) => {
      const { rate, note } = rates.meters[meter] ?? { rate: 0, note: 'unpriced meter' };
      return { meter, units: Math.round(units * 100) / 100, rate, cost: Math.round(units * rate * 10000) / 10000, note };
    })
    .sort((a, b) => b.cost - a.cost);
  const overhead = records.length > 0 ? rates.monthlyOverhead : 0;
  const total = Math.round((lines.reduce((s, l) => s + l.cost, 0) + overhead) * 100) / 100;
  return { month, lines, overhead, total };
}
