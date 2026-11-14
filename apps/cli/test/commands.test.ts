import { describe, expect, it } from 'vitest';
import { CliError } from '../src/client.ts';
import { deviceLogin } from '../src/commands/login.ts';
import whoami from '../src/commands/whoami.ts';
import workspace from '../src/commands/workspace.ts';
import { readConfig } from '../src/config.ts';
import { loadCommands } from '../src/index.ts';
import { type FakeRoutes, fakeApi, fakeFetch, testIo } from './helpers.ts';

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
