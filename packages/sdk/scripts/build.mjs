#!/usr/bin/env node
// Builds the package for npm: ESM JavaScript and .d.ts in dist/, from src/ (tsconfig.build.json).
// Inside the monorepo nothing needs it: Node runs src/ directly. pnpm pack and pnpm publish run it
// (prepack), and publishConfig points the packed package.json at dist/.
//
// Each framework package's build runs this one first, so several can run at once: the package
// tests pack in parallel. Each builds in a folder of its own and swaps it in whole, so a pack or a
// build that reads dist/ never sees it half written. The folder is under node_modules, which git
// and npm leave out, and on the same disk as dist/, so the swap is a rename.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const work = join(root, 'node_modules/.build', String(process.pid));
const next = join(work, 'dist');
const old = join(work, 'old');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', next], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) {
  rmSync(work, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

// rewriteRelativeImportExtensions rewrites ./x.ts to ./x.js in the JavaScript only. The
// declarations get the same specifiers, which every TypeScript version resolves to ./x.d.ts.
for (const name of readdirSync(next)) {
  if (!name.endsWith('.d.ts')) continue;
  const path = join(next, name);
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/(from\s+['"]\.{1,2}\/[^'"]*?)\.ts(['"])/g, '$1.js$2'));
}

// Move the current dist/ aside and this build in. Another build may put its dist/ back in between:
// then move that one aside too and try again.
for (;;) {
  rmSync(old, { recursive: true, force: true });
  try {
    renameSync(dist, old);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    renameSync(next, dist);
    break;
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
  }
}
rmSync(work, { recursive: true, force: true });
