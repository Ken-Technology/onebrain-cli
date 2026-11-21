#!/usr/bin/env node
// Packs every public package of the workspace the way `pnpm publish` packs it (prepack builds
// dist/), and checks each tarball before it can reach npm:
//   - package.json's exports and types point at dist/ files that are in the tarball,
//   - no dependency range is still a workspace: or catalog: range,
//   - it holds nothing but dist/, package.json, README.md and LICENSE.
// With --version, every public package must be at that version too: the release workflow passes the
// tag without its v, so a tag that does not match the packages fails before anything is published.
//
//   node scripts/check-packs.mjs [--version <x.y.z>] [<folder to keep the tarballs in>]
//
// It packs and reads; it publishes nothing. Without a folder the tarballs go to a temporary one.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const ALWAYS = ['package.json', 'README.md', 'LICENSE'];
const DEPENDENCIES = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal})\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Each [field, path] an exports value points at, through its conditions and subpaths. */
function targets(value, field) {
  if (typeof value === 'string') return [[field, value]];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => targets(inner, `${field}["${key}"]`));
  }
  return [];
}

/** What is wrong with one packed package. Empty when nothing is. */
function problemsOf(manifest, files, version) {
  const found = [];
  for (const file of files) {
    if (!ALWAYS.includes(file) && !file.startsWith('dist/')) {
      found.push(`holds ${file}, outside dist/, package.json, README.md and LICENSE`);
    }
  }
  for (const file of ALWAYS) if (!files.includes(file)) found.push(`has no ${file}`);
  if (manifest.private) found.push('is private');
  if (version && manifest.version !== version) {
    found.push(`is at version ${manifest.version}, not ${version}`);
  }
  if (manifest.exports === undefined) found.push('has no exports');
  if (manifest.types === undefined) found.push('has no types');
  const pointers = targets(manifest.exports, 'exports');
  for (const field of ['types', 'typings', 'main', 'module']) {
    if (typeof manifest[field] === 'string') pointers.push([field, manifest[field]]);
  }
  for (const [field, target] of pointers) {
    const file = target.replace(/^\.\//, '');
    // A "./package.json" self-export is the one target outside dist/ that is fine.
    if (!file.startsWith('dist/') && file !== 'package.json') {
      found.push(`${field} points at ${target}, outside dist/`);
    } else if (!files.includes(file)) {
      found.push(`${field} points at ${target}, which is not in it`);
    }
  }
  for (const field of DEPENDENCIES) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|catalog):/.test(range)) found.push(`${field}.${name} is still ${range}`);
    }
  }
  return found;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { version: { type: 'string' } },
    allowPositionals: true,
  });
  const keep = positionals[0] ? resolve(positionals[0]) : undefined;
  const out = keep ?? mkdtempSync(join(tmpdir(), 'onebrain-packs-'));
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0) {
    process.stderr.write(`check-packs: ${out} is not empty\n`);
    return 1;
  }
  const packages = JSON.parse(run('pnpm', ['ls', '-r', '--depth', '-1', '--json'])).filter(
    (pkg) => pkg.name && pkg.version && !pkg.private,
  );
  if (packages.length === 0) {
    process.stderr.write('check-packs: the workspace has no public package\n');
    return 1;
  }
  let failed = 0;
  try {
    for (const pkg of packages) {
      const before = new Set(readdirSync(out));
      run('pnpm', ['--filter', pkg.name, 'pack', '--pack-destination', out]);
      const [name] = readdirSync(out).filter((file) => !before.has(file) && file.endsWith('.tgz'));
      if (!name) throw new Error(`pnpm pack wrote no tarball for ${pkg.name}`);
      const tarball = join(out, name);
      // npm tarballs keep every file under package/.
      const files = run('tar', ['-tzf', tarball])
        .split('\n')
        .filter((entry) => entry && !entry.endsWith('/'))
        .map((entry) => entry.replace(/^package\//, ''));
      const manifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
      const problems = problemsOf(manifest, files, values.version);
      if (manifest.name !== pkg.name) problems.push(`packed as ${manifest.name}`);
      process.stdout.write(
        [
          `${manifest.name}@${manifest.version}  ${name}  ${files.length} files`,
          `  exports: ${JSON.stringify(manifest.exports)}`,
          `  types: ${manifest.types}`,
          ...DEPENDENCIES.filter((field) => manifest[field]).map(
            (field) => `  ${field}: ${JSON.stringify(manifest[field])}`,
          ),
          ...(problems.length > 0 ? problems.map((problem) => `  PROBLEM: ${problem}`) : ['  ok']),
          '',
        ].join('\n'),
      );
      if (problems.length > 0) failed += 1;
    }
  } finally {
    if (!keep) rmSync(out, { recursive: true, force: true });
  }
  if (failed > 0) {
    process.stderr.write(`check-packs: ${failed} of ${packages.length} packages are not ready\n`);
    return 1;
  }
  process.stdout.write(
    `check-packs: ${packages.length} packages ready${values.version ? ` at ${values.version}` : ''}${keep ? `, tarballs in ${out}` : ''}\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
