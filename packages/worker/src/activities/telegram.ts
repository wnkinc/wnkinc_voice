/** A reply to a Telegram chat through the Bot API. The token is in the platform's Telegram secret; the chat id is the one the update carried. */
import { env, secret } from './config.js';

export async function sendTelegram(chatId: number | string, text: string): Promise<void> {
  const s = await secret(env('TELEGRAM_SECRET_ARN'));
  if (!s.TELEGRAM_BOT_TOKEN || s.TELEGRAM_BOT_TOKEN === 'set-me') throw new Error('the Telegram secret is not filled in');
  const res = await fetch(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await res.json() as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) throw new Error(`Telegram refused the message: ${res.status} ${body.description ?? ''}`);
}
