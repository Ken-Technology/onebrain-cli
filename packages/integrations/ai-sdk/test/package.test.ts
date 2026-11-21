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

// What npm gets: the package as `pnpm pack` builds it (prepack runs the build), installed with
// plain npm into a fresh project next to the SDK's tarball and the AI SDK, and run by plain Node.
// The install is offline: every dependency is packed from this checkout's node_modules.

const pkg = fileURLToPath(new URL('..', import.meta.url));
const repo = join(pkg, '../../..');
const PEERS = ['ai', 'zod', '@ai-sdk/mcp'];
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
  name?: string;
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
  temp = mkdtempSync(join(tmpdir(), 'onebrain-ai-sdk-pack-'));
  const ours = join(temp, 'ours');
  run('pnpm', ['--filter', '@useonebrain/ai-sdk', 'pack', '--pack-destination', ours], repo);
  run('pnpm', ['--filter', '@useonebrain/sdk', 'pack', '--pack-destination', ours], repo);
  const tarballs = readdirSync(ours).map((file) => join(ours, file));

  // The peers and every dependency below them and the SDK, packed from node_modules, each from a
  // copy: pnpm's store hard-links equal files, and npm's install leaves hard-link entries out.
  const sdk = packageDir(pkg, '@useonebrain/sdk');
  const queue = [
    ...PEERS.map((name) => packageDir(pkg, name)),
    ...Object.keys(manifest(sdk).dependencies ?? {}).map((dep) => packageDir(sdk, dep)),
  ];
  const seen = new Set<string>();
  for (const [index, dir] of queue.entries()) {
    const name = `${manifest(dir).name}`;
    if (seen.has(name)) continue;
    seen.add(name);
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
    for (const dep of Object.keys(manifest(dir).dependencies ?? {})) {
      queue.push(packageDir(dir, dep));
    }
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
  installed = join(app, 'node_modules/@useonebrain/ai-sdk');
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
        'dist/mcp.js',
        'dist/mcp.d.ts',
      ]),
    );
    expect(
      files.filter(
        (file) => !/^(dist\/[\w-]+\.(js|d\.ts)|LICENSE|README\.md|package\.json)$/.test(file),
      ),
    ).toEqual([]);
  });

  it('points its exports at dist/, depends on the published SDK, and has the AI SDK as a peer', () => {
    const packed = manifest(installed);
    expect(packed).toMatchObject({
      name: '@useonebrain/ai-sdk',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      license: 'MIT',
      type: 'module',
      sideEffects: false,
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './mcp': { types: './dist/mcp.d.ts', default: './dist/mcp.js' },
      },
      publishConfig: { access: 'public', provenance: true },
      repository: {
        url: expect.stringContaining('Ken-Technology/onebrain-cli'),
        directory: 'packages/integrations/ai-sdk',
      },
      peerDependencies: {
        ai: '^7.0.0',
        '@ai-sdk/mcp': expect.any(String),
        zod: expect.any(String),
      },
      peerDependenciesMeta: { '@ai-sdk/mcp': { optional: true } },
    });
    expect(packed.dependencies).toEqual({
      '@useonebrain/sdk': `^${manifest(join(repo, 'packages/sdk')).version}`,
    });
    expect(packed.private).toBeUndefined();
  });

  it('imports nothing from Node and only its dependency and peers', () => {
    const imports: string[] = [];
    for (const file of walk(join(installed, 'dist'))) {
      const text = readFileSync(join(installed, 'dist', file), 'utf8');
      expect(text, file).not.toMatch(/['"]node:/);
      expect(text, file).not.toMatch(/\bprocess\.env\b|\bBuffer\b|\brequire\(/);
      for (const pattern of IMPORTS) {
        for (const match of text.matchAll(pattern)) imports.push(match[1] ?? '');
      }
    }
    const external = [...new Set(imports.filter((spec) => !spec.startsWith('.')))].sort();
    expect(external).toEqual(['@ai-sdk/mcp', '@useonebrain/sdk', 'ai', 'zod/v4']);
    expect(external.filter((spec) => builtinModules.includes(spec))).toEqual([]);
    for (const spec of imports.filter((one) => one.startsWith('.'))) {
      expect(spec).toMatch(/\.js$/);
      expect(existsSync(join(installed, 'dist', spec))).toBe(true);
    }
    // Only the MCP entry imports the optional peer: the main entry loads without it.
    expect(readFileSync(join(installed, 'dist/index.js'), 'utf8')).not.toContain('@ai-sdk/mcp');
  });

  it('loads in plain Node: generateText with withOneBrain recalls, and the tools are there', () => {
    const script = `
      const m = await import('@useonebrain/ai-sdk');
      const { onebrainMcp } = await import('@useonebrain/ai-sdk/mcp');
      const { generateText } = await import('ai');
      const { MockLanguageModelV4 } = await import('ai/test');
      const fetch = async (request) => {
        const path = new URL(request.url).pathname;
        const body = path.endsWith('/search')
          ? { workspace: 'acme', vector: true, data: [{ id: 'f', kind: 'file', path: 'a.md', snippet: 'Renewal is in March.', status: 'accepted', source: null, score: 1 }] }
          : { id: 's', duplicate: false };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const model = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'March.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        }),
      });
      const options = { url: 'https://brain.test', apiKey: 'ob_k', workspace: 'acme', fetch };
      const result = await generateText({ model: m.withOneBrain(model, { ...options, capture: false }), prompt: 'When?' });
      console.log(JSON.stringify({
        exports: Object.keys(m).sort(),
        mcp: typeof onebrainMcp,
        text: result.text,
        recalled: model.doGenerateCalls[0].prompt[0].content[0].text.includes('a.md'),
        tools: Object.keys(m.onebrainTools(options)),
      }));
    `;
    const out = JSON.parse(run(process.execPath, ['--input-type=module', '-e', script], app));
    expect(out).toEqual({
      exports: [
        'captureSession',
        'loadOneBrainSkills',
        'onebrainMiddleware',
        'onebrainTools',
        'withOneBrain',
      ],
      mcp: 'function',
      text: 'March.',
      recalled: true,
      tools: ['search', 'read', 'list', 'remember', 'write', 'forget'],
    });
  });

  it("types check in a strict TypeScript project that checks the package's declarations too", () => {
    writeFileSync(
      join(app, 'index.ts'),
      [
        "import { captureSession, type HarnessSkill, loadOneBrainSkills, onebrainTools, withOneBrain } from '@useonebrain/ai-sdk';",
        "import { onebrainMcp } from '@useonebrain/ai-sdk/mcp';",
        "import { generateText, isStepCount, type LanguageModel } from 'ai';",
        'export async function main(model: LanguageModel): Promise<string> {',
        "  const wrapped = withOneBrain(model, { recall: { limit: 3 }, capture: { folder: 'agents' }, waitUntil: () => {} });",
        '  const result = await generateText({',
        '    model: wrapped,',
        '    tools: onebrainTools({ needsApproval: false }),',
        "    prompt: 'When does Acme renew?',",
        "    providerOptions: { onebrain: { sessionId: 's1' } },",
        '    stopWhen: isStepCount(3),',
        '  });',
        "  await captureSession({ messages: [{ role: 'user', content: 'hi' }, ...result.responseMessages], sessionId: 's1', turn: 1 });",
        '  const skills: HarnessSkill[] = await loadOneBrainSkills();',
        "  const mcp = await onebrainMcp({ apiKey: () => 'ob_k' });",
        '  const tools = await mcp.tools();',
        '  return [result.text, skills[0]?.content, Object.keys(tools).join()].join();',
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
          skipLibCheck: true,
        },
        files: ['index.ts'],
      }),
    );
    const tsc = join(packageDir(pkg, 'typescript'), 'bin/tsc');
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], app);
  });
});
