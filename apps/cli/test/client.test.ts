import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError, CliError, getClient, storedLogin, unwrap } from '../src/client.ts';
import { writeConfig } from '../src/config.ts';
import { createCredentialStore, type StoredLogin } from '../src/credentials.ts';
import { type FakeCall, fakeFetch, rotatingIssuer, serveFake } from './helpers.ts';

const home = () => mkdtempSync(join(tmpdir(), 'onebrain-client-'));
const me = (slug: string | null, workspaces = ['kenso']) => ({
  principal: { id: 'p1', kind: 'agent', displayName: 'a-claude', email: null },
  actsFor: { id: 'p2', displayName: 'A', email: 'a@test' },
  currentWorkspace: slug ? { id: 'w1', slug, name: slug } : null,
  workspaces: workspaces.map((s) => ({ id: s, slug: s, name: s, role: 'editor' })),
  organizations: [],
});

describe('getClient', () => {
  it('prefers ONEBRAIN_API_KEY and takes the workspace from /v1/me', async () => {
    const calls: FakeCall[] = [];
    const fetchFn = fakeFetch({ 'GET /v1/me': () => ({ body: me('kenso') }) }, calls);
    const client = await getClient({
      env: { ONEBRAIN_API_KEY: 'ob_key', ONEBRAIN_TOKEN: 'tok' },
      home: home(),
      fetch: fetchFn,
    });
    expect(client.workspace).toBe('kenso');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ob_key');
    expect(calls[0]?.headers.get('x-onebrain-via')).toBe('cli');
  });

  it('refuses a --workspace that is not the agent key workspace', async () => {
    const fetchFn = fakeFetch({ 'GET /v1/me': () => ({ body: me('kenso') }) });
    await expect(
      getClient({
        env: { ONEBRAIN_API_KEY: 'ob_key' },
        home: home(),
        fetch: fetchFn,
        workspace: 'other',
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('takes a person workspace from the flag, then the env, then the stored setting, without calling the API', async () => {
    const dir = home();
    writeConfig(dir, { workspace: 'stored' });
    const calls: FakeCall[] = [];
    const fetchFn = fakeFetch({}, calls);
    const env = { ONEBRAIN_TOKEN: 'tok', ONEBRAIN_WORKSPACE: 'from-env' };
    expect((await getClient({ env, home: dir, fetch: fetchFn, workspace: 'flag' })).workspace).toBe(
      'flag',
    );
    expect((await getClient({ env, home: dir, fetch: fetchFn })).workspace).toBe('from-env');
    expect(
      (await getClient({ env: { ONEBRAIN_TOKEN: 'tok' }, home: dir, fetch: fetchFn })).workspace,
    ).toBe('stored');
    expect(calls).toEqual([]);
  });

  it('falls back to the only workspace a person belongs to', async () => {
    const fetchFn = fakeFetch({ 'GET /v1/me': () => ({ body: me(null, ['kenso']) }) });
    expect(
      (await getClient({ env: { ONEBRAIN_TOKEN: 'tok' }, home: home(), fetch: fetchFn })).workspace,
    ).toBe('kenso');
  });

  it('says how to sign in when there is no credential', async () => {
    await expect(getClient({ env: { PATH: '' }, home: home() })).rejects.toThrow(/onebrain login/);
  });
});

describe('the first read of the stored login', () => {
  /** A Mac whose `security` ends every call with this exit code. */
  const mac = (dir: string, status: number) => {
    writeFileSync(join(dir, 'security'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'security'), 0o755);
    return createCredentialStore({
      home: dir,
      env: { PATH: dir },
      platform: 'darwin',
      run: () => ({ status, stdout: '' }),
    });
  };

  it('says the keychain refused, never "Not signed in", when a Mac keychain would not answer', async () => {
    // Over SSH the login keychain is locked: `security` exits 36 for a person who is signed in.
    const reading = storedLogin(mac(home(), 36), 'http://localhost:8787');
    await expect(reading).rejects.toBeInstanceOf(CliError);
    await expect(reading).rejects.toThrow(
      'The keychain refused (exit 36). Run this in Terminal on the Mac.',
    );
    await expect(reading).rejects.not.toThrow(/Not signed in/);
  });

  it('answers nobody when the keychain has no such item, and passes any other failure on', async () => {
    expect(await storedLogin(mac(home(), 44), 'http://localhost:8787')).toBeNull();
    const broken = {
      load: () => Promise.reject(new TypeError('boom')),
      save: async () => 'file' as const,
    };
    await expect(storedLogin(broken, 'http://localhost:8787')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('the refresh lock shared with the Mac app', () => {
  const API = 'http://localhost:8787';
  const env = { PATH: '', ONEBRAIN_URL: API };
  const login = (overrides: Partial<StoredLogin> = {}): StoredLogin => ({
    url: API,
    issuer: 'https://issuer.test',
    clientId: 'cli',
    audience: null,
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: new Date(Date.now() - 1_000).toISOString(), // expired: the next client refreshes
    ...overrides,
  });
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
  const lockFile = (dir: string) => join(dir, '.config/onebrain/refresh.lock');
  const unauthorized = { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } };

  it('two clients that find the login expired at once refresh it once, and both go on', async () => {
    const dir = home();
    const store = createCredentialStore({ home: dir, env });
    await store.save(login());
    const issuer = rotatingIssuer({ delayMs: 50 });
    const calls: FakeCall[] = [];
    const fetchFn = fakeFetch(
      { ...issuer.routes, 'GET /v1/me': () => ({ body: me('kenso') }) },
      calls,
    );
    const [a, b] = await Promise.all([
      getClient({ env, home: dir, fetch: fetchFn, workspace: 'kenso' }),
      getClient({ env, home: dir, fetch: fetchFn, workspace: 'kenso' }),
    ]);
    await a.api.GET('/v1/me');
    await b.api.GET('/v1/me');
    expect(issuer.refreshes()).toBe(1);
    expect(
      calls.filter((call) => call.path === '/v1/me').map((c) => c.headers.get('authorization')),
    ).toEqual(['Bearer at-2', 'Bearer at-2']);
    expect((await store.load(API))?.refreshToken).toBe('rt-2');
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it('on a 401 it takes the token another process already stored, and calls no issuer', async () => {
    const dir = home();
    const store = createCredentialStore({ home: dir, env });
    await store.save(login({ expiresAt: inAnHour() }));
    const issuer = rotatingIssuer();
    const fetchFn = fakeFetch({
      ...issuer.routes,
      'GET /v1/me': (call) =>
        call.headers.get('authorization') === 'Bearer at-9' ? { body: me('kenso') } : unauthorized,
    });
    const client = await getClient({ env, home: dir, fetch: fetchFn, workspace: 'kenso' });
    // The Mac app refreshes while this process still holds at-1 in memory.
    await store.save(login({ accessToken: 'at-9', refreshToken: 'rt-9', expiresAt: inAnHour() }));
    const result = await client.api.GET('/v1/me');
    expect(result.response.status).toBe(200);
    expect(issuer.refreshes()).toBe(0);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it('says the sign-in expired when the issuer refuses the refresh token, and leaves no lock', async () => {
    const dir = home();
    const store = createCredentialStore({ home: dir, env });
    await store.save(login({ refreshToken: 'rt-0' })); // not the issuer's current token
    const issuer = rotatingIssuer();
    await expect(
      getClient({ env, home: dir, fetch: fakeFetch(issuer.routes), workspace: 'kenso' }),
    ).rejects.toThrow('Your sign-in expired. Run onebrain login.');
    expect(existsSync(lockFile(dir))).toBe(false);
    expect((await store.load(API))?.accessToken).toBe('at-1'); // the stored login is not deleted
  });

  it('says the sign-in service did not answer when the refresh runs out of time, and keeps the login', async () => {
    const dir = home();
    const store = createCredentialStore({ home: dir, env });
    await store.save(login());
    const timedOut = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(
      getClient({ env, home: dir, fetch: timedOut, workspace: 'kenso' }),
    ).rejects.toMatchObject({
      name: 'CliError',
      exitCode: 1,
      message: 'The sign-in service did not answer in 20 seconds. Try again.',
    });
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(await store.load(API)).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });
  });

  it('two CLI processes that refresh at once both stay signed in, and the issuer sees one refresh', async () => {
    const dir = home();
    const issuer = rotatingIssuer({ delayMs: 1_500 });
    const server = await serveFake({
      ...issuer.routes,
      'GET /v1/me': (call) =>
        call.headers.get('authorization') === `Bearer ${issuer.accessToken()}`
          ? { body: me('kenso') }
          : unauthorized,
    });
    issuer.serveAt(server.url);
    const cli = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    /** `onebrain whoami` in its own process, with the file store and no keychain tool. */
    const whoami = () =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, [cli, 'whoami'], {
          env: { HOME: dir, PATH: '', ONEBRAIN_URL: server.url },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (chunk: Buffer) => {
          err += chunk.toString();
        });
        child.on('close', (code) => resolve({ code, err }));
      });
    try {
      const store = createCredentialStore({ home: dir, env: { PATH: '' } });
      await store.save(login({ url: server.url, issuer: server.url }));
      const [a, b] = await Promise.all([whoami(), whoami()]);
      expect([a.code, b.code], a.err + b.err).toEqual([0, 0]);
      expect(issuer.refreshes()).toBe(1);
      expect((await store.load(server.url))?.accessToken).toBe('at-2');
      expect(existsSync(lockFile(dir))).toBe(false);
    } finally {
      await server.stop();
    }
  });
});

describe('unwrap', () => {
  it('turns an API error into an ApiError with its extra fields', () => {
    const response = new Response(null, { status: 409 });
    const error = { error: { code: 'conflict', message: 'Stale', currentVersion: 1 } };
    try {
      unwrap({ error, response });
      expect.unreachable();
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown).toMatchObject({ status: 409, code: 'conflict', extra: { currentVersion: 1 } });
    }
  });
});
