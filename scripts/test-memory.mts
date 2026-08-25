// Phase-5 proof: write a call transcript event, poll until extraction yields records.
import { callerMemory } from '@wnk/shared';
const mem = callerMemory('wnkinc_voice_dev_caller_memory-EXAMPLE123');
process.env.AWS_REGION = 'us-west-2';
const [tenant, phone] = ['wnk', '+15555550155'];
if (process.argv[2] !== 'poll') {
  await mem.recordCall(tenant, phone, 'memory-test-' + Date.now(), [
    { role: 'assistant', text: 'Thanks for calling WNK Home Services, this is Alex. How can I help you today?', at: new Date().toISOString() },
    { role: 'user', text: 'Hi, this is Jordan again about the door replacement. Mornings before 9 work best for me, and please text rather than call when possible.', at: new Date().toISOString() },
    { role: 'assistant', text: 'Got it Jordan - door replacement, morning contact before 9, prefer text. The owner will follow up.', at: new Date().toISOString() },
  ]);
  console.log('event written');
}
for (let i = 0; i < 30; i++) {
  const records = await mem.recall(tenant, phone, 'who this caller is, their jobs, and their preferences');
  if (records.length) { console.log('RECORDS:'); records.forEach((r) => console.log('-', r.slice(0, 140))); process.exit(0); }
  await new Promise((r) => setTimeout(r, 10000));
}
console.log('no records after 5 minutes');
process.exit(1);
