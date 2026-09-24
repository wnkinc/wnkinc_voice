/**
 * Facebook posts from a chat, gated by the Actions ledger: the rules, as pure
 * functions the workflow applies. The split that makes the approval real:
 *   - The model proposes. Its two tools write and discard `pending` rows and
 *     nothing else. It has no publish tool; none may be added.
 *   - The workflow shows: after the model's turn it texts the draft word for
 *     word from the row, under the model's one-line reply, and records which
 *     revision the person was shown.
 *   - The person approves: their whole message is the approval word, matched
 *     before the model runs, on the revision they were shown.
 *   - The workflow executes: locks the row (pending -> executing, on that
 *     revision), presigns the photo links, posts once, records the outcome.
 * A prompt injection, or a model that misreads the person, can at most put a
 * draft in front of them.
 *
 * Photos are named things. Every photo a person texted is a row; the model
 * sees the recent ones as a labeled list with what each shows and whether it
 * was posted, names them in a draft by label, and the draft message names
 * them back by description. That is what a human assistant would know of
 * the thread, and it is why a photo from this morning is not attached to
 * this afternoon's post unasked.
 */
import { ACTION_APPROVAL_WORDS, type DraftRow, type InboundPhoto, type PhotoRef, type PhotoRow, type TenantRow } from '@wnk/shared/contracts';

/** Composio's Facebook toolkit release. Its oldest, which an unpinned call runs, cannot post to a Page. */
export const FACEBOOK_VERSION = '20260902_00';
export const ACTION_TYPE = 'facebook_post';
export const APPROVAL_WORD: string = ACTION_APPROVAL_WORDS.facebook_post;
export const APPROVAL_HOURS = 48;
/** How long a row stays as the log after it is written. */
export const LOG_DAYS = 400;
/** A draft is texted whole; Twilio refuses a body over 1600 characters. */
export const MAX_CAPTION_CHARS = 1200;
/** How long a texted photo's row (and its bytes, by the bucket's lifecycle rule) is kept. */
export const PHOTO_DAYS = 30;
/** How far back, and how many at most, the model is shown. */
export const PHOTO_LIST_DAYS = 7;
export const PHOTO_LIST_MAX = 20;
export const MAX_PHOTOS_PER_POST = 10;
export const FACEBOOK_TOOLS = ['draft_facebook_post', 'cancel_facebook_draft'] as const;

/** The tenant has the service on and the tools on its allow-list. */
export function facebookOn(tenant: TenantRow): boolean {
  return tenant.facebookPosts?.enabled === true && (tenant.assistant?.tools ?? []).includes(FACEBOOK_TOOLS[0]);
}

/** The row's allow-list, without the Facebook tools unless the tenant has the service on: a tool name on the row is not enough. */
export function allowedTools(tenantTools: readonly string[], on: boolean): string[] {
  return tenantTools.filter((t) => on || !(FACEBOOK_TOOLS as readonly string[]).includes(t));
}

/** The person's whole message is the approval word, and the pending draft is the revision they were shown. */
export function isApproval(inboundText: string, draft: DraftRow | undefined): boolean {
  return Boolean(draft?.sk) && draft!.shownRevision === draft!.revision && inboundText.trim().toUpperCase() === APPROVAL_WORD;
}

// ---- Photos as named things ---------------------------------------------------

/** The row for a photo this text carried, once its bytes are stored: the key from the store, the time and ids the workflow's. */
export function photoRow(tenantId: string, approver: string, p: InboundPhoto & { key: string }, receivedAt: string, nowEpoch: number): PhotoRow {
  return {
    tenantId, sk: `${approver}#photo#${receivedAt}#${p.mediaSid}`, approver, channel: 'sms',
    key: p.key, contentType: p.contentType, receivedAt, expiresAt: nowEpoch + PHOTO_DAYS * 86400,
  };
}

/** The label the model uses for the i-th photo of the list it was shown (`p1`, oldest first). Labels hold for one turn: the tool call happens in the turn that showed them. */
export const photoLabel = (i: number) => `p${i + 1}`;

/** When a photo arrived, as the person would say it: the weekday and time in the business's timezone. */
export function whenText(iso: string, tz: string, now: string): string {
  const d = new Date(iso);
  const sameDay = d.toLocaleDateString('en-US', { timeZone: tz }) === new Date(now).toLocaleDateString('en-US', { timeZone: tz });
  const time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

/** The photos as the model sees them: one line each, labeled, with what it shows and whether it went out. */
export function photoList(photos: PhotoRow[], tz: string, now: string): string {
  if (photos.length === 0) return ' They have sent no photos recently, so a draft can have no photos until they text one.';
  const lines = photos.map((p, i) => `[${photoLabel(i)}] ${whenText(p.receivedAt, tz, now)}: ${p.description ?? 'photo'}${p.postedIn ? ` (already posted${p.postedAt ? ` ${whenText(p.postedAt, tz, now)}` : ''})` : ''}`);
  return ` Photos they have texted, oldest first; name the ones a draft should carry by label: ${lines.join(' | ')}. A photo marked already posted goes in a new post only if they ask for it. When they say "this photo" or "the one I just sent" they mean the newest ones.`;
}

/**
 * The model's `photos` argument (labels from the list it was shown) as the
 * draft's photo refs, or a reason it cannot be. Unknown labels, duplicates
 * and more than a post can carry are refused, not guessed.
 */
export function resolvePhotos(labels: unknown, photos: PhotoRow[]): { refs: PhotoRef[] } | { error: string } {
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string')) return { error: 'photos must be a list of labels from the photo list, such as ["p1"], or [] for none.' };
  const seen = new Set<string>();
  const refs: PhotoRef[] = [];
  for (const raw of labels as string[]) {
    const label = raw.trim().toLowerCase();
    const i = photos.findIndex((_, n) => photoLabel(n) === label);
    if (i < 0) return { error: `There is no photo ${raw}. The photos available are ${photos.map((_, n) => photoLabel(n)).join(', ') || 'none'}.` };
    if (seen.has(label)) continue;
    seen.add(label);
    const p = photos[i]!;
    refs.push({ sk: p.sk, key: p.key, description: p.description ?? 'photo' });
  }
  if (refs.length > MAX_PHOTOS_PER_POST) return { error: `A post carries at most ${MAX_PHOTOS_PER_POST} photos.` };
  return { refs };
}

/** What the person approves, word for word from the row: the caption, and the photos by what they show. */
export function draftMessage(pageName: string, row: DraftRow): string {
  const m = row.payload.media;
  const photos = m.length === 0 ? 'No photos. ' : m.length === 1 ? `With 1 photo: ${m[0]!.description}. ` : `With ${m.length} photos: ${m.map((p) => p.description).join('; ')}. `;
  return `Draft for the Facebook Page ${pageName}:\n\n${row.payload.caption}\n\n${photos}Reply ${APPROVAL_WORD} to publish it, or tell me what to change. Nothing is posted until you reply with just the one word ${APPROVAL_WORD}. This draft expires in ${APPROVAL_HOURS} hours.`;
}

/** What the model is told about drafting, the pending draft, and the photos it may name. */
export function facebookPrompt(draft: DraftRow | undefined, photos: PhotoRow[], tz: string, now: string): string {
  const drafting = ` You can draft posts for the business Facebook Page with ${FACEBOOK_TOOLS[0]}. You never publish: the system shows the person the exact draft and how to approve it, and only their approval publishes it. After drafting, your reply is the one line shown above that draft: say what you did or changed, in one short sentence. Do not repeat the caption and do not explain how to approve. Never say a post was published.`;
  const pending = draft?.sk ? ` There is a pending draft: ${draft.payload.caption} (photos: ${draft.payload.media.map((p) => p.description).join('; ') || 'none'}). Change it with ${FACEBOOK_TOOLS[0]}, naming its photos again or others, or discard it with ${FACEBOOK_TOOLS[1]} if they no longer want it.` : '';
  return drafting + pending + photoList(photos, tz, now);
}

/** The post id from a Composio result: photo tools answer `post_id`, the text tool `id`. */
export function postId(body: { data?: { post_id?: string; id?: string } }): string | undefined {
  return body.data?.post_id ?? body.data?.id;
}

/**
 * The link texted after a post. Facebook answers `<pageId>_<postId>`; the bare `facebook.com/<that>` form
 * redirects on the web but the Facebook app cannot resolve it ("This content isn't available"), so the
 * link is the `/posts/` permalink shape the app opens.
 */
export function postLink(pageId: string, id: string): string {
  return `https://www.facebook.com/${pageId}/posts/${id.split('_').pop()}`;
}

/** The user message for the model: the text, plus this text's photos when their links were presigned. */
export function modelContent(text: string, imageLinks: string[]): string | { type: string; text?: string; image_url?: string }[] {
  if (imageLinks.length === 0) return text;
  return [{ type: 'input_text', text }, ...imageLinks.map((image_url) => ({ type: 'input_image', image_url }))];
}

/** The tool result after a draft was written or revised. */
export function draftedNote(photos: PhotoRef[]): string {
  return JSON.stringify({
    ok: true,
    photos_on_draft: photos.map((p) => p.description),
    note: (photos.length === 0 ? 'The draft has NO photos. Tell the person that, and that they can text a photo to add. ' : `The draft has ${photos.length} photos: ${photos.map((p) => p.description).join('; ')}. `)
      + 'Your reply is shown as the line above the draft: one short sentence on what you did or changed. Do not repeat the caption, do not explain how to approve, do not say it was posted.',
  });
}
