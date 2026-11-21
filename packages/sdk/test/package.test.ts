import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// What npm gets: the package as `pnpm pack` builds it (prepack runs the build), installed into a
// fresh project with plain npm and imported by plain Node, which runs no TypeScript in node_modules.
// The install is offline: the dependencies are packed from this checkout's node_modules too.

const sdk = fileURLToPath(new URL('..', import.meta.url));
const repo = join(sdk, '../..');
const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')}: ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
};
/** Where a package is, from `from`, as Node finds it: node_modules here, then in each folder above. */
const packageDir = (from: string, name: string): string => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`${name} is not installed above ${from}`);
  }
};
type Manifest = Record<string, unknown> & { dependencies?: Record<string, string> };
const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
/** Every file under dir, relative to it. */
const walk = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));

/** Import and export statements, bare imports, and import() with a literal, as the open-source test reads them. */
const IMPORTS = [
  /^\s*(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

let temp = '';
let tarball = '';
let installed = '';
let app = '';

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'onebrain-sdk-pack-'));
  run('pnpm', ['--filter', '@useonebrain/sdk', 'pack', '--pack-destination', temp], repo);
  const [name] = readdirSync(temp).filter((file) => file.endsWith('.tgz'));
  tarball = join(temp, name ?? 'missing.tgz');

  // The dependencies, and theirs, packed from node_modules, so npm needs no registry. Each from a
  // copy: pnpm's store hard-links equal files, npm packs a hard link as a link entry, and npm's
  // install leaves link entries out.
  const tarballs = [tarball];
  const queue = Object.keys(manifest(sdk).dependencies ?? {}).map((dep) => packageDir(sdk, dep));
  for (const [index, dir] of queue.entries()) {
    const copy = join(temp, 'deps', String(index));
    cpSync(dir, copy, {
      recursive: true,
      filter: (path) => !path.slice(dir.length).includes('node_modules'),
    });
    const file = run(
      'npm',
      ['pack', '--ignore-scripts', '--silent', '--pack-destination', temp, copy],
      temp,
    )
      .trim()
      .split('\n')
      .at(-1);
    tarballs.push(join(temp, file ?? ''));
    for (const dep of Object.keys(manifest(dir).dependencies ?? {}))
      queue.push(packageDir(dir, dep));
  }

  app = join(temp, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--offline',
      '--cache',
      join(temp, 'cache'),
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      ...tarballs,
    ],
    app,
  );
  installed = join(app, 'node_modules/@useonebrain/sdk');
}, 180_000);

afterAll(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

describe('the npm package', () => {
  it('holds the built JavaScript and types, the README and the license, and no sources', () => {
    const files = walk(installed).sort();
    expect(files).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'README.md',
        'package.json',
        'dist/index.js',
        'dist/index.d.ts',
      ]),
    );
    expect(
      files.filter(
        (file) => !/^(dist\/[\w-]+\.(js|d\.ts)|LICENSE|README\.md|package\.json)$/.test(file),
      ),
    ).toEqual([]);
    const ts = files.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
    expect(ts).toEqual([]);
  });

  it('points its exports at dist/, and is public, MIT, versioned and free of side effects', () => {
    const packed = manifest(installed);
    expect(packed).toMatchObject({
      name: '@useonebrain/sdk',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      license: 'MIT',
      type: 'module',
      sideEffects: false,
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      publishConfig: { access: 'public', provenance: true },
      repository: {
        url: expect.stringContaining('Ken-Technology/onebrain-cli'),
        directory: 'packages/sdk',
      },
      engines: { node: expect.any(String) },
    });
    expect(packed.private).toBeUndefined();
    expect(Object.keys(packed.dependencies ?? {})).toEqual(
      Object.keys(manifest(sdk).dependencies ?? {}),
    );
  });

  it('imports nothing from Node: no node: specifier and no built-in module in dist/', () => {
    const imports: string[] = [];
    for (const file of walk(join(installed, 'dist'))) {
      const text = readFileSync(join(installed, 'dist', file), 'utf8');
      expect(text, file).not.toMatch(/['"]node:/);
      for (const pattern of IMPORTS) {
        for (const match of text.matchAll(pattern)) imports.push(match[1] ?? '');
      }
      expect(text, file).not.toMatch(/\bprocess\.env\b|\bBuffer\b|\brequire\(/);
    }
    const external = [...new Set(imports.filter((spec) => !spec.startsWith('.')))];
    expect(external).toEqual(['openapi-fetch']);
    expect(external.filter((spec) => builtinModules.includes(spec))).toEqual([]);
    // Relative imports name the .js files that are there.
    for (const spec of imports.filter((one) => one.startsWith('.'))) {
      expect(spec).toMatch(/\.js$/);
      expect(existsSync(join(installed, 'dist', spec))).toBe(true);
    }
  });

  it('loads in plain Node from node_modules, and a search goes out signed in', () => {
    const script = `
      const m = await import('@useonebrain/sdk');
      const sent = [];
      const fetch = async (request) => {
        sent.push([request.method, request.url, request.headers.get('authorization'), await request.text()]);
        return new Response(JSON.stringify({ data: [], vector: true, workspace: 'acme' }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const brain = m.createOneBrain({ url: 'https://brain.test', apiKey: 'ob_k', workspace: 'acme', fetch });
      const found = await brain.search({ query: 'renewal' });
      console.log(JSON.stringify({
        exports: Object.keys(m).sort(),
        found,
        sent,
        transcript: m.toTranscript([{ role: 'user', content: 'hi' }]),
        error: new m.OneBrainError('x', 'y') instanceof Error,
      }));
    `;
    const out = JSON.parse(run(process.execPath, ['--input-type=module', '-e', script], app));
    expect(out.exports).toEqual(
      expect.arrayContaining([
        'createOneBrain',
        'toTranscript',
        'OneBrainError',
        'createOneBrainClient',
      ]),
    );
    expect(out.found).toEqual({ data: [], vector: true, workspace: 'acme' });
    expect(out.sent).toEqual([
      [
        'POST',
        'https://brain.test/v1/workspaces/acme/search',
        'Bearer ob_k',
        '{"query":"renewal"}',
      ],
    ]);
    expect(out.transcript).toBe('user: hi\n');
    expect(out.error).toBe(true);
  });

  it("types check in a strict TypeScript project that checks the package's declarations too", () => {
    writeFileSync(
      join(app, 'index.ts'),
      [
        "import { createOneBrain, type Message, OneBrainError, toTranscript } from '@useonebrain/sdk';",
        "const brain = createOneBrain({ apiKey: () => 'ob_k' });",
        "const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];",
        'export async function main(): Promise<string> {',
        "  const found = await brain.search({ query: 'x', limit: 3 });",
        "  const file = await brain.read({ path: 'a.md' });",
        "  const memory = await brain.read({ id: 'm' });",
        '  const skills = await brain.list({ skills: true });',
        "  const sources = await brain.capture({ messages, ref: 's#turn-1', client: 'app' });",
        "  const forgot = await brain.forget({ id: 'm', reason: 'old' });",
        "  const error: OneBrainError = new OneBrainError('x', 'y');",
        "  return [found.data[0]?.path, 'body' in file ? file.body : file.name, memory.text, skills.data.length,",
        '    sources[0]?.duplicate, forgot.memory.status, error.code, toTranscript(messages)].join();',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(app, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2023', 'DOM'],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['index.ts'],
      }),
    );
    const tsc = join(packageDir(sdk, 'typescript'), 'bin/tsc');
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], app);
  });
});
