/**
 * My Assistant over SMS: one workflow per inbound text (the workflow id is
 * Twilio's MessageSid, so a redelivered webhook starts nothing twice).
 * Sender -> person -> tenant, plus the check only SMS can make: the number
 * texted must be that person's tenant's number. Then the agent loop with the
 * tenant's allowed tools, the reply as a text, the turn written to memory,
 * tokens metered.
 *
 * For a tenant with Facebook posts on, the turn also carries the Actions
 * ledger (../sms/facebook.ts): a texted photo reaches the model, the model
 * drafts, the workflow texts the draft from the ledger row, and the person's
 * POST publishes it without the model. The publish call is never retried: a
 * lost answer leaves the row `executing` with a note, for a person to
 * reconcile against the Page. A second post is worse than a missing one.
 *
 * Deterministic: every side effect is an activity; the workflow decides.
 */
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import { systemPrompt } from '../assistant/catalog.js';
import { APPROVAL_WORD, FACEBOOK_VERSION, allowedTools, draftMessage, facebookOn, facebookPrompt, isApproval, modelContent, postId, postLink } from '../sms/facebook.js';
import { mediaFromSms, textOrPhotos, type Sms } from '../sms/inbound.js';
import type { Photo } from '@wnk/shared/contracts';
import { orElse, runAssistantLoop, sessionDay } from './loop.js';

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
  const send = (body: string) => texts.sendText(sms.AccountSid!, sms.To!, sms.From!, body);

  // ---- Before the model: is this message the approval? ------------------------
  const fbOn = facebookOn(tenant);
  const inboundText = sms.Body;
  let draft = fbOn ? await ledger.findPending(tenantId, approver) : undefined;
  let photos = media;
  let mediaIsRecent = false;
  let imageLinks: string[] = [];
  if (fbOn) {
    if (isApproval(inboundText, draft) && await ledger.lockDraft(tenantId, draft!.sk, draft!.revision, approver, inboundText)) {
      return publishDraft(tenantId, tenant.phoneNumber, tenant.facebookPosts!.pageId!, tenant.facebookPosts!.pageName!, draft!, send);
    }
    if (media.length > 0) {
      await orElse(bestEffort.rememberMedia(tenantId, approver, media), undefined);
      // The model sees the photos it is asked to caption. Without the links the turn still runs, on the text alone.
      imageLinks = await orElse(bestEffort.mintLinks(tenant.phoneNumber, media), []);
    } else {
      const recent = await orElse(bestEffort.recentMedia(tenantId, approver), []);
      if (recent.length > 0) { photos = recent; mediaIsRecent = true; }
    }
  }

  // ---- The agent loop --------------------------------------------------------------
  const allowed = allowedTools(tenant.assistant?.tools ?? [], fbOn);
  const text = textOrPhotos(sms);
  const digits = sms.From.replace(/[^0-9]/g, '');
  const actorId = `${tenantId}_sms_${digits}`;
  const sessionId = `sms-chat-${digits}-${sessionDay(tenant.sessionDayOffsetMinutes)}`;
  const turn = await runAssistantLoop({
    tenantId, allowed, text, actorId, sessionId, approver, photos,
    prompt: systemPrompt(tenant, person, 'sms', fbOn ? facebookPrompt(draft, photos, mediaIsRecent) : ''),
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
  await reads.recordUsage(tenantId, approver, turn.tokens, turn.inputTokens, turn.outputTokens);
  return 'replied';
}

/** The row is locked (`executing`) on the revision the person approved: mint the photo links, post once, record the outcome, tell them. */
async function publishDraft(tenantId: string, tenantPhone: string, pageId: string, pageName: string, draft: { sk: string; payload: { caption: string; media: Photo[] } }, send: (body: string) => Promise<void>): Promise<SmsTurnOutcome> {
  // Nothing has been sent to Facebook yet, so a failure here is a clean one.
  let links: string[];
  try {
    links = await tools.mintLinks(tenantPhone, draft.payload.media);
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
    await send(`Posted to ${pageName}: ${postLink(pageId, id)}`);
    return 'posted';
  }
  await ledger.markFailed(tenantId, draft.sk, String(posted.error ?? 'rejected'));
  await send('Facebook did not accept that post, so nothing was published. Send it again to start a new draft.');
  return 'post-failed';
}

export { APPROVAL_WORD };
