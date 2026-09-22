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
 *     revision), mints the photo links, posts once, records the outcome.
 * A prompt injection, or a model that misreads the person, can at most put a
 * draft in front of them.
 */
import type { DraftRow, Photo, TenantRow } from '../types.js';

/** Composio's Facebook toolkit release. Its oldest, which an unpinned call runs, cannot post to a Page. */
export const FACEBOOK_VERSION = '20260902_00';
export const ACTION_TYPE = 'facebook_post';
/** ACTION_APPROVAL_WORDS.facebook_post in @wnk/shared (kept in step by a test). */
export const APPROVAL_WORD = 'POST';
export const APPROVAL_HOURS = 48;
/** How long a row stays as the log after it is written. */
export const LOG_DAYS = 400;
/** A draft is texted whole; Twilio refuses a body over 1600 characters. */
export const MAX_CAPTION_CHARS = 1200;
/** How long a person's texted photos stay available to a later text. */
export const RECENT_MEDIA_HOURS = 6;
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

/** The draft's photos after the model's `photos` choice; `existing` is the row's list (none, for a new draft). */
export function nextMedia(choice: string, existing: Photo[], media: Photo[]): Photo[] {
  switch (choice) {
    case 'use_new': return [...media];
    case 'add_new': return [...existing, ...media];
    case 'none': return [];
    default: return [...existing];
  }
}

/** What the person approves, word for word from the row. */
export function draftMessage(pageName: string, row: DraftRow): string {
  const n = row.payload.media.length;
  const photos = n === 0 ? 'No photos. ' : n === 1 ? 'With the 1 photo you sent. ' : `With the ${n} photos you sent. `;
  return `Draft for the Facebook Page ${pageName}:\n\n${row.payload.caption}\n\n${photos}Reply ${APPROVAL_WORD} to publish it, or tell me what to change. Nothing is posted until you reply ${APPROVAL_WORD}. This draft expires in ${APPROVAL_HOURS} hours.`;
}

/** What the model is told about drafting, and about the draft and photos in front of it. */
export function facebookPrompt(draft: DraftRow | undefined, media: Photo[], mediaIsRecent: boolean): string {
  const drafting = ` You can draft posts for the business Facebook Page with ${FACEBOOK_TOOLS[0]}. You never publish: the system shows the person the exact draft and how to approve it, and only their approval publishes it. After drafting, your reply is the one line shown above that draft: say what you did or changed, in one short sentence. Do not repeat the caption and do not explain how to approve. Never say a post was published.`;
  const pending = draft?.sk ? ` There is a pending draft: ${draft.payload.caption} (${draft.payload.media.length} photos). Change it with ${FACEBOOK_TOOLS[0]}, or discard it with ${FACEBOOK_TOOLS[1]} if they no longer want it.` : '';
  const photos = media.length > 0
    ? (mediaIsRecent ? ` They sent ${media.length} photos in a recent message; those are the photos available for the draft.` : ` This message came with ${media.length} photos.`)
    : ' No photos are available for a draft.';
  return drafting + pending + photos;
}

/** The post id from a Composio result: photo tools answer `post_id`, the text tool `id`. */
export function postId(body: { data?: { post_id?: string; id?: string } }): string | undefined {
  return body.data?.post_id ?? body.data?.id;
}

/** The user message for the model: the text, plus the photos when their links were minted. */
export function modelContent(text: string, imageLinks: string[]): string | { type: string; text?: string; image_url?: string }[] {
  if (imageLinks.length === 0) return text;
  return [{ type: 'input_text', text }, ...imageLinks.map((image_url) => ({ type: 'input_image', image_url }))];
}

/** The tool result after a draft was written or revised. */
export function draftedNote(photos: number): string {
  return JSON.stringify({
    ok: true,
    photos_on_draft: photos,
    note: (photos === 0 ? 'The draft has NO photos. Tell the person that, and that they can text a photo to add. ' : `The draft has ${photos} photos. `)
      + 'Your reply is shown as the line above the draft: one short sentence on what you did or changed. Do not repeat the caption, do not explain how to approve, do not say it was posted.',
  });
}
