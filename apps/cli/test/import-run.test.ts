import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CliClient, getClient } from '../src/client.ts';
import { createCredentialStore, type StoredLogin } from '../src/credentials.ts';
import type { Memory } from '../src/import/collect.ts';
import { uploadFiles, uploadMemories } from '../src/import/upload.ts';
import { type FakeCall, type FakeRoutes, fakeApi, fakeFetch, testIo } from './helpers.ts';

const W = '/v1/workspaces/kenso';
const POST = `POST ${W}/memories`;
const created = { status: 201, body: { id: 'm' } };
const unauthorized = { status: 401, body: { error: { code: 'unauthorized', message: 'No' } } };

const memories = (count: number): Memory[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    line: i + 1,
    text: `memory ${i + 1}`,
    createdAt: null,
  }));
const SERVER = 'http://one.test';
const refOf = (call: FakeCall) => (call.body as { source: { ref: string } }).source.ref;
const tempFile = () =>
  join(mkdtempSync(join(tmpdir(), 'onebrain-run-')), 'memories.jsonl.progress');

function clientOn(routes: FakeRoutes) {
  const { api, calls } = fakeApi(routes);
  const client: CliClient = { api, workspace: 'kenso' };
  return { client, calls, io: testIo() };
}

/** Lets the retry waits pass without real time while the run goes on. */
async function finish<T>(run: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return run;
}

describe('retry', () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] }));
  afterEach(() => void vi.useRealTimers());

  it('counts a memory once when its request fails twice with a network error and then works', async () => {
    let attempts = 0;
    const { client, calls, io } = clientOn({
      [POST]: () => {
        if (++attempts <= 2) throw new TypeError('fetch failed');
        return created;
      },
    });
    const counts = await finish(uploadMemories(client, io.io, memories(1), 'kb'));
    expect(counts).toMatchObject({ created: 1, existing: 0, failed: 0 });
    expect(calls).toHaveLength(3);
    expect(io.stderr()).toBe('');
  });

  it('waits 1, 2, 4, 8 and 16 seconds, then counts the item as failed', async () => {
    const at: number[] = [];
    const { client, calls, io } = clientOn({
      [POST]: () => {
        at.push(Date.now());
        return { status: 503, body: { error: { code: 'unavailable', message: 'Busy' } } };
      },
    });
    expect(await finish(uploadMemories(client, io.io, memories(1), 'kb'))).toMatchObject({
      created: 0,
      failed: 1,
    });
    expect(calls).toHaveLength(6);
    expect(at.slice(1).map((time, i) => time - (at[i] as number))).toEqual([
      1000, 2000, 4000, 8000, 16000,
    ]);
    expect(io.stderr()).toContain('failed memory m1: unavailable: Busy');
  });

  it('retries a 429 after the Retry-After the server gave', async () => {
    let attempts = 0;
    const { client, calls, io } = clientOn({
      [POST]: () =>
        ++attempts === 1
          ? {
              status: 429,
              headers: { 'retry-after': '7' },
              body: { error: { code: 'rate_limited', message: 'Slow down' } },
            }
          : created,
    });
    const run = uploadMemories(client, io.io, memories(1), 'kb');
    await vi.advanceTimersByTimeAsync(6_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    expect(await run).toMatchObject({ created: 1, failed: 0 });
  });

  it('does not retry a 400: it is counted as failed with its code and the run goes on', async () => {
    const { client, calls, io } = clientOn({
      [POST]: (call) =>
        refOf(call) === 'm2'
          ? { status: 400, body: { error: { code: 'invalid_request', message: 'Bad text' } } }
          : created,
    });
    const counts = await finish(uploadMemories(client, io.io, memories(4), 'kb'));
    expect(counts).toMatchObject({ created: 3, failed: 1 });
    expect(calls).toHaveLength(4);
    expect(io.stderr()).toContain('failed memory m2: invalid_request: Bad text');
  });

  it('retries a file upload too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-run-'));
    writeFileSync(join(dir, 'a.md'), 'a');
    let attempts = 0;
    const { client, calls, io } = clientOn({
      [`PUT ${W}/files`]: () => {
        if (++attempts === 1) throw new TypeError('fetch failed');
        return { status: 200, body: {} };
      },
    });
    const counts = await finish(
      uploadFiles(client, io.io, [{ source: join(dir, 'a.md'), target: 'kb/a.md' }]),
    );
    expect(counts).toMatchObject({ created: 1, failed: 0 });
    expect(calls).toHaveLength(2);
  });
});

describe('concurrency', () => {
  it('keeps 8 requests in flight and never more', async () => {
    let now = 0;
    let most = 0;
    const { client, io } = clientOn({
      [POST]: async () => {
        most = Math.max(most, ++now);
        await new Promise((done) => setTimeout(done, 5));
        now--;
        return created;
      },
    });
    const counts = await uploadMemories(client, io.io, memories(40), 'kb');
    expect(counts.created).toBe(40);
    expect(most).toBe(8);
  });

  it('follows the concurrency it is given', async () => {
    let now = 0;
    let most = 0;
    const { client, io } = clientOn({
      [POST]: async () => {
        most = Math.max(most, ++now);
        await new Promise((done) => setTimeout(done, 5));
        now--;
        return created;
      },
    });
    await uploadMemories(client, io.io, memories(20), 'kb', { concurrency: 3 });
    expect(most).toBe(3);
  });

  it('writes one progress line to stderr every N items (1,000 by default)', async () => {
    const { client, io } = clientOn({ [POST]: () => created });
    await uploadMemories(client, io.io, memories(25), 'kb', {
      progressEvery: 10,
      concurrency: 1,
    });
    expect(io.stderr().trim().split('\n')).toEqual([
      'memories: 10 done, 10 created, 0 already there, 0 failed',
      'memories: 20 done, 20 created, 0 already there, 0 failed',
    ]);
    const quiet = clientOn({ [POST]: () => created });
    await uploadMemories(quiet.client, quiet.io.io, memories(25), 'kb');
    expect(quiet.io.stderr()).toBe('');
  });
});

describe('a 401', () => {
  const login: StoredLogin = {
    url: 'http://localhost:8787',
    issuer: 'https://issuer.test',
    clientId: 'cli',
    audience: null,
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };

  /** A stored login, a fake issuer, and an API that accepts only the tokens in `good`. */
  async function stored(good: string[]) {
    const home = mkdtempSync(join(tmpdir(), 'onebrain-home-'));
    const env = { HOME: home, PATH: '', ONEBRAIN_URL: login.url };
    const store = createCredentialStore({ home, env });
    await store.save(login);
    let refreshes = 0;
    const calls: FakeCall[] = [];
    const fetchFn = fakeFetch(
      {
        'GET /.well-known/openid-configuration': () => ({
          body: { token_endpoint: 'https://issuer.test/oauth/token' },
        }),
        'POST /oauth/token': () => {
          refreshes++;
          return { body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } };
        },
        [POST]: (call) =>
          good.includes(call.headers.get('authorization')?.slice(7) ?? '') ? created : unauthorized,
      },
      calls,
    );
    const client = await getClient({ env, home, fetch: fetchFn, workspace: 'kenso' });
    return { client, store, calls, refreshes: () => refreshes, io: testIo() };
  }

  it('refreshes the stored login once mid-run and goes on, for all requests in flight', async () => {
    const t = await stored(['at-2']);
    const counts = await uploadMemories(t.client, t.io.io, memories(20), 'kb', { concurrency: 4 });
    expect(counts).toMatchObject({ created: 20, failed: 0 });
    expect(t.refreshes()).toBe(1);
    expect((await t.store.load(login.url))?.accessToken).toBe('at-2');
    const posts = t.calls.filter((c) => `${c.method} ${c.path}` === POST);
    expect(
      posts.filter((c) => c.headers.get('authorization') === 'Bearer at-1').length,
    ).toBeLessThanOrEqual(4);
  });

  it('stops the run on a second 401, after one refresh', async () => {
    const t = await stored([]);
    await expect(uploadMemories(t.client, t.io.io, memories(50), 'kb')).rejects.toThrow(
      /refused the sign-in \(401\)/,
    );
    expect(t.refreshes()).toBe(1);
    expect(t.calls.filter((c) => `${c.method} ${c.path}` === POST).length).toBeLessThanOrEqual(16);
  });

  it('stops at the first 401 with ONEBRAIN_TOKEN: nothing to refresh', async () => {
    const calls: FakeCall[] = [];
    const fetchFn = fakeFetch({ [POST]: () => unauthorized }, calls);
    const client = await getClient({
      env: { ONEBRAIN_TOKEN: 'tok', PATH: '' },
      home: mkdtempSync(join(tmpdir(), 'onebrain-home-')),
      fetch: fetchFn,
      workspace: 'kenso',
    });
    await expect(uploadMemories(client, testIo().io, memories(50), 'kb')).rejects.toThrow(
      /refused the sign-in/,
    );
    expect(calls.length).toBeLessThanOrEqual(8);
  });

  it('refreshes for any command, not only the import', async () => {
    const t = await stored(['at-2']);
    const result = await t.client.api.POST(
      `${W}/memories` as '/v1/workspaces/{workspace}/memories',
      {
        params: { path: { workspace: 'kenso' } },
        body: { text: 'x', folder: 'kb' },
      },
    );
    expect(result.response.status).toBe(201);
    expect(t.refreshes()).toBe(1);
  });
});

describe('a rerun', () => {
  it('posts only the memories the first run did not finish, and --restart posts all', async () => {
    const file = tempFile();
    const seen: string[] = [];
    let broken = true;
    const routes: FakeRoutes = {
      [POST]: (call) => {
        seen.push(refOf(call));
        return broken && refOf(call) === 'm3'
          ? { status: 400, body: { error: { code: 'invalid_request', message: 'Bad' } } }
          : created;
      },
    };
    const a = clientOn(routes);
    const first = await uploadMemories(a.client, a.io.io, memories(5), 'kb', {
      progressFile: file,
      server: SERVER,
      concurrency: 1,
    });
    expect(first).toMatchObject({ created: 4, failed: 1, resumed: 0 });
    expect(readFileSync(file, 'utf8')).toBe(`# ${SERVER} kenso kb\n1\n2\n4\n5\n`);

    broken = false;
    seen.length = 0;
    const b = clientOn(routes);
    const second = await uploadMemories(b.client, b.io.io, memories(5), 'kb', {
      progressFile: file,
      server: SERVER,
      concurrency: 1,
    });
    expect(seen).toEqual(['m3']);
    expect(b.io.stderr()).toContain(
      `Skipping 4 memories done in an earlier run (${file}). Pass --restart to import them again.\n`,
    );
    expect(second).toMatchObject({ created: 1, failed: 0, resumed: 4 });

    seen.length = 0;
    const c = clientOn(routes);
    await uploadMemories(c.client, c.io.io, memories(5), 'kb', {
      progressFile: file,
      server: SERVER,
      restart: true,
      concurrency: 1,
    });
    expect(seen).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('ignores a progress file made for another folder', async () => {
    const file = tempFile();
    const a = clientOn({ [POST]: () => created });
    await uploadMemories(a.client, a.io.io, memories(3), 'kb', { progressFile: file });
    const b = clientOn({ [POST]: () => created });
    const counts = await uploadMemories(b.client, b.io.io, memories(3), 'other', {
      progressFile: file,
    });
    expect(counts).toMatchObject({ created: 3, resumed: 0 });
  });

  it('ignores a progress file made for another server', async () => {
    const file = tempFile();
    const a = clientOn({ [POST]: () => created });
    await uploadMemories(a.client, a.io.io, memories(3), 'kb', {
      progressFile: file,
      server: 'http://old.test',
    });
    const b = clientOn({ [POST]: () => created });
    const counts = await uploadMemories(b.client, b.io.io, memories(3), 'kb', {
      progressFile: file,
      server: SERVER,
    });
    expect(counts).toMatchObject({ created: 3, resumed: 0 });
    expect(b.io.stderr()).not.toContain('Skipping');
  });

  it('keeps what a stopped run finished, and starts nothing new after the stop', async () => {
    const file = tempFile();
    const { client, calls, io } = clientOn({
      [POST]: (call) => (refOf(call) === 'm3' ? unauthorized : created),
    });
    await expect(
      uploadMemories(client, io.io, memories(50), 'kb', {
        progressFile: file,
        server: SERVER,
        concurrency: 2,
      }),
    ).rejects.toThrow(/refused the sign-in/);
    expect(readFileSync(file, 'utf8').startsWith(`# ${SERVER} kenso kb\n1\n2\n`)).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(5);
  });
});
