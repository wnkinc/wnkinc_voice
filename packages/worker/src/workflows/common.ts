/** What every workflow file may share: nothing here touches an activity. */

/** The promise's value, or the fallback when it rejects: for enrichment whose failure costs only the detail it would have added. */
export async function orElse<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}
