/** Who is texting, and for which tenant: the People row keyed by the channel identity the channel vouches for, then the tenant row it names. */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { PersonRecord, TenantRow } from '@wnk/shared/contracts';
import { ddb } from './clients.js';
import { env } from './config.js';

export async function lookupPerson(channelId: string): Promise<PersonRecord | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: env('PEOPLE_TABLE'), Key: { channelId } }));
  return r.Item as PersonRecord | undefined;
}

export async function lookupTenant(phoneNumber: string): Promise<TenantRow | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: env('TENANTS_TABLE'), Key: { phoneNumber } }));
  return r.Item as TenantRow | undefined;
}
