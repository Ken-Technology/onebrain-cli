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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// What npm gets: the package as `pnpm pack` builds it (prepack runs the build), installed into a
// fresh project with plain npm next to the packed SDK, and imported by plain Node, which runs no
// TypeScript in node_modules. The install is offline: the dependencies are packed from this
// checkout's node_modules too. eve, the peer, is linked in from this checkout as an agent has it.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const repo = join(pkg, '../../..');
const sdk = join(repo, 'packages/sdk');
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
type Manifest = Record<string, unknown> & {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
/** Every file under dir, relative to it. */
const walk = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));

const IMPORTS = [
  /^\s*(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

let temp = '';
let installed = '';
let app = '';

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'onebrain-eve-pack-'));
  for (const name of ['@useonebrain/sdk', '@useonebrain/eve']) {
    run('pnpm', ['--filter', name, 'pack', '--pack-destination', temp], repo);
  }
  const tarballs = readdirSync(temp)
    .filter((file) => file.endsWith('.tgz'))
    .map((file) => join(temp, file));

  // The dependencies other than the SDK, and theirs, packed from node_modules, so npm needs no
  // registry. Each from a copy: pnpm's store hard-links equal files, npm packs a hard link as a
  // link entry, and npm's install leaves link entries out.
  const queue = [
    ...Object.keys(manifest(pkg).dependencies ?? {})
      .filter((dep) => dep !== '@useonebrain/sdk')
      .map((dep) => packageDir(pkg, dep)),
    ...Object.keys(manifest(sdk).dependencies ?? {}).map((dep) => packageDir(sdk, dep)),
  ];
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
      '--legacy-peer-deps',
      '--cache',
      join(temp, 'cache'),
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      ...tarballs,
    ],
    app,
  );
  // eve is a peer: the agent brings it. Linked from this checkout, where its own dependencies are.
  symlinkSync(packageDir(pkg, 'eve'), join(app, 'node_modules/eve'), 'dir');
  installed = join(app, 'node_modules/@useonebrain/eve');
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
  });

  it('points its exports at dist/, depends on the published SDK, and takes eve 1.x as a peer', () => {
    const packed = manifest(installed);
    expect(packed).toMatchObject({
      name: '@useonebrain/eve',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      license: 'MIT',
      type: 'module',
      sideEffects: false,
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      publishConfig: { access: 'public', provenance: true },
      repository: {
        url: expect.stringContaining('Ken-Technology/onebrain-cli'),
        directory: 'packages/integrations/eve',
      },
      engines: { node: expect.any(String) },
      peerDependencies: { eve: '>=1.0.0 <2' },
    });
    expect(packed.private).toBeUndefined();
    expect(packed.dependencies?.['@useonebrain/sdk']).toBe(`^${manifest(sdk).version}`);
    expect(packed.devDependencies).toBeDefined();
  });

  it('imports only eve, the SDK and zod, and nothing from Node', () => {
    const imports: string[] = [];
    for (const file of walk(join(installed, 'dist'))) {
      const text = readFileSync(join(installed, 'dist', file), 'utf8');
      expect(text, file).not.toMatch(/['"]node:/);
      for (const pattern of IMPORTS) {
        for (const match of text.matchAll(pattern)) imports.push(match[1] ?? '');
      }
    }
    // Doc comments quote imports too: those are the package's own name.
    const external = [
      ...new Set(imports.filter((spec) => !spec.startsWith('.') && spec !== '@useonebrain/eve')),
    ];
    expect(external.filter((spec) => !/^(eve\/[\w/]+|@useonebrain\/sdk|zod)$/.test(spec))).toEqual(
      [],
    );
    expect(external.filter((spec) => builtinModules.includes(spec))).toEqual([]);
    for (const spec of imports.filter((one) => one.startsWith('.'))) {
      expect(spec).toMatch(/\.js$/);
      expect(existsSync(join(installed, 'dist', spec))).toBe(true);
    }
  });

  it('loads in plain Node from node_modules, and recall and capture go out signed in', () => {
    const script = `
      const m = await import('@useonebrain/eve');
      const sent = [];
      const fetch = async (request) => {
        const form = request.headers.get('content-type')?.startsWith('multipart/') ? await request.formData() : null;
        sent.push([request.method, request.url, request.headers.get('authorization'), form ? form.get('externalRef') : await request.text()]);
        const body = form
          ? { id: 's', kind: 'session', folder: 'agents/eve', visibility: 'workspace', duplicate: false }
          : { data: [{ id: 'f', kind: 'file', path: 'a.md', snippet: 'Renewal is in March.', status: 'accepted', source: null, score: 1, title: null }], vector: true, workspace: 'acme' };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      };
      const provider = m.default({ url: 'https://brain.test', apiKey: 'ob_k', workspace: 'acme', fetch });
      const user = { role: 'user', kind: 'user', metadata: { 'eve.turn': 't1' }, content: 'When is the renewal?' };
      const session = { id: 'wrun_1', auth: { current: null } };
      const ctx = { session, memory: { slot: 'onebrain' }, operationId: 'op', turn: { id: 't1', sequence: 0, input: [user] } };
      const recalled = await provider.recall['turn.started']({ ...ctx, messages: [user] });
      const info = console.info;
      console.info = () => {};
      await provider.capture['turn.completed']({ ...ctx, messages: [user, { role: 'assistant', content: 'In March.' }] });
      console.info = info;
      const tools = await provider.tools({});
      console.log(JSON.stringify({
        exports: Object.keys(m).sort(),
        recalled: recalled.messages.map((one) => [one.id, one.content.split('\\n')[0]]),
        sent,
        tools: Object.keys(tools),
        connection: m.onebrainConnection({ url: 'https://brain.test', apiKey: 'ob_k' }).url,
        notice: m.ONE_BRAIN_NOTICE,
      }));
    `;
    const out = JSON.parse(run(process.execPath, ['--input-type=module', '-e', script], app));
    expect(out.exports).toEqual([
      'ONE_BRAIN_NOTICE',
      'OneBrainError',
      'TOOL_NAMES',
      'default',
      'onebrain',
      'onebrainConnection',
      'onebrainSkills',
    ]);
    expect(out.recalled).toEqual([['onebrain:onebrain:recall-1', out.notice]]);
    expect(out.sent).toEqual([
      [
        'POST',
        'https://brain.test/v1/workspaces/acme/search',
        'Bearer ob_k',
        '{"query":"When is the renewal?","limit":5}',
      ],
      ['POST', 'https://brain.test/v1/workspaces/acme/sources', 'Bearer ob_k', 'eve:wrun_1#turn-1'],
    ]);
    expect(out.tools).toEqual(['search', 'read', 'list', 'remember', 'write', 'forget']);
    expect(out.connection).toBe('https://brain.test/mcp');
  });

  it("types check in a strict TypeScript project that checks the package's declarations too", () => {
    writeFileSync(
      join(app, 'index.ts'),
      [
        "import onebrain, { type OneBrainOptions, onebrainConnection, onebrainSkills } from '@useonebrain/eve';",
        'const options: OneBrainOptions = {',
        "  apiKey: ({ session }) => `token-for-${session.auth.current?.principalId ?? 'nobody'}`,",
        "  recall: { limit: 3, kinds: ['file', 'memory'] },",
        "  capture: { folder: 'agents/eve' },",
        "  tools: { include: ['search', 'read', 'remember'], approval: [] },",
        '};',
        'export const memory = onebrain(options);',
        'export const off = onebrain({ capture: false, recall: false, tools: false });',
        "export const connection = onebrainConnection({ approval: ['write'] });",
        "export const skills = onebrainSkills({ prefix: 'team-', deferred: true });",
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
          // eve's own declarations are eve's to check; the package's are checked through the
          // file above, which uses each export.
          skipLibCheck: true,
        },
        files: ['index.ts'],
      }),
    );
    const tsc = join(packageDir(pkg, 'typescript'), 'bin/tsc');
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], app);
  });
});
