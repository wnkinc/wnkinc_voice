/**
 * Anti-flash tuning WITHOUT touching AWS code. The DCV web SDK encodes changed
 * screen regions at low quality first, then sharpens ("build to lossless"),
 * which reads as flashing under the cursor. The stock BrowserLiveView exposes
 * no way to reach the DCV connection, but the component, dcv-ui, and this file
 * all import the same aliased 'dcv' module instance — so we wrap connect() and
 * pin the quality floor on whatever connection it returns.
 *
 * Delete this file and its import in App.jsx to get fully stock behavior.
 */
import dcv from 'dcv';

const QUALITY_MIN = 70;
const QUALITY_MAX = 95;

const originalConnect = dcv.connect?.bind(dcv);
if (originalConnect && !dcv.__qualityShimApplied) {
  dcv.__qualityShimApplied = true;
  dcv.connect = (...args) => {
    const result = originalConnect(...args);
    Promise.resolve(result)
      .then((conn) => { try { conn?.setDisplayQuality?.(QUALITY_MIN, QUALITY_MAX); } catch { /* best effort */ } })
      .catch(() => { /* connect() errors surface to the caller, not here */ });
    return result;
  };
}
