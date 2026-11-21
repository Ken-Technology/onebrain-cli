#!/usr/bin/env node
// Builds the package for npm: ESM JavaScript and .d.ts in dist/, from src/ (tsconfig.build.json).
// Inside the monorepo nothing needs it: Node runs src/ directly. pnpm pack and pnpm publish run it
// (prepack), and publishConfig points the packed package.json at dist/.
//
// The declarations import @useonebrain/sdk, whose monorepo package.json points at its TypeScript
// sources. tsconfig.build.json maps it to the SDK's built declarations instead, so the SDK is built
// first; the JavaScript keeps the bare specifier, which npm resolves to the published SDK.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sdk = join(root, '../../sdk');
const node = (args, cwd) => {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

node([join(sdk, 'scripts/build.mjs')], sdk);

const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
node([fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json'], root);

// rewriteRelativeImportExtensions rewrites ./x.ts to ./x.js in the JavaScript only. The
// declarations get the same specifiers, which every TypeScript version resolves to ./x.d.ts.
for (const name of readdirSync(dist)) {
  if (!name.endsWith('.d.ts')) continue;
  const path = join(dist, name);
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/(from\s+['"]\.{1,2}\/[^'"]*?)\.ts(['"])/g, '$1.js$2'));
}
