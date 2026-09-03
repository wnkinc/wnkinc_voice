/**
 * Trace stitching across the seams AWS doesn't stitch for us.
 *
 * X-Ray follows a request Lambda -> Lambda on its own, but the trace header
 * has to be carried by hand through an SQS message and an EventBridge event.
 * These helpers read the current Lambda trace and the id log lines should
 * carry so every hop can be joined on it.
 */

/** The X-Ray header the Lambda runtime sets for the current invocation, if any. */
export function currentXrayHeader(): string | undefined {
  const h = process.env._X_AMZN_TRACE_ID;
  return h && h.includes('Root=') ? h : undefined;
}

/** The 32-hex trace id from either header form; what log lines should carry. */
export function traceIdOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const w3c = /^00-([0-9a-f]{32})-/.exec(header);
  if (w3c) return w3c[1];
  const root = /Root=1-([0-9a-f]{8})-([0-9a-f]{24})/.exec(header);
  return root ? `${root[1]}${root[2]}` : undefined;
}
