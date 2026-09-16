/* Builds the self-contained dist/ that both the npm package and the Claude Code plugin ship:
   dist/cli.js and dist/hook.js (zod bundled in, no runtime node_modules), plus pricing.json and the demo fixture. */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: dist,
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __tallyCreateRequire } from "node:module";\nconst require = __tallyCreateRequire(import.meta.url);' },
};

await build({ ...shared, entryPoints: { cli: path.join(root, 'src', 'cli.ts') } });
await build({ ...shared, entryPoints: { hook: path.join(root, 'src', 'hooks', 'hook.ts') } });

fs.copyFileSync(path.join(root, 'pricing.json'), path.join(dist, 'pricing.json'));
fs.cpSync(path.join(root, 'test', 'fixtures', 'session-basic'), path.join(dist, 'fixtures', 'session-basic'), { recursive: true });

/* no chmod: npm sets the bin mode on install, the plugin runs `node dist/hook.js`, and a mode flip would make the
   committed bundle differ between Windows (no mode bits) and Linux */
for (const f of ['cli.js', 'hook.js']) {
  const p = path.join(dist, f);
  const kb = Math.round(fs.statSync(p).size / 1024);
  process.stdout.write(`dist/${f}  ${kb} KB\n`);
}
