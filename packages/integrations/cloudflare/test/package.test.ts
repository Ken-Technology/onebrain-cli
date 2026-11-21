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
// fresh project with plain npm and imported by plain Node, which runs no TypeScript in node_modules.
// The install is offline: @useonebrain/sdk is packed from this checkout, and its dependencies from
// node_modules. The peer `agents` is linked from this checkout's node_modules, as a user's own.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const repo = join(pkg, '../../..');
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
  temp = mkdtempSync(join(tmpdir(), 'onebrain-cloudflare-pack-'));
  const packed = (filter: string) => {
    const before = new Set(readdirSync(temp));
    run('pnpm', ['--filter', filter, 'pack', '--pack-destination', temp], repo);
    const [name] = readdirSync(temp).filter((file) => file.endsWith('.tgz') && !before.has(file));
    return join(temp, name ?? 'missing.tgz');
  };
  const tarballs = [packed('@useonebrain/cloudflare'), packed('@useonebrain/sdk')];

  // The SDK's dependencies, and theirs, packed from node_modules, each from a copy: pnpm's store
  // hard-links equal files, npm packs a hard link as a link entry, and npm's install leaves those out.
  const sdk = join(repo, 'packages/sdk');
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
  mkdirSync(join(app, 'node_modules'), { recursive: true });
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
  // The peer, as the user installs it: linked after npm's install (which prunes what it did not
  // install), so its own dependencies resolve where pnpm put them.
  symlinkSync(packageDir(pkg, 'agents'), join(app, 'node_modules/agents'));
  installed = join(app, 'node_modules/@useonebrain/cloudflare');
}, 240_000);

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

  it('points its exports at dist/, peers on agents, and depends on the published SDK', () => {
    const packed = manifest(installed);
    expect(packed).toMatchObject({
      name: '@useonebrain/cloudflare',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      license: 'MIT',
      type: 'module',
      sideEffects: false,
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      publishConfig: { access: 'public', provenance: true },
      repository: {
        url: expect.stringContaining('Ken-Technology/onebrain-cli'),
        directory: 'packages/integrations/cloudflare',
      },
      peerDependencies: { agents: manifest(pkg).peerDependencies?.agents },
      dependencies: { '@useonebrain/sdk': `^${manifest(join(repo, 'packages/sdk')).version}` },
    });
    expect(packed.private).toBeUndefined();
  });

  it('imports nothing from Node: only the SDK and agents/skills, by name', () => {
    const imports: string[] = [];
    for (const file of walk(join(installed, 'dist'))) {
      const text = readFileSync(join(installed, 'dist', file), 'utf8');
      expect(text, file).not.toMatch(/['"]node:/);
      for (const pattern of IMPORTS) {
        for (const match of text.matchAll(pattern)) imports.push(match[1] ?? '');
      }
      expect(text, file).not.toMatch(/\bprocess\.env\b|\bBuffer\b|\brequire\(/);
    }
    const runtime = walk(join(installed, 'dist'))
      .filter((file) => file.endsWith('.js'))
      .flatMap((file) => {
        const text = readFileSync(join(installed, 'dist', file), 'utf8');
        return [...text.matchAll(IMPORTS[0] as RegExp)].map((match) => match[1] ?? '');
      });
    expect([...new Set(runtime.filter((spec) => !spec.startsWith('.')))].sort()).toEqual([
      '@useonebrain/sdk',
      'agents/skills',
    ]);
    expect(imports.filter((spec) => builtinModules.includes(spec))).toEqual([]);
    for (const spec of imports.filter((one) => one.startsWith('.'))) {
      expect(spec).toMatch(/\.js$/);
      expect(existsSync(join(installed, 'dist', spec))).toBe(true);
    }
  });

  it('loads in plain Node from node_modules, and its skills source lists signed in', () => {
    const script = `
      const m = await import('@useonebrain/cloudflare');
      const sent = [];
      const fetch = async (request) => {
        sent.push([request.method, request.url, request.headers.get('authorization')]);
        const url = new URL(request.url);
        const body = url.pathname.endsWith('/skills')
          ? { data: [{ name: 'hello', path: 'skills/hello', description: 'd', version: 1, updatedAt: 'x' }] }
          : { name: 'hello', path: 'skills/hello', description: 'd', version: 1, updatedAt: 'x',
              files: [{ path: 'SKILL.md', body: '---\\nname: hello\\ndescription: Say hello.\\n---\\nHi.' }] };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      };
      const source = m.onebrainSkills({ env: { ONEBRAIN_URL: 'https://brain.test', ONEBRAIN_API_KEY: 'ob_k', ONEBRAIN_WORKSPACE: 'acme' }, fetch });
      const listed = await source.list();
      console.log(JSON.stringify({
        exports: Object.keys(m).sort(),
        names: listed.ok ? listed.value.skills.map((one) => one.skill.name) : listed.error.message,
        sent,
        block: m.onebrainContext().label,
      }));
    `;
    const out = JSON.parse(run(process.execPath, ['--input-type=module', '-e', script], app));
    expect(out.exports).toEqual([
      'addOneBrain',
      'captureTurn',
      'onebrainContext',
      'onebrainSkills',
      'withOneBrainApprovals',
    ]);
    expect(out.names).toEqual(['hello']);
    expect(out.sent).toEqual([
      ['GET', 'https://brain.test/v1/workspaces/acme/skills', 'Bearer ob_k'],
      ['GET', 'https://brain.test/v1/workspaces/acme/skills/hello', 'Bearer ob_k'],
    ]);
    expect(out.block).toBe('onebrain');
  });

  it("type checks in a strict TypeScript project against agents' own types", () => {
    writeFileSync(
      join(app, 'index.ts'),
      [
        "import type { ContextConfig } from 'agents/context';",
        "import type { SkillSource } from 'agents/skills';",
        "import { addOneBrain, captureTurn, onebrainContext, onebrainSkills, withOneBrainApprovals, type McpAgent } from '@useonebrain/cloudflare';",
        'type Env = { ONEBRAIN_API_KEY: string; ONEBRAIN_URL?: string; AI: unknown };',
        'export function setup(env: Env, agent: McpAgent) {',
        '  const skills: SkillSource[] = [onebrainSkills({ env })];',
        "  const blocks: ContextConfig[] = [onebrainContext({ env, folder: 'agents/chat' })];",
        "  const tools = withOneBrainApprovals({ tool_onebrain_write: { description: 'w' } });",
        '  return { skills, blocks, tools, added: addOneBrain(agent, { env }) };',
        '}',
        'type Storage = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };',
        "export const turn = (agent: { name: string; messages: { id: string; role: 'user' | 'assistant'; parts: { type: 'text'; text: string }[] }[]; ctx: { storage: Storage } }, env: Env) =>",
        "  captureTurn(agent, { status: 'completed' }, { env, capture: true });",
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
          // agents' own declarations name optional peers (ai, MCP) this project does not install.
          skipLibCheck: true,
        },
        files: ['index.ts'],
      }),
    );
    const tsc = join(packageDir(pkg, 'typescript'), 'bin/tsc');
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], app);
  });
});
