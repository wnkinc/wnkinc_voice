import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The BrowserLiveView component imports bare 'dcv' / 'dcv-ui' specifiers that
// must resolve to the DCV web client SDK vendored inside bedrock-agentcore.
const dcvSdkDir = resolve(__dirname, 'node_modules/bedrock-agentcore/dist/src/tools/browser/live-view/nice-dcv-web-client-sdk');

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: resolve(dcvSdkDir, 'dcvjs-esm'), dest: 'nice-dcv-web-client-sdk' },
        { src: resolve(dcvSdkDir, 'dcv-ui'), dest: 'nice-dcv-web-client-sdk' },
      ],
    }),
  ],
  resolve: {
    alias: {
      dcv: resolve(dcvSdkDir, 'dcvjs-esm/dcv.js'),
      'dcv-ui': resolve(dcvSdkDir, 'dcv-ui/dcv-ui.js'),
    },
    dedupe: [
      'react', 'react-dom', 'prop-types',
      '@cloudscape-design/components', '@cloudscape-design/global-styles',
      '@cloudscape-design/design-tokens', '@babel/runtime',
    ],
  },
  server: {
    port: 5199,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
