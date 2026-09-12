/**
 * Browser login handoff: /login on Telegram -> this workflow -> a Browserbase
 * session on the tenant's saved browser -> the live view link to the owner ->
 * released after the window, with whatever they signed into kept.
 *
 * Standard, no model. The tenant's saved browser is a Browserbase context
 * (cookies, logins; encrypted at rest in their vault) whose id lives on the
 * tenant row as `browserContextId`. Created here on first use and written to
 * the row; the reply asks the owner to add it to the tenant file so a re-seed
 * keeps it. Captcha solving is Browserbase's, on by default. Nothing here
 * touches the page: the owner drives the live view. Step two hands the same
 * context to the assistant (a per-tenant Stagehand session).
 *
 * Input (from the Telegram workflow): { tenantId, tenantPhoneNumber, chatId, text }.
 */
import { BROWSERBASE_API, httpTask, q } from './asl.js';

export interface BrowserLoginRefs {
  tenantsTable: string;
  busName: string;
  browserbaseConnectionArn: string;
  /** The platform's Browserbase project; every tenant's contexts and sessions are created in it. */
  browserbaseProjectId: string;
  /** How long the live view stays open for the owner. */
  windowSeconds?: number;
}

// ---- Expressions (exported unwrapped so the tests can evaluate them) ---------

/** What the owner said they are logging into: the command text after '/login' ('' when nothing). */
export const loginSiteExpr = (textExpr: string) => `$trim($substring(${textExpr}, 6))`;

// ---- Definition ----------------------------------------------------------------

export function browserLoginDefinition(refs: BrowserLoginRefs) {
  const windowSeconds = refs.windowSeconds ?? 600;
  const minutes = Math.round(windowSeconds / 60);
  const http = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) =>
    httpTask(refs.browserbaseConnectionArn, method, BROWSERBASE_API + path, body);
  const sessionPath = q(`'${BROWSERBASE_API}sessions/' & $sessionId`);
  const tell = (textExpr: string) => ({
    Type: 'Task', Resource: 'arn:aws:states:::events:putEvents',
    Arguments: { Entries: [{
      EventBusName: refs.busName, Source: 'wnkinc.assistant', DetailType: 'telegram.reply',
      Detail: q(`$string({'tenantId': $tenant.tenantId.S, 'chatId': $chatId, 'text': ${textExpr}})`),
    }] },
    Output: q('$states.input'),
  });

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'LookupTenant',
    States: {
      LookupTenant: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:getItem',
        Arguments: { TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$states.input.tenantPhoneNumber') } } },
        Assign: { tenant: q('$states.result.Item'), chatId: q('$states.input.chatId'), site: q(loginSiteExpr('$states.input.text')) },
        Output: q('$states.input'), Next: 'BrowserEnabled',
      },
      BrowserEnabled: {
        Type: 'Choice',
        Choices: [{ Condition: q('$exists($tenant) and $tenant.products.M.browser.M.enabled.BOOL = true'), Next: 'HasContext' }],
        Default: 'NotEnabled',
      },
      NotEnabled: { Type: 'Fail', Error: 'BrowserNotEnabled', Cause: 'products.browser.enabled is not true on the tenant row' },
      // ---- The tenant's saved browser: reuse it, or create it once ------------
      HasContext: { Type: 'Choice', Choices: [{ Condition: q('$exists($tenant.browserContextId.S)'), Next: 'UseContext' }], Default: 'CreateContext' },
      UseContext: { Type: 'Pass', Assign: { contextId: q('$tenant.browserContextId.S'), created: false }, Output: q('$states.input'), Next: 'StartSession' },
      CreateContext: {
        ...http('POST', 'contexts', { projectId: refs.browserbaseProjectId, name: q('$tenant.tenantId.S') }),
        Assign: { contextId: q('$states.result.ResponseBody.id'), created: true },
        Output: q('$states.input'), Next: 'SaveContext',
      },
      SaveContext: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:updateItem',
        Arguments: {
          TableName: refs.tenantsTable, Key: { phoneNumber: { S: q('$tenant.phoneNumber.S') } },
          UpdateExpression: 'SET browserContextId = :c',
          ExpressionAttributeValues: { ':c': { S: q('$contextId') } },
        },
        Output: q('$states.input'), Next: 'StartSession',
      },
      // ---- A live browser on that context, held open for the owner -----------
      StartSession: {
        ...http('POST', 'sessions', {
          projectId: refs.browserbaseProjectId,
          browserSettings: { context: { id: q('$contextId'), persist: true }, solveCaptchas: true },
          // Nothing connects over CDP; keepAlive holds the session for the live view. The timeout is the backstop past our own release.
          keepAlive: true,
          timeout: windowSeconds + 300,
        }),
        Assign: { sessionId: q('$states.result.ResponseBody.id') },
        Output: q('$states.input'), Next: 'LiveView',
      },
      LiveView: {
        ...httpTask(refs.browserbaseConnectionArn, 'GET', q(`'${BROWSERBASE_API}sessions/' & $sessionId & '/debug'`)),
        Assign: { url: q('$states.result.ResponseBody.debuggerUrl') },
        Output: q('$states.input'), Next: 'TellOwner',
      },
      TellOwner: {
        ...tell([
          `'Browser ready' & ($site != '' ? ' for ' & $site : '') & '. Open the link, go to the site, and sign in. It closes in ${minutes} minutes; the login is kept for next time. ' & $url`,
          "& ($created ? '\\n\\nFirst browser for this business. Add browserContextId = ' & $contextId & ' to the tenant file so a re-seed keeps it.' : '')",
        ].join(' ')),
        Next: 'Window',
      },
      Window: { Type: 'Wait', Seconds: windowSeconds, Next: 'Release' },
      // Release syncs the context. A failed release still tells the owner; Browserbase's timeout ends the session either way.
      Release: {
        ...httpTask(refs.browserbaseConnectionArn, 'POST', sessionPath, { projectId: refs.browserbaseProjectId, status: 'REQUEST_RELEASE' }),
        Catch: [{ ErrorEquals: ['States.ALL'], Output: q('$states.input'), Next: 'TellClosed' }],
        Output: q('$states.input'), Next: 'TellClosed',
      },
      TellClosed: { ...tell("'Browser closed. Whatever you signed into is saved for this business.'"), End: true },
    },
  };
}
