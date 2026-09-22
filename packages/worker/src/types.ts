/**
 * The rows the worker reads, as the DocumentClient hands them back (plain
 * values). The schemas that define them live in @wnk/shared; the worker
 * names only the fields it uses, and a test keeps the constants in step.
 */

/** A People-table row: a channel identity that resolves to a tenant and a person. */
export interface PersonRow {
  channelId: string;
  tenantId: string;
  /** The tenant row's key. */
  tenantPhone: string;
  name: string;
  role: 'owner' | 'employee';
}

/** The parts of a Tenants-table row the assistant reads. */
export interface TenantRow {
  tenantId: string;
  phoneNumber: string;
  sessionDayOffsetMinutes?: number;
  business: { name: string; description?: string; services?: string[]; hours?: string };
  assistant?: { enabled?: boolean; tools?: string[] };
  facebookPosts?: { enabled?: boolean; pageId?: string; pageName?: string };
}

/** A texted photo by its Twilio ids; links are minted when needed, never stored. */
export interface Photo {
  messageSid: string;
  mediaSid: string;
}

/** An Actions-table row for a Facebook post draft, the fields the workflow reads. */
export interface DraftRow {
  tenantId: string;
  sk: string;
  status: string;
  revision: number;
  shownRevision: number;
  approveBy: number;
  payload: { caption: string; media: Photo[] };
}
