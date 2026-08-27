/**
 * The rate card: what a unit of each meter costs US (not what we charge).
 * These are calibrated estimates — reconcile monthly: sum the Costs tab
 * across tenants, compare against the actual Twilio / OpenAI / AWS invoices,
 * and adjust the rates here until they track within ~10%.
 */
export type Meter = 'voice_minutes' | 'llm_tokens' | 'emails_sent' | 'browser_tasks';

export const RATES: {
  meters: Record<Meter, { rate: number; note: string }>;
  monthlyOverhead: number;
} = {
  meters: {
    voice_minutes: {
      rate: 0.11,
      // Twilio inbound trunk ~$0.0085/min + OpenAI Realtime (gpt-realtime audio
      // in+out, blended) ~$0.10/min. Dominated by OpenAI; recalibrate from the
      // OpenAI usage dashboard after a real month.
      note: 'Twilio inbound + OpenAI Realtime audio, blended per call-minute',
    },
    llm_tokens: {
      rate: 0.000002,
      // gpt-5-mini class drafting: blended in/out per token. Tiny next to voice.
      note: 'Drafting/summarizing tokens (email + back-office agents)',
    },
    emails_sent: {
      rate: 0,
      note: 'Informational count; Gmail send costs nothing',
    },
    browser_tasks: {
      rate: 0.02,
      // AgentCore Browser session ~2-3 min active + Runtime microVM seconds.
      note: 'One back-office browser task (browser session + runtime)',
    },
  },
  // Shared AWS services (Lambda, DynamoDB, SQS, Gateway, Memory, logs) are
  // pennies at current scale — one flat line per active tenant-month instead
  // of itemizing. Recalibrate from the AWS bill.
  monthlyOverhead: 2.0,
};
