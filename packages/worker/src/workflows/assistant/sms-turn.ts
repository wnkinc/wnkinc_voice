/**
 * My Assistant over SMS: one workflow per inbound text (the workflow id is
 * Twilio's MessageSid, so a redelivered webhook starts nothing twice).
 * Sender -> person -> tenant, plus the check only SMS can make: the number
 * texted must be that person's tenant's number. Then the agent loop with the
 * tenant's allowed tools, the reply as a text, the turn written to memory,
 * tokens metered.
 *
 * For a tenant with Facebook posts on, the turn also carries the Actions
 * ledger (rules/facebook.ts): a texted photo is stored and described and
 * becomes a row the model can name, the model drafts, the workflow texts the
 * draft from the ledger row, and the person's POST publishes it without the
 * model. The publish call is never retried: a lost answer leaves the row
 * `executing` with a note, for a person to reconcile against the Page. A
 * second post is worse than a missing one.
 *
 * Deterministic: every side effect is an activity; the workflow decides.
 */
import { proxyActivities, upsertSearchAttributes } from '@temporalio/workflow';
import type * as activities from '../../activities/index.js';
import type { PhotoRef, PhotoRow } from '@wnk/shared/contracts';
import { systemPrompt } from '../../rules/assistant.js';
import { APPROVAL_WORD, FACEBOOK_VERSION, allowedTools, draftMessage, facebookOn, facebookPrompt, isApproval, modelContent, photoRow, postId, postLink } from '../../rules/facebook.js';
import { mediaFromSms, textOrPhotos, type Sms } from '../../rules/sms.js';
import { TENANT_ID } from '../../search-attributes.js';
import { orElse } from '../common.js';
import { runAssistantLoop, sessionDay } from './loop.js';

type Activities = typeof activities;
const reads = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const ledger = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 3 } });
const texts = proxyActivities<Activities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 2, initialInterval: '2 seconds' } });
const tools = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 2 } });
/** Photos and memory: a failure costs only that; the turn still answers. */
const bestEffort = proxyActivities<Activities>({ startToCloseTimeout: '20 seconds', retry: { maximumAttempts: 2 } });
/** The one call that reaches the Page: one attempt, ever. An unknown outcome is reconciled by a person, not by a retry. */
const publish = proxyActivities<Activities>({ startToCloseTimeout: '60 seconds', retry: { maximumAttempts: 1 } });

export interface SmsTurnInput { sms: Sms }
export type SmsTurnOutcome = 'ignored' | 'unknown-sender' | 'assistant-off' | 'replied' | 'posted' | 'post-failed' | 'post-unconfirmed';

export async function smsTurn({ sms }: SmsTurnInput): Promise<SmsTurnOutcome> {
  const media = mediaFromSms(sms);
  if (!sms.From || !sms.To || !sms.AccountSid || sms.Body === undefined || ((sms.Body.trim() === '') && media.length === 0)) return 'ignored';

  // The sender must be listed, and must have texted their own tenant's number:
  // a person of one business texting another business's number is a stranger to it.
  const approver = `sms:${sms.From}`;
  const person = await reads.lookupPerson(approver);
  if (!person?.tenantPhone || person.tenantPhone !== sms.To) return 'unknown-sender';
  const tenant = await reads.lookupTenant(person.tenantPhone);
  if (!tenant || tenant.assistant?.enabled !== true) return 'assistant-off';
  const tenantId = tenant.tenantId;
  // Known only now: the sender named the tenant, the starter could not.
  upsertSearchAttributes([{ key: TENANT_ID, value: tenantId }]);
  const send = (body: string) => texts.sendText(sms.AccountSid!, sms.To!, sms.From!, body);

  // ---- Before the model: is this message the approval? ------------------------
  const fbOn = facebookOn(tenant);
  const inboundText = sms.Body;
  const now = new Date().toISOString();
  const draft = fbOn ? await ledger.findPending(tenantId, approver) : undefined;
  let photos: PhotoRow[] = [];
  let imageLinks: string[] = [];
  let described = { tokens: 0, inputTokens: 0, outputTokens: 0 };
  if (fbOn) {
    if (isApproval(inboundText, draft) && await ledger.lockDraft(tenantId, draft!.sk, draft!.revision, approver, inboundText)) {
      return publishDraft(tenantId, tenant.facebookPosts!.pageId!, tenant.facebookPosts!.pageName!, draft!, send);
    }
    // This text's photos become rows the model can name: stored under the
    // tenant, described once by a vision call, shown to the model as links so
    // it can caption them. Each step is best effort: without it the turn
    // still runs, and a photo without a description is still "photo".
    if (media.length > 0) {
      const stored = await orElse(tools.storePhotos(tenantId, tenant.phoneNumber, media), []);
      if (stored.length > 0) {
        const rows = stored.map((p) => photoRow(tenantId, approver, p, now, Math.floor(Date.parse(now) / 1000)));
        await orElse(ledger.putPhotos(rows), undefined);
        imageLinks = await orElse(bestEffort.presign(rows.map((r) => r.key)), []);
        if (imageLinks.length === rows.length) {
          const d = await orElse(tools.describeImages(imageLinks), undefined);
          if (d) {
            described = d;
            await orElse(bestEffort.describePhotoRows(tenantId, rows.map((r) => r.sk), d.descriptions), undefined);
          }
        }
      }
    }
    photos = await orElse(bestEffort.listPhotos(tenantId, approver), []);
  }

  // ---- The agent loop --------------------------------------------------------------
  const allowed = allowedTools(tenant.assistant?.tools ?? [], fbOn);
  const text = textOrPhotos(sms);
  const digits = sms.From.replace(/[^0-9]/g, '');
  const actorId = `${tenantId}_sms_${digits}`;
  const sessionId = `sms-chat-${digits}-${sessionDay(tenant.sessionDayOffsetMinutes)}`;
  const slugs = Object.values(tenant.assistant?.composioTools ?? {}).flat();
  const composioTools = slugs.length > 0 ? await reads.composioToolDefs(slugs) : [];
  const tz = tenant.business.timezone ?? 'America/Los_Angeles';
  const turn = await runAssistantLoop({
    tenantId, allowed, text, actorId, sessionId, approver, photos, composioTools,
    prompt: systemPrompt(tenant, person, 'sms', fbOn ? facebookPrompt(draft, photos, tz, now) : '', now),
    content: modelContent(text, imageLinks),
  });
  const reply = turn.reply;

  // ---- After the model: show the person what the row says ------------------------
  // A pending revision the person has not been sent goes out as one text, the
  // model's reply above the draft from the row, and is recorded as shown; only
  // then can POST approve it. Reads the row, not the turn: a send that failed
  // last time goes out now.
  const shown = fbOn ? await orElse(bestEffort.findPending(tenantId, approver), undefined) : undefined;
  if (shown && shown.shownRevision < shown.revision) {
    await send(`${reply}\n\n${draftMessage(tenant.facebookPosts!.pageName!, shown)}`);
    await ledger.markShown(tenantId, shown.sk, shown.revision);
  } else {
    await send(reply);
  }
  await orElse(bestEffort.saveTurn(actorId, sessionId, text, reply), undefined);
  await reads.recordUsage(tenantId, approver, turn.tokens + described.tokens, turn.inputTokens + described.inputTokens, turn.outputTokens + described.outputTokens);
  return 'replied';
}

/** The row is locked (`executing`) on the revision the person approved: presign the photo links, post once, record the outcome, tell them. */
async function publishDraft(tenantId: string, pageId: string, pageName: string, draft: { sk: string; payload: { caption: string; media: PhotoRef[] } }, send: (body: string) => Promise<void>): Promise<SmsTurnOutcome> {
  // Nothing has been sent to Facebook yet, so a failure here is a clean one.
  let links: string[];
  try {
    links = await tools.presign(draft.payload.media.map((p) => p.key));
  } catch {
    await ledger.markFailed(tenantId, draft.sk, 'could not fetch the photos');
    await send('Facebook did not accept that post, so nothing was published. Send it again to start a new draft.');
    return 'post-failed';
  }
  const caption = draft.payload.caption;
  const [slug, args] = links.length === 0 ? ['FACEBOOK_CREATE_POST', { page_id: pageId, message: caption }]
    : links.length === 1 ? ['FACEBOOK_CREATE_PHOTO_POST', { page_id: pageId, message: caption, url: links[0] }]
      : ['FACEBOOK_CREATE_MULTI_PHOTO_POST', { page_id: pageId, message: caption, photo_urls: links }];
  let posted: Awaited<ReturnType<Activities['executeTool']>>;
  try {
    posted = await publish.executeTool(tenantId, slug, args, FACEBOOK_VERSION);
  } catch {
    // The call errored or timed out: Facebook may or may not have the post. The row stays `executing`.
    await ledger.markUnconfirmed(tenantId, draft.sk);
    await send('I could not confirm whether that post went out. Check the Page before trying again.');
    return 'post-unconfirmed';
  }
  if (posted.successful === true) {
    const id = postId(posted) ?? '';
    await ledger.markCompleted(tenantId, draft.sk, id);
    await orElse(bestEffort.markPhotosPosted(tenantId, draft.payload.media.map((p) => p.sk), draft.sk), undefined);
    await send(`Posted to ${pageName}: ${postLink(pageId, id)}`);
    return 'posted';
  }
  await ledger.markFailed(tenantId, draft.sk, String(posted.error ?? 'rejected'));
  await send('Facebook did not accept that post, so nothing was published. Send it again to start a new draft.');
  return 'post-failed';
}

export { APPROVAL_WORD };
