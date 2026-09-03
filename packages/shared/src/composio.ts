/**
 * Composio adapter — the ONE file that may import @composio/core or name a
 * Composio tool slug. Composio is our SaaS credential broker (their verified
 * OAuth apps for Gmail, HubSpot, LinkedIn; tokens live in their vault, keyed by our tenantId): code calls
 * these functions, nothing else in the platform knows Composio exists.
 * LLM-facing surfaces get task-shaped Gateway tools that call THIS underneath —
 * never Composio's generic tools directly.
 *
 * Tenancy: every call names the tenant (Composio `userId` = our tenantId), so
 * the credential is chosen per call — the shape the Gateway interceptor feeds.
 *
 * Deliberately NOT re-exported from the shared index: import from
 * '@wnk/shared/composio' so only bundles that reach SaaS carry the SDK.
 *
 * Config: COMPOSIO_SECRET_ARN (Secrets Manager JSON {"COMPOSIO_API_KEY":...})
 * or COMPOSIO_API_KEY directly (scripts). Optional COMPOSIO_<TOOLKIT>_VERSION
 * (GMAIL, HUBSPOT, LINKEDIN) pins that toolkit's version — set in prod; unset
 * skips the pin (dev).
 */
import { Composio } from '@composio/core';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HUBSPOT_NOTE_TO_CONTACT, HUBSPOT_TASK_TO_CONTACT, htmlToText, textToHtml, type CrmAdapter, type CrmContact } from './crm.js';

const REGION = process.env.AWS_REGION ?? 'us-west-2';

const TOOLKITS = ['gmail', 'hubspot', 'linkedin'] as const;
export type ComposioToolkit = (typeof TOOLKITS)[number];
/** The pinned version for a toolkit (COMPOSIO_<TOOLKIT>_VERSION), if any. */
const pinned = (toolkit: string) => process.env[`COMPOSIO_${toolkit.toUpperCase()}_VERSION`];
/** Tool slugs are `<TOOLKIT>_<ACTION>`. */
const toolkitOf = (slug: string) => slug.split('_')[0]!.toLowerCase();

let clientPromise: Promise<Composio> | undefined;
function client(): Promise<Composio> {
  clientPromise ??= (async () => {
    let apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) {
      const arn = process.env.COMPOSIO_SECRET_ARN;
      if (!arn) throw new Error('neither COMPOSIO_API_KEY nor COMPOSIO_SECRET_ARN set');
      const sm = new SecretsManagerClient({ region: REGION });
      const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
      apiKey = (JSON.parse(secret.SecretString ?? '{}') as { COMPOSIO_API_KEY?: string }).COMPOSIO_API_KEY;
      if (!apiKey) throw new Error('COMPOSIO_API_KEY missing from secret');
    }
    const versions = Object.fromEntries(TOOLKITS.flatMap((t) => (pinned(t) ? [[t, pinned(t)!]] : [])));
    return new Composio({ apiKey, ...(Object.keys(versions).length ? { toolkitVersions: versions } : {}) });
  })();
  return clientPromise;
}

async function execute(slug: string, tenantId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const c = await client();
  const attempt = () => c.tools.execute(slug, {
    userId: tenantId,
    arguments: args,
    ...(pinned(toolkitOf(slug)) ? {} : { dangerouslySkipVersionCheck: true }),
  });
  let res = await attempt().catch(async (err: unknown) => {
    // One retry with a short pause: Composio is a hard dependency on the send
    // path, and transient 5xx/429s should not drop a lead email.
    console.warn(JSON.stringify({ msg: 'composio execute retrying', slug, err: String(err) }));
    await new Promise((r) => setTimeout(r, 2000));
    return attempt();
  });
  if (!res.successful) {
    console.warn(JSON.stringify({ msg: 'composio execute retrying (unsuccessful)', slug, error: res.error }));
    await new Promise((r) => setTimeout(r, 2000));
    res = await attempt();
  }
  if (!res.successful) throw new Error(`composio ${slug} failed: ${res.error}`);
  return res.data;
}

/** The owner's Gmail address for a tenant's connected account. */
async function ownerEmail(tenantId: string): Promise<string> {
  const profile = await execute('GMAIL_GET_PROFILE', tenantId, {});
  const email = (profile as { response_data?: { emailAddress?: string }; emailAddress?: string })
    .response_data?.emailAddress ?? (profile as { emailAddress?: string }).emailAddress;
  if (!email) throw new Error(`no Gmail profile for tenant ${tenantId}; run scripts/connect-composio.mts`);
  return email;
}

/** Send a plain-text email from the tenant owner's Gmail to the owner themself. */
async function sendAsOwner(tenantId: string, subject: string, body: string): Promise<string> {
  const email = await ownerEmail(tenantId);
  await execute('GMAIL_SEND_EMAIL', tenantId, { recipient_email: email, subject, body });
  return email;
}

/** Mint the OAuth connect link a tenant owner clicks once at onboarding, per toolkit. */
async function connectLink(tenantId: string, toolkit: ComposioToolkit = 'gmail'): Promise<{ redirectUrl: string; waitForActive: (timeoutMs?: number) => Promise<string> }> {
  const c = await client();
  const configs = await c.authConfigs.list({ toolkit });
  let authConfigId = configs.items?.[0]?.id;
  if (!authConfigId) {
    const created = await c.authConfigs.create(toolkit, { type: 'use_composio_managed_auth', name: toolkit });
    authConfigId = created.id;
  }
  const request = await c.connectedAccounts.link(tenantId, authConfigId);
  if (!request.redirectUrl) throw new Error('composio returned no redirect url');
  return {
    redirectUrl: request.redirectUrl,
    waitForActive: async (timeoutMs = 300_000) => {
      const account = await c.connectedAccounts.waitForConnection(request.id, timeoutMs);
      return account.id;
    },
  };
}

export const composioGmail = { sendAsOwner, ownerEmail, connectLink: (tenantId: string) => connectLink(tenantId, 'gmail') };
export const composioConnect = { link: connectLink };

// ---- HubSpot CRM ------------------------------------------------------------
//
// Task-shaped tools where Composio has them; a raw proxy to HubSpot's REST API
// (under the tenant's connected account) where it does not (notes search).

const connectedAccounts = new Map<string, Promise<string>>();
/** The tenant's active HubSpot connection in Composio's vault (cached per process). */
function hubspotAccountId(tenantId: string): Promise<string> {
  let p = connectedAccounts.get(tenantId);
  if (!p) {
    p = (async () => {
      const c = await client();
      const list = await c.connectedAccounts.list({ userIds: [tenantId], toolkitSlugs: ['hubspot'] });
      const active = list.items?.find((a) => a.status === 'ACTIVE') ?? list.items?.[0];
      if (!active) throw new Error(`no HubSpot connection for tenant ${tenantId}; run scripts/connect-composio.mts ${tenantId} hubspot`);
      return active.id;
    })();
    connectedAccounts.set(tenantId, p);
    p.catch(() => connectedAccounts.delete(tenantId));
  }
  return p;
}

/** Raw HubSpot REST call under the tenant's connected account. */
async function proxy(tenantId: string, method: 'GET' | 'POST' | 'PATCH', endpoint: string, body?: unknown): Promise<unknown> {
  const c = await client();
  const res = await c.tools.proxyExecute({ endpoint, method, connectedAccountId: await hubspotAccountId(tenantId), ...(body === undefined ? {} : { body }) });
  return res.data;
}

/** Transport the adapter runs on; injectable so the adapter is unit-testable. */
export interface CrmTransport {
  execute(slug: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  proxy(method: 'GET' | 'POST' | 'PATCH', endpoint: string, body?: unknown): Promise<unknown>;
}

/** Composio wraps some HubSpot responses as `response_data`; unwrap to the HubSpot payload. */
const unwrap = <T>(d: unknown): T => ((d as { response_data?: unknown })?.response_data ?? d) as T;

type HsContact = { id: string; properties?: Record<string, string | null> };
const CONTACT_PROPS = ['firstname', 'lastname', 'phone', 'mobilephone', 'email'];
const toContact = (r: HsContact): CrmContact => ({
  id: r.id,
  firstName: r.properties?.firstname ?? undefined,
  lastName: r.properties?.lastname ?? undefined,
  phone: r.properties?.phone ?? r.properties?.mobilephone ?? undefined,
  email: r.properties?.email ?? undefined,
});

const assoc = (contactId: string, typeId: number) => [
  { to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] },
];

export function crmAdapterOn(t: CrmTransport): CrmAdapter {
  let ownerId: Promise<string | undefined> | undefined;
  const defaultOwner = () =>
    (ownerId ??= t.execute('HUBSPOT_RETRIEVE_OWNERS', { limit: 1 })
      .then((d) => unwrap<{ results?: Array<{ id: string }> }>(d).results?.[0]?.id)
      .catch(() => undefined));

  const adapter: CrmAdapter = {
    async searchContacts(query, limit = 5) {
      const d = await t.execute('HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', { query, limit, properties: CONTACT_PROPS });
      return (unwrap<{ results?: HsContact[] }>(d).results ?? []).map(toContact);
    },

    async getContact(contactId) {
      const d = await t.execute('HUBSPOT_READ_CONTACT', { contactId, properties: CONTACT_PROPS }).catch(() => undefined);
      const r = d ? unwrap<HsContact>(d) : undefined;
      return r?.id ? toContact(r) : undefined;
    },

    async findContactByPhone(phone) {
      const digits = phone.replace(/\D/g, '');
      const eq = (propertyName: string, value: string) => ({ filters: [{ propertyName, operator: 'EQ', value }] });
      const d = await t.execute('HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
        filterGroups: [eq('phone', phone), eq('mobilephone', phone), eq('hs_searchable_calculated_phone_number', digits)],
        properties: CONTACT_PROPS,
        limit: 1,
      });
      const first = unwrap<{ results?: HsContact[] }>(d).results?.[0];
      return first ? toContact(first) : undefined;
    },

    async lastNote(contactId) {
      const d = await t.proxy('POST', '/crm/v3/objects/notes/search', {
        filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'EQ', value: contactId }] }],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
        properties: ['hs_note_body', 'hs_timestamp'],
        limit: 1,
      });
      const n = unwrap<{ results?: Array<{ properties?: { hs_note_body?: string | null; hs_timestamp?: string | null } }> }>(d).results?.[0]?.properties;
      if (!n?.hs_note_body) return undefined;
      return { body: htmlToText(n.hs_note_body), at: n.hs_timestamp ?? '' };
    },

    async upsertContact(input) {
      const existing = await adapter.findContactByPhone(input.phone);
      const props: Record<string, string> = {};
      if (input.firstName && !existing?.firstName) props.firstname = input.firstName;
      if (input.lastName && !existing?.lastName) props.lastname = input.lastName;
      if (existing) {
        if (Object.keys(props).length) await t.execute('HUBSPOT_UPDATE_CONTACT', { contactId: existing.id, properties: props });
        return { ...existing, firstName: existing.firstName ?? input.firstName, lastName: existing.lastName ?? input.lastName };
      }
      const created = unwrap<HsContact>(await t.execute('HUBSPOT_CREATE_CONTACT', { phone: input.phone, ...props }));
      if (!created?.id) throw new Error('HubSpot create contact returned no id');
      return { id: created.id, phone: input.phone, firstName: input.firstName, lastName: input.lastName };
    },

    async addNote(contactId, body, at = new Date()) {
      await t.execute('HUBSPOT_CREATE_NOTE', {
        hs_timestamp: at.toISOString(),
        hs_note_body: textToHtml(body),
        associations: assoc(contactId, HUBSPOT_NOTE_TO_CONTACT),
      });
    },

    async addTask(contactId, task) {
      const owner = await defaultOwner();
      await t.execute('HUBSPOT_CREATE_TASK', {
        hs_timestamp: task.dueAt.toISOString(),
        hs_task_subject: task.subject,
        hs_task_body: textToHtml(task.body),
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'MEDIUM',
        hs_task_type: 'TODO',
        ...(owner ? { hubspot_owner_id: owner } : {}),
        associations: assoc(contactId, HUBSPOT_TASK_TO_CONTACT),
      });
    },
  };
  return adapter;
}

/** The tenant's HubSpot, through Composio's vault. The tenant id is the only credential our code names. */
export function composioCrm(tenantId: string): CrmAdapter {
  return crmAdapterOn({
    execute: (slug, args) => execute(slug, tenantId, args),
    proxy: (method, endpoint, body) => proxy(tenantId, method, endpoint, body),
  });
}

// ---- LinkedIn -----------------------------------------------------------------
//
// The owner's personal LinkedIn through Composio's managed OAuth app. LinkedIn's
// member API is publish-only (no feed, inbox, or connections), so the surface
// is: who am I, publish a post, read a post back, delete a post. The author
// URN is resolved from the connected account, never supplied by the model.

export interface LinkedInProfile { id: string; name: string; headline?: string; email?: string }
export interface LinkedInPost { urn: string; text?: string; visibility?: string; createdAt?: string; reactions?: number }
export interface LinkedInAdapter {
  profile(): Promise<LinkedInProfile>;
  /** Publishes immediately. Returns the post URN (undefined if LinkedIn accepted the post but returned no id). */
  createPost(input: { text: string; visibility?: 'PUBLIC' | 'CONNECTIONS' }): Promise<{ urn?: string; raw?: unknown }>;
  getPost(urn: string): Promise<LinkedInPost | undefined>;
  deletePost(urn: string): Promise<void>;
}
export type ComposioExecute = (slug: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** `urn:li:share:…` / `urn:li:ugcPost:…` as given; a bare id is a share. */
const asPostUrn = (s: string) => (s.startsWith('urn:li:') ? s : `urn:li:share:${s}`);

export function linkedinAdapterOn(execute: ComposioExecute): LinkedInAdapter {
  let me: Promise<LinkedInProfile> | undefined;
  const profile = () => {
    me ??= execute('LINKEDIN_GET_MY_INFO', {}).then((d) => {
      const r = unwrap<{ sub?: string; id?: string; name?: string; given_name?: string; family_name?: string; localizedHeadline?: string; headline?: string; email?: string }>(d);
      const id = r.sub ?? r.id;
      if (!id) throw new Error('LinkedIn profile returned no member id');
      return { id, name: r.name ?? [r.given_name, r.family_name].filter(Boolean).join(' '), headline: r.localizedHeadline ?? r.headline, email: r.email };
    });
    me.catch(() => { me = undefined; });
    return me;
  };

  return {
    profile,

    async createPost({ text, visibility = 'PUBLIC' }) {
      const { id } = await profile();
      const d = await execute('LINKEDIN_CREATE_LINKED_IN_POST', { author: `urn:li:person:${id}`, commentary: text, visibility, lifecycleState: 'PUBLISHED' });
      const r = unwrap<{ urn?: string; id?: string; post_id?: string; post_urn?: string; share_id?: string }>(d);
      const urn = r.urn ?? r.post_urn ?? r.id ?? r.post_id ?? r.share_id;
      return urn ? { urn: asPostUrn(String(urn)) } : { raw: d };
    },

    async getPost(urn) {
      const postUrn = asPostUrn(urn);
      const d = await execute('LINKEDIN_GET_POST_CONTENT', { post_id: postUrn }).catch(() => undefined);
      if (!d) return undefined;
      const r = unwrap<{ id?: string; commentary?: string; text?: string; visibility?: string; createdAt?: number | string }>(d);
      const reactions = await execute('LINKEDIN_LIST_REACTIONS', { entity: postUrn, count: 1 })
        .then((x) => unwrap<{ paging?: { total?: number }; elements?: unknown[] }>(x))
        .then((x) => x.paging?.total ?? x.elements?.length)
        .catch(() => undefined);
      return {
        urn: postUrn,
        text: r.commentary ?? r.text,
        visibility: r.visibility,
        createdAt: typeof r.createdAt === 'number' ? new Date(r.createdAt).toISOString() : r.createdAt,
        reactions,
      };
    },

    async deletePost(urn) {
      await execute('LINKEDIN_DELETE_POST', { post_urn: asPostUrn(urn) });
    },
  };
}

/** The tenant owner's LinkedIn, through Composio's vault, keyed by tenant id. */
export function composioLinkedin(tenantId: string): LinkedInAdapter {
  return linkedinAdapterOn((slug, args) => execute(slug, tenantId, args));
}
