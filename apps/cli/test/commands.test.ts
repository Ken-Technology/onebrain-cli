import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, getClient, unwrap } from '../src/client.ts';
import login, { deviceLogin, signInSettings } from '../src/commands/login.ts';
import whoami from '../src/commands/whoami.ts';
import workspace from '../src/commands/workspace.ts';
import { readConfig } from '../src/config.ts';
import { loadCommands } from '../src/index.ts';
import { type FakeCall, type FakeRoutes, fakeApi, fakeFetch, testIo } from './helpers.ts';

it('loads the real commands', async () => {
  const names = (await loadCommands()).map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining(['login', 'whoami', 'workspace']));
});

const agentMe = {
  principal: { id: 'p1', kind: 'agent', displayName: 'a-claude', email: null },
  actsFor: { id: 'p2', displayName: 'A', email: 'a@test' },
  currentWorkspace: { id: 'w1', slug: 'kenso', name: 'Kenso', role: 'editor' },
  workspaces: [{ id: 'w1', slug: 'kenso', name: 'Kenso', role: 'editor' }],
  organizations: [],
};

describe('whoami', () => {
  it('names the person an owned agent acts for', async () => {
    const { api } = fakeApi({ 'GET /v1/me': () => ({ body: agentMe }) });
    const t = testIo({ api });
    expect(await whoami.run([], t.io)).toBe(0);
    expect(t.stdout().split('\n')[0]).toBe('a-claude (acts for a@test)');
  });
});

describe('workspace use', () => {
  it('sets the current workspace on the server and stores it', async () => {
    const { api, calls } = fakeApi({ 'PUT /v1/me/workspace': () => ({ body: agentMe }) });
    const t = testIo({ api });
    expect(await workspace.run(['use', 'kenso'], t.io)).toBe(0);
    expect(calls[0]?.body).toEqual({ workspace: 'kenso' });
    expect(readConfig(t.home).workspace).toBe('kenso');
  });

  it('refuses with an agent key', async () => {
    const t = testIo({ env: { ONEBRAIN_API_KEY: 'ob_x' } });
    await expect(workspace.run(['use', 'kenso'], t.io)).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('device login', () => {
  const discovery: FakeRoutes = {
    'GET /.well-known/openid-configuration': () => ({
      body: {
        device_authorization_endpoint: 'https://issuer.test/oauth/device/code',
        token_endpoint: 'https://issuer.test/oauth/token',
      },
    }),
    'POST /oauth/device/code': (call) => {
      const form = new URLSearchParams(call.body as string);
      expect(form.get('client_id')).toBe('cli');
      expect(form.get('audience')).toBe('https://api.test');
      return {
        body: {
          device_code: 'dc',
          user_code: 'ABCD-EFGH',
          verification_uri_complete: 'https://issuer.test/activate?user_code=ABCD-EFGH',
          interval: 5,
          expires_in: 600,
        },
      };
    },
  };
  const options = (fetchFn: typeof fetch, sleeps: number[] = [], shown: string[] = []) => ({
    issuer: 'https://issuer.test',
    clientId: 'cli',
    audience: 'https://api.test',
    fetch: fetchFn,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    show: (uri: string, code: string) => shown.push(`${uri} ${code}`),
  });

  it('polls until the person confirms, slowing down when asked', async () => {
    const replies: Record<string, unknown>[] = [
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
    ];
    const fetchFn = fakeFetch({
      ...discovery,
      'POST /oauth/token': () => {
        const reply = replies.shift();
        return { status: reply && 'error' in reply ? 400 : 200, body: reply };
      },
    });
    const sleeps: number[] = [];
    const shown: string[] = [];
    const result = await deviceLogin(options(fetchFn, sleeps, shown));
    expect(result).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(shown[0]).toContain('ABCD-EFGH');
  });

  it('stops when the person denies the sign-in', async () => {
    const fetchFn = fakeFetch({
      ...discovery,
      'POST /oauth/token': () => ({ status: 400, body: { error: 'access_denied' } }),
    });
    const failure = deviceLogin(options(fetchFn));
    await expect(failure).rejects.toBeInstanceOf(CliError);
    await expect(failure).rejects.toThrow('Sign-in was denied.');
  });
});

describe('login', () => {
  const DOC = {
    resource: 'https://api.test/mcp',
    authorization_servers: ['https://issuer.test/'],
    bearer_methods_supported: ['header'],
    resource_name: 'One Brain',
    onebrain_cli_client_id: 'doc-cli',
    onebrain_audience: 'https://doc-audience.test',
  };
  const me = {
    principal: { id: 'p1', kind: 'human', displayName: 'Ana', email: 'ana@test' },
    actsFor: null,
    currentWorkspace: null,
    workspaces: [],
    organizations: [],
  };

  /** The API and the issuer behind one fake fetch. Every access token expires at once. */
  function server(doc: Record<string, unknown>, calls: FakeCall[] = []) {
    const tokens = ['first', 'second'];
    return fakeFetch(
      {
        'GET /.well-known/oauth-protected-resource/mcp': () => ({ body: doc }),
        'GET /.well-known/openid-configuration': () => ({
          body: {
            device_authorization_endpoint: 'https://issuer.test/oauth/device/code',
            token_endpoint: 'https://issuer.test/oauth/token',
          },
        }),
        'POST /oauth/device/code': () => ({
          body: { device_code: 'dc', user_code: 'ABCD-EFGH', interval: 0, expires_in: 600 },
        }),
        'POST /oauth/token': () => ({
          body: { access_token: tokens.shift(), refresh_token: 'rt', expires_in: 0 },
        }),
        'GET /v1/me': () => ({ body: me }),
      },
      calls,
    );
  }
  const form = (calls: FakeCall[], path: string) =>
    new URLSearchParams(calls.find((call) => call.path === path)?.body as string);
  const stored = (home: string) =>
    Object.values(
      JSON.parse(readFileSync(join(home, '.config/onebrain/credentials.json'), 'utf8')) as Record<
        string,
        Record<string, unknown>
      >,
    )[0];
  const documentFetches = (calls: FakeCall[]) =>
    calls.filter((call) => call.path === '/.well-known/oauth-protected-resource/mcp').length;

  afterEach(() => void vi.unstubAllGlobals());

  it('with only ONEBRAIN_URL set, reads the issuer, client id and audience from the API in one fetch', async () => {
    const calls: FakeCall[] = [];
    vi.stubGlobal('fetch', server(DOC, calls));
    const t = testIo({ env: { ONEBRAIN_URL: 'https://api.test' } });
    expect(await login.run([], t.io)).toBe(0);
    expect(documentFetches(calls)).toBe(1);
    const device = form(calls, '/oauth/device/code');
    expect(device.get('client_id')).toBe('doc-cli');
    expect(device.get('audience')).toBe('https://doc-audience.test');
    expect(stored(t.home)).toMatchObject({
      url: 'https://api.test',
      issuer: 'https://issuer.test/',
      clientId: 'doc-cli',
      audience: 'https://doc-audience.test',
    });
    expect(t.stdout()).toContain('Signed in as Ana (ana@test).');
  });

  it('uses the variables that are set and ignores the document values they cover', async () => {
    const calls: FakeCall[] = [];
    vi.stubGlobal('fetch', server(DOC, calls));
    const env = {
      ONEBRAIN_URL: 'https://api.test',
      ONEBRAIN_CLI_CLIENT_ID: 'env-cli',
      OIDC_AUDIENCE: 'https://env-audience.test',
    };
    const t = testIo({ env });
    expect(await login.run([], t.io)).toBe(0);
    expect(documentFetches(calls)).toBe(1); // the issuer still comes from the document
    const device = form(calls, '/oauth/device/code');
    expect(device.get('client_id')).toBe('env-cli');
    expect(device.get('audience')).toBe('https://env-audience.test');
    expect(stored(t.home)).toMatchObject({
      issuer: 'https://issuer.test/',
      clientId: 'env-cli',
      audience: 'https://env-audience.test',
    });
  });

  it('does not fetch the document when all three variables are set', async () => {
    const calls: FakeCall[] = [];
    const env = {
      OIDC_ISSUER: 'https://env-issuer.test',
      ONEBRAIN_CLI_CLIENT_ID: 'env-cli',
      OIDC_AUDIENCE: 'https://env-audience.test',
    };
    const settings = await signInSettings('https://api.test', env, server(DOC, calls));
    expect(settings).toEqual({
      issuer: 'https://env-issuer.test',
      clientId: 'env-cli',
      audience: 'https://env-audience.test',
    });
    expect(documentFetches(calls)).toBe(0);
  });

  it('leaves the audience null when neither the variable nor the document has one', async () => {
    const { onebrain_audience: _, ...noAudience } = DOC;
    const settings = await signInSettings('https://api.test', {}, server(noAudience));
    expect(settings).toEqual({
      issuer: 'https://issuer.test/',
      clientId: 'doc-cli',
      audience: null,
    });
  });

  it('fails with the new message when no client id is found either way', async () => {
    const { onebrain_cli_client_id: _, ...noClient } = DOC;
    vi.stubGlobal('fetch', server(noClient));
    const t = testIo({ env: { ONEBRAIN_URL: 'https://api.test' } });
    await expect(login.run([], t.io)).rejects.toMatchObject({
      exitCode: 2,
      message:
        'Set ONEBRAIN_CLI_CLIENT_ID to the One Brain CLI client id, or ask the admin of https://api.test to set OIDC_CLI_CLIENT_ID.',
    });
  });

  it('refreshes a login that took its values from the document with an empty environment', async () => {
    const calls: FakeCall[] = [];
    const fetchFn = server(DOC, calls);
    vi.stubGlobal('fetch', fetchFn);
    const t = testIo({ env: { ONEBRAIN_URL: 'https://api.test' } });
    expect(await login.run([], t.io)).toBe(0);
    vi.unstubAllGlobals();

    // The first token expired at once: getClient refreshes it from what login stored.
    calls.length = 0;
    const { api } = await getClient({
      env: {},
      home: t.home,
      fetch: fetchFn,
      needWorkspace: false,
    });
    const refresh = form(calls, '/oauth/token');
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('client_id')).toBe('doc-cli');
    expect(stored(t.home)).toMatchObject({ accessToken: 'second', clientId: 'doc-cli' });
    unwrap(await api.GET('/v1/me'));
    expect(calls.at(-1)?.headers.get('authorization')).toBe('Bearer second');
  });

  it('stores the sign-in under the refresh lock, after the program that holds it lets go', async () => {
    vi.stubGlobal('fetch', server(DOC));
    const t = testIo({ env: { ONEBRAIN_URL: 'https://api.test' } });
    const dir = join(t.home, '.config/onebrain');
    const lock = join(dir, 'refresh.lock');
    // The Mac app is refreshing the older login: what it stores must not land on this sign-in.
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
    const running = login.run([], t.io);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
    rmSync(lock);
    expect(await running).toBe(0);
    expect(stored(t.home)).toMatchObject({ url: 'https://api.test', accessToken: 'first' });
    expect(existsSync(lock)).toBe(false);
  });
});
