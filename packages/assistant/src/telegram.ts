/**
 * The only Telegram-shaped code in the agent: deliver a reply to a chat.
 * The bot token lives in the URL path (Telegram's design), which is why this
 * cannot be a Gateway target or an EventBridge API destination and has to be
 * a fetch here. Inbound Telegram is handled entirely by the Step Functions
 * workflow in the runtime stack.
 */
const TELEGRAM_MAX_CHARS = 4096;

/** Telegram rejects messages over 4096 chars; split on paragraph, then line, then hard. */
export function splitTelegramText(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find((i) => i > max / 2) ?? max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export async function sendTelegramMessage(botToken: string, chatId: string | number, text: string): Promise<number> {
  const chunks = splitTelegramText(text);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return chunks.length;
}
