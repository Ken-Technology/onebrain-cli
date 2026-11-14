import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, getClient, unwrap } from '../src/client.ts';
import { writeConfig } from '../src/config.ts';
import { type FakeCall, fakeFetch } from './helpers.ts';

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
