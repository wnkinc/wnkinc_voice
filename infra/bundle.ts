/**
 * Bundles one entry point (src/<name>.ts) into infra/.build/<name>/index.mjs.
 * Runs synchronously inside the Pulumi program so `pulumi up` is the only command you need.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

export function bundleHandler(name: string): string {
  return bundle(name, path.resolve(here, '../src', `${name}.ts`));
}

export function bundleWorker(): string {
  return path.join(bundle('worker', path.resolve(here, '../src/worker.ts')), 'index.mjs');
}

function bundle(name: string, entry: string): string {
  const outdir = path.resolve(here, '.build', name);
  buildSync({
    entryPoints: [entry],
    outfile: path.join(outdir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    mainFields: ['module', 'main'],
    sourcemap: true,
    minify: false,
    logLevel: 'warning',
    // Some CJS deps (ws, aws-sdk internals) call require(); give them one in ESM.
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });
  return outdir;
}
