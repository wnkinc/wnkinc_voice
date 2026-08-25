/** "555-555-0155" -> "+15555550155"; undefined when it does not look like a phone number. */
/** Best-effort E.164 normalisation for numbers the caller says out loud. */
export function normalizePhone(input?: string): string | undefined {
  if (!input) return undefined;
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return undefined;
}
