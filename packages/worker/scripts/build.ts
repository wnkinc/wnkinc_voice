/**
 * The three Node entries (the Lambda handler, the fallback service, the
 * starters) bundled with esbuild, once, at image build. Our own code and the
 * shared package go into the bundle; every other package stays external and
 * is resolved from node_modules at runtime, which the Temporal SDK's native
 * core needs anyway. The workflow bundle is separate (bundle-workflows.ts).
 */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const result = await build({
  entryPoints: [here('../src/handler.ts'), here('../src/service.ts'), here('../src/starter.ts')],
  outdir: here('../lib'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [{
    name: 'external-packages',
    setup(b) {
      // A bare specifier is a package: external, unless it is ours.
      b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@wnk/') ? undefined : { path: args.path, external: true }));
    },
  }],
});
if (result.errors.length) process.exit(1);
