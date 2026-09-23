/** Who is texting, and for which tenant: the People row keyed by the channel identity the channel vouches for, then the tenant row it names (the shared store; a row that no longer parses fails closed). */
import type { PersonRecord, TenantRow } from '@wnk/shared/contracts';
import { store } from './clients.js';

export const lookupPerson = (channelId: string): Promise<PersonRecord | undefined> => store.getPerson(channelId);
export const lookupTenant = (phoneNumber: string): Promise<TenantRow | undefined> => store.getTenant(phoneNumber);
