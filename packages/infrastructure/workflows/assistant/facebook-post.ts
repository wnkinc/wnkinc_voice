/**
 * Facebook posts from a chat, gated by the Actions ledger (@wnk/shared
 * ActionSchema). Three sets of states a channel workflow spreads in; SMS is
 * the first. A channel supplies how to text the person and, before any of
 * these run, assigns: $tenant, $approver (the person's channel id), $media
 * (this message's photos, DynamoDB-typed), $inboundText (their message as
 * received), $draft ({}), $mediaIsRecent (false).
 *
 * Phones send the photo first and the words after, as separate texts. So a
 * message's photos are remembered (one row per person, RECENT_MEDIA_HOURS,
 * the table's TTL) and a later text without photos gets them as $media, with
 * $mediaIsRecent set: the draft tool can attach them, the model is told they
 * are from a recent message, and their links are not minted again.
 *
 * The split that makes the approval real:
 *   - The model proposes. Its two tools write and discard `pending` rows and
 *     nothing else. It has no publish tool; none may be added.
 *   - The workflow shows. After the model's turn it texts the draft word for
 *     word from the row, under the model's one-line reply, in one text, and
 *     records which revision the person was shown.
 *   - The person approves. Their whole message is the approval word, matched
 *     here before the model runs, on the revision they were shown.
 *   - The workflow executes. It locks the row (pending -> executing, on that
 *     revision), mints the photo links, posts, and records the outcome.
 * A prompt injection, or a model that misreads the person, can at most put a
 * draft in front of them.
 *
 * The publish call is never retried: a lost answer leaves the row `executing`
 * with a note, for a person to reconcile against the Page. A second post is
 * worse than a missing one.
 */
import { composio, q } from '../asl.js';

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

export interface FacebookPostRefs {
  actionsTable: string;
  /** The media link resolver (packages/media-link): texted photo ids -> a link Facebook and the model can fetch. */
  mediaLinkFunctionArn: string;
  composioConnectionArn: string;
}

/** A state that texts `bodyExpr` (a JSONata fragment) to the person; the caller of these builders adds nothing else. */
export type Send = (bodyExpr: string, next: string) => Record<string, unknown>;

// ---- Expressions (exported unwrapped so the tests can evaluate them) ---------

const epoch = '$floor($millis() / 1000)';
/** The tenant has the service on and the tools on its allow-list. */
export const facebookOnExpr = `$tenant.facebookPosts.M.enabled.BOOL = true and '${FACEBOOK_TOOLS[0]}' in [$tenant.assistant.M.tools.L.S]`;
/** The newest pending row of a query result, or {}. */
export const pendingExpr = (resultExpr: string) => `${resultExpr}.Count > 0 ? ${resultExpr}.Items[0] : {}`;
/** The person's whole message is the approval word, and the pending draft is the revision they were shown. */
export const isApprovalExpr = `$exists($draft.sk) and $draft.shownRevision.N = $draft.revision.N and $uppercase($trim($inboundText)) = '${APPROVAL_WORD}'`;
/** The draft's photos after the model's `photos` choice; `existing` is the row's list (nothing, for a new draft). */
export const nextMediaExpr = (existing: string) =>
  `$a.photos = 'use_new' ? [$media] : $a.photos = 'add_new' ? [$append(${existing}, $media)] : $a.photos = 'none' ? [] : [${existing}]`;
/** What the person approves, word for word from the row. */
export const draftMessageExpr = (row: string) => [
  `'Draft for the Facebook Page ' & $tenant.facebookPosts.M.pageName.S & ':\\n\\n' & ${row}.payload.M.caption.S & '\\n\\n'`,
  `($n := $count([${row}.payload.M.media.L]); $n = 0 ? 'No photos. ' : $n = 1 ? 'With the 1 photo you sent. ' : 'With the ' & $n & ' photos you sent. ')`,
  `'Reply ${APPROVAL_WORD} to publish it, or tell me what to change. Nothing is posted until you reply ${APPROVAL_WORD}. This draft expires in ${APPROVAL_HOURS} hours.'`,
].join(' & ');
/** The post id from a Composio result: photo tools answer `post_id`, the text tool `id`. */
export const postIdExpr = (body: string) => `$exists(${body}.data.post_id) ? ${body}.data.post_id : ${body}.data.id`;
/** What the model is told about drafting, and about the draft and photos in front of it. */
export const facebookPromptExpr = [
  `' You can draft posts for the business Facebook Page with ${FACEBOOK_TOOLS[0]}. You never publish: the system shows the person the exact draft and how to approve it, and only their approval publishes it. After drafting, your reply is the one line shown above that draft: say what you did or changed, in one short sentence. Do not repeat the caption and do not explain how to approve. Never say a post was published.'`,
  `($exists($draft.sk) ? ' There is a pending draft: ' & $draft.payload.M.caption.S & ' (' & $string($count([$draft.payload.M.media.L])) & ' photos). Change it with ${FACEBOOK_TOOLS[0]}, or discard it with ${FACEBOOK_TOOLS[1]} if they no longer want it.' : '')`,
  `($count($media) > 0 ? ($mediaIsRecent ? ' They sent ' & $string($count($media)) & ' photos in a recent message; those are the photos available for the draft.' : ' This message came with ' & $string($count($media)) & ' photos.') : ' No photos are available for a draft.')`,
].join(' & ');
/** The user message for the model: the text, plus the photos when their links were minted. */
export const contentExpr = "($count($imageLinks) > 0 ? [$append([{ 'type': 'input_text', 'text': $text }], [$imageLinks.{ 'type': 'input_image', 'image_url': $ }])] : $text)";

// ---- Shared pieces -----------------------------------------------------------

const rowKey = (row: string) => ({ tenantId: { S: q(`${row}.tenantId.S`) }, sk: { S: q(`${row}.sk.S`) } });
/** The person's remembered photos: one row, overwritten, not an action. */
const recentKey = { tenantId: { S: q('$tenant.tenantId.S') }, sk: { S: q("$approver & '#media'") } };

/** The person's pending, unexpired draft, newest first. Generic integration: the optimized one has no Query. */
const findPending = (refs: FacebookPostRefs) => ({
  Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:dynamodb:query',
  Arguments: {
    TableName: refs.actionsTable,
    KeyConditionExpression: 'tenantId = :t AND begins_with(sk, :p)',
    FilterExpression: '#s = :pending AND approveBy > :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':t': { S: q('$tenant.tenantId.S') }, ':p': { S: q(`$approver & '#${ACTION_TYPE}#'`) },
      ':pending': { S: 'pending' }, ':now': { N: q(`$string(${epoch})`) },
    },
    ScanIndexForward: false,
  },
});

/** Texted photo ids -> links, one resolver call each. The resolver refuses a photo not texted to this tenant's number. `name`: state names are unique across a machine, Map processors included. */
const mintLinks = (refs: FacebookPostRefs, itemsExpr: string, name: string) => ({
  Type: 'Map', Items: q(itemsExpr), MaxConcurrency: 3,
  ItemProcessor: {
    ProcessorConfig: { Mode: 'INLINE' }, StartAt: name,
    States: {
      [name]: {
        Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke',
        Arguments: { FunctionName: refs.mediaLinkFunctionArn, Payload: { tenantPhone: q('$tenant.phoneNumber.S'), messageSid: q('$states.input.M.messageSid.S'), mediaSid: q('$states.input.M.mediaSid.S') } },
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'], IntervalSeconds: 1, MaxAttempts: 2, BackoffRate: 2 }],
        Output: q('$states.result.Payload.url'), End: true,
      },
    },
  },
});

// ---- Before the model: is this message the approval? --------------------------

/**
 * Enters at `FindDraft`. The approval word on the shown revision goes to
 * `Lock` and never reaches the model; anything else goes on to `toModel`,
 * with the photos' links minted for the model to look at (`$imageLinks`).
 */
export function facebookApprovalStates(refs: FacebookPostRefs, send: Send, toModel: string, done: string) {
  const fb = composio(refs.composioConnectionArn, q('$tenant.tenantId.S'));
  const publish = (slug: string, args: Record<string, unknown>) => {
    const { Retry: _never, ...task } = fb.execute(slug, args, FACEBOOK_VERSION);
    return {
      ...task, TimeoutSeconds: 60,
      Assign: { posted: q('$states.result.ResponseBody') },
      Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'Unconfirmed' }],
      Output: q('$states.input'), Next: 'DidPost',
    };
  };
  // `status`, `result` and `error` are DynamoDB reserved words; it rejects a name an expression does not use.
  const mark = (set: string, names: Record<string, string>, values: Record<string, unknown>, next: string) => ({
    Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
    Arguments: {
      TableName: refs.actionsTable, Key: rowKey('$draft'),
      UpdateExpression: `SET ${set}, updatedAt = :now`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ':now': { S: q('$now()') }, ...values },
    },
    Output: q('$states.input'), Next: next,
  });
  const page = q('$tenant.facebookPosts.M.pageId.S');
  const caption = q('$draft.payload.M.caption.S');

  return {
    FindDraft: { ...findPending(refs), Assign: { draft: q(pendingExpr('$states.result')) }, Output: q('$states.input'), Next: 'IsApproval' },
    IsApproval: { Type: 'Choice', Choices: [{ Condition: q(isApprovalExpr), Next: 'Lock' }, { Condition: q('$count($media) > 0'), Next: 'RememberMedia' }], Default: 'RecentMedia' },
    // This message's photos, kept for the texts that follow. A failure here costs only that.
    RememberMedia: {
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
      Arguments: { TableName: refs.actionsTable, Item: { ...recentKey, media: { L: q('$media') }, updatedAt: { S: q('$now()') }, expiresAt: { N: q(`$string(${epoch} + ${RECENT_MEDIA_HOURS} * 3600)`) } } },
      Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'ModelLinks' }],
      Output: q('$states.input'), Next: 'ModelLinks',
    },
    // The model sees the photos it is asked to caption. Without the links the turn still runs, on the text alone.
    ModelLinks: { ...mintLinks(refs, '$media', 'ModelLink'), Assign: { imageLinks: q('$states.result') }, Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: toModel }], Output: q('$states.input'), Next: toModel },
    // No photos on this text: the ones from a recent text, if any (the TTL deletes the row late; check the time).
    RecentMedia: {
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
      Arguments: { TableName: refs.actionsTable, Key: recentKey },
      Assign: { media: q(`$exists($states.result.Item) and $number($states.result.Item.expiresAt.N) > ${epoch} ? [$states.result.Item.media.L] : []`), mediaIsRecent: q(`$exists($states.result.Item) and $number($states.result.Item.expiresAt.N) > ${epoch}`) },
      Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: toModel }],
      Output: q('$states.input'), Next: toModel,
    },

    // pending -> executing, only on the revision they were shown and only
    // once: a second POST, or one that crossed a revision, finds no pending
    // row at that revision and goes to the model, which has no way to publish.
    Lock: {
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
      Arguments: {
        TableName: refs.actionsTable, Key: rowKey('$draft'),
        UpdateExpression: 'SET #s = :executing, approvedAt = :now, approvedBy = :who, approvalText = :text, updatedAt = :now',
        ConditionExpression: '#s = :pending AND revision = :rev AND shownRevision = :rev AND approveBy > :epoch',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':executing': { S: 'executing' }, ':pending': { S: 'pending' }, ':now': { S: q('$now()') },
          ':who': { S: q('$approver') }, ':text': { S: q('$inboundText') },
          ':rev': { N: q('$draft.revision.N') }, ':epoch': { N: q(`$string(${epoch})`) },
        },
      },
      Catch: [{ ErrorEquals: ['DynamoDB.ConditionalCheckFailedException'], Output: q('$states.input'), Next: toModel }],
      Output: q('$states.input'), Next: 'PostLinks',
    },
    // Nothing has been sent to Facebook yet, so a failure here is a clean one.
    PostLinks: { ...mintLinks(refs, '[$draft.payload.M.media.L]', 'PostLink'), Assign: { links: q('$states.result') }, Catch: [{ ErrorEquals: ['States.ALL'], Assign: { posted: { error: 'could not fetch the photos' } }, Output: q('$states.input'), Next: 'MarkFailed' }], Output: q('$states.input'), Next: 'HowMany' },
    HowMany: { Type: 'Choice', Choices: [{ Condition: q('$count($links) = 0'), Next: 'PostText' }, { Condition: q('$count($links) = 1'), Next: 'PostPhoto' }], Default: 'PostPhotos' },
    PostText: publish('FACEBOOK_CREATE_POST', { page_id: page, message: caption }),
    PostPhoto: publish('FACEBOOK_CREATE_PHOTO_POST', { page_id: page, message: caption, url: q('$links[0]') }),
    PostPhotos: publish('FACEBOOK_CREATE_MULTI_PHOTO_POST', { page_id: page, message: caption, photo_urls: q('$links') }),
    DidPost: { Type: 'Choice', Choices: [{ Condition: q('$posted.successful = true'), Next: 'MarkCompleted' }], Default: 'MarkFailed' },

    MarkCompleted: mark('#s = :completed, completedAt = :now, #r = :result', { '#s': 'status', '#r': 'result' }, { ':completed': { S: 'completed' }, ':result': { M: { postId: { S: q(postIdExpr('$posted')) } } } }, 'TellPosted'),
    MarkFailed: mark('#s = :failed, #e = :error', { '#s': 'status', '#e': 'error' }, { ':failed': { S: 'failed' }, ':error': { S: q("$substring($string($exists($posted.error) and $posted.error != null ? $posted.error : 'rejected'), 0, 500)") } }, 'TellFailed'),
    // The call errored or timed out: Facebook may or may not have the post. The row stays `executing`.
    Unconfirmed: mark('#e = :error', { '#e': 'error' }, { ':error': { S: 'outcome unknown: the publish call did not answer' } }, 'TellUnconfirmed'),

    TellPosted: send(`'Posted to ' & $tenant.facebookPosts.M.pageName.S & ': https://www.facebook.com/' & (${postIdExpr('$posted')})`, done),
    TellFailed: send("'Facebook did not accept that post, so nothing was published. Send it again to start a new draft.'", done),
    TellUnconfirmed: send("'I could not confirm whether that post went out. Check the Page before trying again.'", done),
  } as Record<string, any>;
}

// ---- The model's two tools (states inside the loop's tool Map) ------------------

/** `Run_draft_facebook_post` and `Run_cancel_facebook_draft`; failures go to the Map's `Failed`. */
export function facebookToolRunners(refs: FacebookPostRefs) {
  const out = (value: string) => q(`{ 'call_id': $callId, 'output': $string(${value}) }`);
  const failed = [{ ErrorEquals: ['States.ALL'], Next: 'Failed' }];
  const drafted = "{ 'ok': true, 'photos_on_draft': $count($next), 'note': ($count($next) = 0 ? 'The draft has NO photos. Tell the person that, and that they can text a photo to add. ' : 'The draft has ' & $string($count($next)) & ' photos. ') & 'Your reply is shown as the line above the draft: one short sentence on what you did or changed. Do not repeat the caption, do not explain how to approve, do not say it was posted.' }";
  // Assigned in its own state: a state's Output cannot read what the same state assigns.
  const payload = { M: { caption: { S: q('$a.caption') }, media: { L: q('$next') } } };

  return {
    Run_draft_facebook_post: {
      Type: 'Choice',
      Choices: [{ Condition: q(`$length($trim($a.caption)) = 0 or $length($a.caption) > ${MAX_CAPTION_CHARS}`), Next: 'Draft_BadCaption' }],
      Default: 'Draft_Find',
    },
    Draft_BadCaption: { Type: 'Pass', Output: out(`{ 'error': 'The caption must be 1 to ${MAX_CAPTION_CHARS} characters so the draft fits in one text message.' }`), End: true },
    // Asked again inside the turn, not read from $draft: the model may draft twice in one turn.
    Draft_Find: { ...findPending(refs), Assign: { row: q(pendingExpr('$states.result')) }, Catch: failed, Output: q('$states.input'), Next: 'Draft_Photos' },
    Draft_Photos: { Type: 'Pass', Assign: { next: q(nextMediaExpr('$row.payload.M.media.L')) }, Output: q('$states.input'), Next: 'Draft_Exists' },
    Draft_Exists: { Type: 'Choice', Choices: [{ Condition: q('$exists($row.sk)'), Next: 'Draft_Revise' }], Default: 'Draft_New' },
    Draft_New: {
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
      Arguments: {
        TableName: refs.actionsTable,
        ConditionExpression: 'attribute_not_exists(sk)',
        Item: {
          tenantId: { S: q('$tenant.tenantId.S') },
          sk: { S: q(`$approver & '#${ACTION_TYPE}#' & $now() & '#' & $substring($uuid(), 0, 8)`) },
          type: { S: ACTION_TYPE }, status: { S: 'pending' },
          approver: { S: q('$approver') }, proposedBy: { S: 'assistant' },
          revision: { N: '1' }, shownRevision: { N: '0' },
          approveBy: { N: q(`$string(${epoch} + ${APPROVAL_HOURS} * 3600)`) },
          payload,
          createdAt: { S: q('$now()') }, updatedAt: { S: q('$now()') },
          expiresAt: { N: q(`$string(${epoch} + ${LOG_DAYS} * 86400)`) },
        },
      },
      Catch: failed, Output: out(drafted), End: true,
    },
    // A change is a new revision the person has not seen: the approval window restarts with it.
    Draft_Revise: {
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
      Arguments: {
        TableName: refs.actionsTable, Key: rowKey('$row'),
        UpdateExpression: 'SET payload = :payload, revision = revision + :one, approveBy = :by, updatedAt = :now',
        ConditionExpression: '#s = :pending AND revision = :rev',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':payload': payload,
          ':one': { N: '1' }, ':rev': { N: q('$row.revision.N') }, ':pending': { S: 'pending' },
          ':by': { N: q(`$string(${epoch} + ${APPROVAL_HOURS} * 3600)`) }, ':now': { S: q('$now()') },
        },
      },
      Catch: failed, Output: out(drafted), End: true,
    },

    Run_cancel_facebook_draft: { ...findPending(refs), Assign: { row: q(pendingExpr('$states.result')) }, Catch: failed, Output: q('$states.input'), Next: 'Cancel_Any' },
    Cancel_Any: { Type: 'Choice', Choices: [{ Condition: q('$exists($row.sk)'), Next: 'Cancel_Mark' }], Default: 'Cancel_None' },
    Cancel_None: { Type: 'Pass', Output: out("{ 'ok': true, 'note': 'There was no pending draft.' }"), End: true },
    Cancel_Mark: {
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
      Arguments: {
        TableName: refs.actionsTable, Key: rowKey('$row'),
        UpdateExpression: 'SET #s = :rejected, updatedAt = :now',
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':rejected': { S: 'rejected' }, ':pending': { S: 'pending' }, ':now': { S: q('$now()') } },
      },
      Catch: failed, Output: out("{ 'ok': true, 'note': 'The draft was discarded.' }"), End: true,
    },
  };
}

// ---- After the model: show the person what the row says -------------------------

/**
 * Enters at `FindUnshown`, in place of the channel's reply. A pending revision
 * the person has not been sent goes out as one text, the model's reply above
 * the draft from the row, and is recorded as shown; only then can POST approve
 * it. Otherwise the turn's reply goes out as usual (`reply`). Reads the row,
 * not the turn: a send that failed last time goes out now.
 */
export function facebookShowDraftStates(refs: FacebookPostRefs, send: Send, reply: string, next: string) {
  return {
    FindUnshown: { ...findPending(refs), Assign: { shown: q(pendingExpr('$states.result')) }, Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: reply }], Output: q('$states.input'), Next: 'NeedsShowing' },
    NeedsShowing: { Type: 'Choice', Choices: [{ Condition: q('$exists($shown.sk) and $number($shown.shownRevision.N) < $number($shown.revision.N)'), Next: 'SendDraft' }], Default: reply },
    SendDraft: send(`$reply & '\n\n' & ${draftMessageExpr('$shown')}`, 'MarkShown'),
    MarkShown: {
      Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
      Arguments: {
        TableName: refs.actionsTable, Key: rowKey('$shown'),
        UpdateExpression: 'SET shownRevision = :rev, shownAt = :now',
        ConditionExpression: '#s = :pending AND revision = :rev',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':rev': { N: q('$shown.revision.N') }, ':pending': { S: 'pending' }, ':now': { S: q('$now()') } },
      },
      Catch: [{ ErrorEquals: ['DynamoDB.ConditionalCheckFailedException'], Output: q('$states.input'), Next: next }],
      Output: q('$states.input'), Next: next,
    },
  };
}
