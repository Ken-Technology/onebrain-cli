#!/usr/bin/env node
// Builds the One Brain eve registry: a shadcn registry any static host can serve.
//
//   node scripts/registry.mjs [out]   (default: dist/r)
//
// Writes <out>/registry.json, the catalog for `eve registry list` and `eve registry search`, and
// <out>/<name>.json per item for `eve add`, with each file's source embedded as `content`. Each
// item depends on this package at the version in package.json, so a registry built from a release
// installs that release. An eve project adds the source and an item with:
//
//   eve registry add @onebrain=https://<host>/r/{name}.json
//   eve add @onebrain/memory
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = join(root, 'registry');
const out = resolve(process.argv[2] ?? join(root, 'dist/r'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(sources, 'registry.json'), 'utf8'));

const pin = (dep) => (dep === pkg.name ? `${pkg.name}@${pkg.version}` : dep);
const items = registry.items.map((item) => ({
  ...item,
  dependencies: (item.dependencies ?? []).map(pin),
}));

const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

write(join(out, 'registry.json'), { ...registry, items });
for (const item of items) {
  write(join(out, `${item.name}.json`), {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    ...item,
    files: item.files.map((file) => ({
      ...file,
      content: readFileSync(join(sources, file.path), 'utf8'),
    })),
  });
}
console.log(`Wrote ${items.length} items and registry.json to ${out}`);
