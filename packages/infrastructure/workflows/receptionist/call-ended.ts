/**
 * Call ended: transcript -> caller memory, minutes -> usage.
 *
 * Express, execution data not logged (the transcript). The session Lambda
 * publishes ids and the outcome only; this reads the transcript from the
 * call row by id, writes it to the caller's memory (facts and preferences
 * are extracted asynchronously), and meters the minutes. Once-marker, since
 * a redelivered event would otherwise double both.
 */
import { checkDone, markDone, q } from '../asl.js';

export interface CallEndedRefs {
  callsTable: string;
  usageTable: string;
  /** Caller memory to write the transcript to; omit and the memory states are not emitted. */
  memoryId?: string;
}

export function callEndedDefinition(refs: CallEndedRefs) {
  const onceKey = 'done:call.ended';

  return {
    QueryLanguage: 'JSONata',
    StartAt: 'Completed',
    States: {
      Completed: { Type: 'Choice', Choices: [{ Condition: q("$states.input.detail.status = 'completed' and $states.input.detail.durationSeconds > 0"), Next: 'CheckDone' }], Default: 'Skipped' },
      Skipped: { Type: 'Succeed' },
      CheckDone: {
        ...checkDone(refs.callsTable, onceKey, 'transcript'),
        Assign: { done: q('$exists($states.result.Item.`done:call.ended`)'), transcript: q('[$states.result.Item.transcript.L]') },
        Output: q('$states.input'), Next: 'AlreadyDone',
      },
      AlreadyDone: { Type: 'Choice', Choices: [{ Condition: q('$done'), Next: 'Skipped' }], Default: 'Usage' },
      Usage: {
        Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem',
        Arguments: { TableName: refs.usageTable, Item: {
          tenantId: { S: q('$states.input.detail.tenantId') },
          sk: { S: q("$now() & '#voice_minutes#' & $uuid()") },
          meter: { S: 'voice_minutes' },
          units: { N: q('$string($states.input.detail.durationSeconds / 60)') },
          ref: { S: q('$states.input.detail.callId') },
        } },
        Output: q('$states.input'), Next: refs.memoryId ? 'HasTranscript' : 'MarkDone',
      },
      ...(refs.memoryId ? {
        HasTranscript: { Type: 'Choice', Choices: [{ Condition: q("$exists($states.input.detail.callerPhone) and $count($transcript[M.role.S != 'tool']) > 0"), Next: 'RememberCall' }], Default: 'MarkDone' },
        RememberCall: {
          Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:bedrockagentcore:createEvent',
          Arguments: {
            MemoryId: refs.memoryId,
            ActorId: q("$states.input.detail.tenantId & '_' & $replace($states.input.detail.callerPhone, /[^0-9]/, '')"),
            SessionId: q('$states.input.detail.callId'),
            EventTimestamp: q('$now()'),
            Payload: q("[$transcript[M.role.S != 'tool'].{'Conversational': {'Role': (M.role.S = 'user' ? 'USER' : 'ASSISTANT'), 'Content': {'Text': M.text.S}}}]"),
          },
          Output: q('$states.input'), Next: 'MarkDone',
        },
      } : {}),
      MarkDone: { ...markDone(refs.callsTable, onceKey), End: true },
    },
  };
}
