import { OpenAIRealtimeSIP, RealtimeSession } from '@openai/agents/realtime';
import { buildAgent, greeting, sessionOptions, type CallContext } from './agent.js';
import { createOpenAI, type Logger, type OpenAISecrets } from '@wnk/shared';
import type { EventPublisher } from '@wnk/shared';
import type { Store } from '@wnk/shared';
import { recordUsage } from '@wnk/shared';
import type { CallerMemory, CallStatus, SessionJob, TranscriptEntry } from '@wnk/shared';

export interface CallDeps {
  secrets: () => Promise<OpenAISecrets>;
  store: Store;
  events: EventPublisher;
  /** Platform caller memory; when present, finished calls are written to it. */
  memory?: CallerMemory;
  log: Logger;
}

export interface CallOutcome {
  status: CallStatus;
  durationSeconds: number;
  transcript: TranscriptEntry[];
  error?: string;
}

const DEADLINE_HEADROOM_MS = 25_000; // wrap up this long before the hard deadline
const WRAP_UP_GRACE_MS = 20_000; // force hangup this long after asking the model to wrap up
const HANGUP_SETTLE_MS = 1_500; // pause after the last audio before hanging up
const AUDIO_DRAIN_TIMEOUT_MS = 8_000; // hang up anyway if we never see the audio stop
const TOOL_HANGUP_FALLBACK_MS = 10_000; // hang up anyway if no response follows end_call

/**
 * Attach to an accepted SIP call and run it to completion. Same shape as OpenAI's
 * realtime-twilio-sip example: RealtimeSession + OpenAIRealtimeSIP transport, with
 * the SDK running the tool loop. On top of that we log transcripts, enforce a time
 * limit, and hang up cleanly.
 */
export async function runCall(job: SessionJob, deps: CallDeps, opts: { deadlineMs: number }): Promise<CallOutcome | undefined> {
  const { callId } = job;
  const log = deps.log.child({ callId });

  const tenant = await deps.store.getTenant(job.tenantPhoneNumber);
  if (!tenant) {
    log.error('tenant disappeared between accept and session', { tenantPhoneNumber: job.tenantPhoneNumber });
    return undefined;
  }
  const existing = await deps.store.getCall(callId);
  if (existing?.status === 'completed' || existing?.status === 'failed') {
    log.info('call already finished; nothing to do', { status: existing.status });
    return { status: existing.status, durationSeconds: 0, transcript: existing.transcript ?? [] };
  }
  const resuming = existing?.status === 'in_progress';

  const secrets = await deps.secrets();
  const openai = createOpenAI(secrets);
  const startedAt = Date.now();
  const transcript: TranscriptEntry[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const background: Promise<unknown>[] = [];
  let closed = false;
  let hungUp = false;
  let hangupArmed = false;
  let hangupAfterNextResponse = false;
  let audioPlaying = false;
  let onAudioStopped: (() => void) | undefined;
  let error: string | undefined;

  const timer = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const track = (p: Promise<unknown>) => { background.push(p.catch((err) => log.error('background task failed', { err }))); };

  const ctx: CallContext = {
    tenant,
    callId,
    party: { from: job.from, to: job.to },
    store: deps.store,
    events: deps.events,
    log,
    requestHangup: () => { hangupAfterNextResponse = true; timer(TOOL_HANGUP_FALLBACK_MS, () => armHangup('end_call_fallback')); },
  };

  const extras = { callerPhone: job.from, ...job.extras };
  const session = new RealtimeSession(buildAgent(tenant, extras), {
    transport: new OpenAIRealtimeSIP(),
    context: ctx,
    ...sessionOptions(tenant),
  });
  const send = (event: Parameters<typeof session.transport.sendEvent>[0]) => { if (!closed) session.transport.sendEvent(event); };

  const addTranscript = (role: TranscriptEntry['role'], text: string | undefined) => {
    if (!text?.trim()) return;
    const entry = { role, text: text.trim(), at: new Date().toISOString() };
    transcript.push(entry);
    log.info('transcript', { role, text: entry.text });
    track(deps.store.appendTranscript(callId, entry));
  };

  const doHangup = async (reason: string) => {
    if (hungUp || closed) return;
    hungUp = true;
    log.info('hanging up', { reason });
    await openai.realtime.calls.hangup(callId).catch((err) => log.error('hangup failed', { err }));
    timer(3_000, () => session.close()); // server normally closes the socket first
  };
  const armHangup = (reason: string) => {
    if (hangupArmed) return;
    hangupArmed = true;
    const fire = () => void doHangup(reason);
    if (audioPlaying) {
      onAudioStopped = () => { onAudioStopped = undefined; timer(HANGUP_SETTLE_MS, fire); };
      timer(AUDIO_DRAIN_TIMEOUT_MS, fire);
    } else {
      timer(HANGUP_SETTLE_MS, fire);
    }
  };

  // Raw server events (the SDK re-emits every one as transport_event).
  session.on('transport_event', (ev) => {
    switch (ev.type) {
      case 'conversation.item.input_audio_transcription.completed': addTranscript('user', ev.transcript); break;
      case 'response.output_audio_transcript.done': addTranscript('assistant', ev.transcript); break;
      case 'output_audio_buffer.started': audioPlaying = true; break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared': audioPlaying = false; onAudioStopped?.(); break;
      case 'response.done':
        if (hangupAfterNextResponse) { hangupAfterNextResponse = false; armHangup('response_after_wrap_up'); }
        break;
      case 'error': log.error('realtime error', { error: ev.error }); error ??= ev.error?.message; break;
      default: break;
    }
  });
  session.on('agent_tool_start', (_c, _a, t) => log.info('tool start', { tool: t.name }));
  session.on('agent_tool_end', (_c, _a, t, result, { toolCall }) => {
    const rawArgs = toolCall.type === 'function_call' ? toolCall.arguments : '';
    let args: unknown = rawArgs;
    try { args = JSON.parse(rawArgs); } catch { /* keep raw */ }
    transcript.push({ role: 'tool', text: `${t.name}(${rawArgs}) -> ${result}`, at: new Date().toISOString() });
    track(deps.store.appendToolCall(callId, { name: t.name, args, result, at: new Date().toISOString() }));
    log.info('tool end', { tool: t.name });
  });
  session.on('error', (e) => { log.error('session error', { error: e.error }); error ??= String((e.error as Error)?.message ?? e.error); });

  const disconnected = new Promise<void>((resolve) => {
    session.transport.on('connection_change', (status) => {
      if (status === 'disconnected') { closed = true; resolve(); }
    });
  });

  try {
    await session.connect({ apiKey: secrets.OPENAI_API_KEY, callId });
  } catch (err) {
    log.error('could not attach to call', { err });
    await deps.store.setCallStatus(callId, 'failed', { error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    throw err;
  }
  log.info(resuming ? 're-attached to call in progress' : 'attached to call');
  await deps.store.setCallStatus(callId, 'in_progress');

  // Time limit: ask the model to wrap up, hang up after its reply (or the grace period).
  const wrapUpAt = Math.min(startedAt + tenant.maxCallSeconds * 1000, opts.deadlineMs - DEADLINE_HEADROOM_MS);

  // Remaining-time notices ahead of the limit (e.g. a 5-minute cap warns at 3:00 and 4:00).
  for (const remainingMs of [120_000, 60_000]) {
    const warnAt = wrapUpAt - remainingMs;
    if (warnAt < startedAt + 60_000) continue; // no notices in the first minute of very short limits
    const spoken = remainingMs === 60_000 ? 'one minute' : 'two minutes';
    timer(Math.max(0, warnAt - Date.now()), () => {
      if (hangupArmed) return;
      log.info('time notice', { remainingMs });
      send({ type: 'response.create', response: { instructions: `Time notice: about ${spoken} of call time left. In one short, natural sentence let the caller know, then finish collecting anything still missing so the call can end on time. Do not hang up yet.` } });
    });
  }

  timer(Math.max(0, wrapUpAt - Date.now()), () => {
    log.warn('call reached time limit; asking model to wrap up');
    hangupAfterNextResponse = true;
    send({ type: 'response.create', response: { instructions: 'You have run out of time for this call. In one short sentence apologise, tell the caller the business will follow up, and say goodbye. Do not call any tools.' } });
    timer(WRAP_UP_GRACE_MS, () => void doHangup('wrap_up_timeout'));
  });

  if (!resuming) {
    send({ type: 'response.create', response: { instructions: `The call just connected. Say exactly: "${greeting(tenant, extras)}" and then wait for the caller.` } });
  }

  await disconnected;
  for (const t of timers) clearTimeout(t);
  await Promise.allSettled(background);

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const status: CallStatus = error && transcript.length === 0 ? 'failed' : 'completed';
  try {
    await deps.store.setCallStatus(callId, status, { endedAt: new Date().toISOString(), error });
    await deps.events.publish({ type: 'call.ended', tenantId: tenant.tenantId, tenantPhoneNumber: tenant.phoneNumber, callId, callerPhone: job.from, status, durationSeconds });
  } catch (err) {
    log.error('failed to finalize call', { err });
  }
  if (status === 'completed' && durationSeconds > 0) {
    await recordUsage(tenant.tenantId, 'voice_minutes', durationSeconds / 60, callId);
  }
  if (deps.memory && job.from && status === 'completed' && transcript.length > 0) {
    await deps.memory.recordCall(tenant.tenantId, job.from, callId, transcript)
      .then(() => log.info('call written to caller memory'))
      .catch((err) => log.warn('caller memory write failed', { err }));
  }
  log.info('call finished', { status, durationSeconds, turns: transcript.length });
  return { status, durationSeconds, transcript, error };
}
