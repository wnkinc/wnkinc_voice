/** Pre-bundles the workflow code once, at image build, so a cold start never runs webpack. */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';

const { code } = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)) });
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await writeFile(new URL('../lib/workflow-bundle.js', import.meta.url), code);
console.log(`workflow bundle: ${(code.length / 1024).toFixed(0)} KB`);
