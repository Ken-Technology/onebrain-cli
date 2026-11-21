import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import workerd from 'workerd';
import { cases } from './cases.ts';

// The same cases as unit.test.ts, inside workerd, the runtime of Cloudflare Workers: cases.ts and
// the package are bundled into one Worker for the browser platform (a node: import fails the
// bundle), served by the workerd binary without nodejs_compat, and run by one request.

const entry = fileURLToPath(new URL('workerd/entry.ts', import.meta.url));
let temp = '';
let child: ChildProcess | undefined;
let results = new Map<string, string | null>();

/** The port workerd listens on, from the control fd it writes `listen` events to. */
function listening(process: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let stderr = '';
    process.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    process.stdio[3]?.on('data', (chunk) => {
      buffered += String(chunk);
      for (const line of buffered.split('\n').slice(0, -1)) {
        const event = JSON.parse(line) as { event?: string; port?: number };
        if (event.event === 'listen' && typeof event.port === 'number') resolve(event.port);
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1);
    });
    process.on('exit', (code) => reject(new Error(`workerd exited ${code}: ${stderr}`)));
  });
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'onebrain-cloudflare-workerd-'));
  // ONEBRAIN_TEST_AGENTS=<a folder with agents installed> bundles that agents instead of this
  // package's own, to check the other ends of the peer range (README, "Supported versions").
  const agentsFrom = process.env.ONEBRAIN_TEST_AGENTS;
  const fromThere = agentsFrom ? createRequire(join(agentsFrom, 'package.json')) : null;
  await build({
    plugins: fromThere
      ? [
          {
            name: 'agents-from',
            setup(bundle) {
              bundle.onResolve({ filter: /^agents(\/|$)/ }, (args) => ({
                path: fromThere.resolve(args.path),
              }));
            },
          },
        ]
      : [],
    entryPoints: [entry],
    outfile: join(temp, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    conditions: ['workerd', 'worker', 'browser'],
    logLevel: 'silent',
  });
  writeFileSync(
    join(temp, 'config.capnp'),
    [
      'using Workerd = import "/workerd/workerd.capnp";',
      'const config :Workerd.Config = (',
      '  services = [(name = "main", worker = .worker)],',
      '  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")],',
      ');',
      'const worker :Workerd.Worker = (',
      '  modules = [(name = "worker.js", esModule = embed "worker.js")],',
      '  compatibilityDate = "2026-11-01",',
      ');',
    ].join('\n'),
  );
  child = spawn(workerd, ['serve', join(temp, 'config.capnp'), '--control-fd=3'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  const port = await listening(child);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(response.status).toBe(200);
  expect(response.headers.get('x-runtime')).toBe('Cloudflare-Workers');
  results = new Map((await response.json()) as [string, string | null][]);
}, 60_000);

afterAll(() => {
  child?.kill();
  if (temp) rmSync(temp, { recursive: true, force: true });
});

describe('@useonebrain/cloudflare in workerd', () => {
  for (const one of cases) {
    it(one.name, () => {
      expect(results.has(one.name), 'the case ran').toBe(true);
      const failure = results.get(one.name);
      if (failure) throw new Error(failure);
    });
  }
});
