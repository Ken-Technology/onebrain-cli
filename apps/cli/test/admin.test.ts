import { describe, expect, it } from 'vitest';
import admin from '../src/commands/admin.ts';
import { fakeApi, testIo } from './helpers.ts';

// Built at run time from two parts: a whole key-shaped literal here would match One Brain's own-key rule.
const NEW_KEY = `${'ob_abc123def456'}${'_0123456789abcdefghijABCDEFGHIJ0123'}`;
const W = '/v1/workspaces/kenso';
const ORG = '0b5e0000-0000-4000-8000-000000000001';
const at = '2026-11-13T00:00:00.000Z';
const me = {
  principal: { id: 'p0', kind: 'user', displayName: 'Admin', email: 'admin@test' },
  actsFor: null,
  currentWorkspace: null,
  workspaces: [],
  organizations: [],
};
const member = (email: string, principalId: string) => ({
  principalId,
  email,
  displayName: email,
  role: 'editor',
});
const group = { id: 'g1', name: 'acme-team', memberCount: 0 };
const agent = {
  id: 'ag1',
  name: 'a-claude',
  ownerKind: 'user',
  owner: { id: 'pa', email: 'a@test' },
};
const folder = {
  id: 'n1',
  kind: 'folder',
  name: 'acme',
  path: 'clients/acme',
  visibility: 'workspace',
  access: 'restricted',
  writePolicy: 'inherit',
  currentVersion: null,
  updatedAt: at,
};

describe('admin workspace', () => {
  it('creates a workspace in the only organization of the caller, or the --org one, and prints its id', async () => {
    const { api, calls } = fakeApi({
      'GET /v1/me': () => ({
        body: { ...me, organizations: [{ id: ORG, name: 'Kenso', role: 'owner' }] },
      }),
      [`POST /v1/organizations/${ORG}/workspaces`]: (call) => ({
        status: 201,
        body: { id: 'w1', organizationId: ORG, ...(call.body as object), captureFolder: null },
      }),
    });
    const t = testIo({ api });
    expect(await admin.run(['workspace', 'create', 'kenso'], t.io)).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/me',
      `POST /v1/organizations/${ORG}/workspaces`,
    ]);
    expect(calls[1]?.body).toEqual({ name: 'kenso', slug: 'kenso' });
    expect(t.stdout()).toBe('w1\n');
    expect(
      await admin.run(
        ['workspace', 'create', 'other', '--org', ORG, '--name', 'Other'],
        testIo({ api }).io,
      ),
    ).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ name: 'Other', slug: 'other' });
    expect(calls.filter((c) => c.path === '/v1/me')).toHaveLength(1);
  });

  it('asks for the organization when it cannot tell', async () => {
    const two = [
      { id: ORG, name: 'Kenso', role: 'owner' },
      { id: 'o2', name: 'Other', role: 'admin' },
    ];
    for (const organizations of [[], two]) {
      const { api } = fakeApi({ 'GET /v1/me': () => ({ body: { ...me, organizations } }) });
      const t = testIo({ api });
      expect(await admin.run(['workspace', 'create', 'kenso'], t.io)).toBe(2);
      expect(t.stderr()).toContain('--org');
    }
  });

  it('lists the workspaces with * before the current one', async () => {
    const { api } = fakeApi({
      'GET /v1/me': () => ({
        body: {
          ...me,
          currentWorkspace: { id: 'w1', slug: 'kenso', name: 'Kenso' },
          workspaces: [
            { id: 'w1', slug: 'kenso', name: 'Kenso', role: 'admin' },
            { id: 'w2', slug: 'other', name: 'Other', role: 'viewer' },
          ],
        },
      }),
    });
    const t = testIo({ api });
    expect(await admin.run(['workspace', 'list'], t.io)).toBe(0);
    expect(t.stdout()).toBe('* kenso  Kenso  admin\n  other  Other  viewer\n');
  });

  it('will not delete a workspace without --yes', async () => {
    const { api, calls } = fakeApi({ 'DELETE /v1/workspaces/other': () => ({ status: 204 }) });
    const t = testIo({ api });
    expect(await admin.run(['workspace', 'delete', 'other'], t.io)).toBe(2);
    expect(calls).toEqual([]);
    expect(t.stderr()).toContain('Run it again with --yes.');
    expect(await admin.run(['workspace', 'delete', 'other', '--yes'], t.io)).toBe(0);
    expect(t.stdout()).toBe('deleted\n');
  });

  it('revokes the key of the slug it is given', async () => {
    const { api, calls } = fakeApi({
      'POST /v1/workspaces/other/key/revoke': () => ({ body: { state: 'revoked' } }),
    });
    const t = testIo({ api });
    expect(await admin.run(['workspace', 'revoke-key', 'other'], t.io)).toBe(2);
    expect(await admin.run(['workspace', 'revoke-key', 'other', '--yes'], t.io)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(t.stdout()).toBe('revoked\n');
  });
});

describe('admin members and groups', () => {
  it('adds a member with a role and prints the id', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/members`]: () => ({ status: 201, body: member('a@test', 'pa') }),
    });
    const t = testIo({ api });
    expect(await admin.run(['members', 'add', 'a@test', '--role', 'editor'], t.io)).toBe(0);
    expect(calls[0]?.body).toEqual({ email: 'a@test', role: 'editor' });
    expect(t.stdout()).toBe('pa\n');
    expect(await admin.run(['members', 'add', 'a@test', '--role', 'boss'], t.io)).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it('passes on the 403 an agent key gets on an admin route', async () => {
    const { api } = fakeApi({
      [`POST ${W}/members`]: () => ({
        status: 403,
        body: { error: { code: 'forbidden', message: 'Only a person can do this, not an agent' } },
      }),
    });
    await expect(
      admin.run(['members', 'add', 'a@test', '--role', 'editor'], testIo({ api }).io),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('lists members as columns or JSON', async () => {
    const { api } = fakeApi({
      [`GET ${W}/members`]: () => ({
        body: { data: [member('a@test', 'pa'), member('bb@test', 'pb')] },
      }),
    });
    const t = testIo({ api });
    expect(await admin.run(['members', 'list'], t.io)).toBe(0);
    expect(t.stdout()).toBe('pa  a@test   a@test   editor\npb  bb@test  bb@test  editor\n');
    const j = testIo({ api });
    expect(await admin.run(['members', 'list', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.stdout()).data).toHaveLength(2);
  });

  it('creates a group and adds a member to it by the group name', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/groups`]: () => ({ status: 201, body: group }),
      [`GET ${W}/groups`]: () => ({ body: { data: [group] } }),
      [`POST ${W}/groups/g1/members`]: () => ({ status: 201, body: member('a@test', 'pa') }),
    });
    const t = testIo({ api });
    expect(await admin.run(['groups', 'create', 'acme-team'], t.io)).toBe(0);
    expect(await admin.run(['groups', 'add', 'acme-team', 'a@test'], t.io)).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ email: 'a@test' });
    expect(t.stdout()).toBe('g1\npa\n');
  });

  it('removes a member by email', async () => {
    const { api, calls } = fakeApi({
      [`GET ${W}/members`]: () => ({ body: { data: [member('a@test', 'pa')] } }),
      [`DELETE ${W}/members/pa`]: () => ({ status: 204 }),
    });
    expect(await admin.run(['members', 'remove', 'a@test'], testIo({ api }).io)).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${W}/members`,
      `DELETE ${W}/members/pa`,
    ]);
  });

  it('removes a group member by email from that group', async () => {
    const { api, calls } = fakeApi({
      [`GET ${W}/groups`]: () => ({ body: { data: [group] } }),
      [`GET ${W}/groups/g1/members`]: () => ({ body: { data: [member('a@test', 'pa')] } }),
      [`DELETE ${W}/groups/g1/members/pa`]: () => ({ status: 204 }),
    });
    const t = testIo({ api });
    expect(await admin.run(['groups', 'remove', 'acme-team', 'a@test'], t.io)).toBe(0);
    expect(calls.at(-1)?.path).toBe(`${W}/groups/g1/members/pa`);
    expect(t.stdout()).toBe('removed\n');
  });

  it('says which group is missing', async () => {
    const { api } = fakeApi({ [`GET ${W}/groups`]: () => ({ body: { data: [] } }) });
    await expect(
      admin.run(['groups', 'add', 'nope', 'a@test'], testIo({ api }).io),
    ).rejects.toThrow('No group named nope.');
  });

  it('prints usage and exits 2 for an unknown area or action', async () => {
    const t = testIo();
    expect(await admin.run([], t.io)).toBe(2);
    expect(await admin.run(['nope'], t.io)).toBe(2);
    expect(await admin.run(['groups', 'nope'], t.io)).toBe(2);
    expect(await admin.run(['groups', 'create'], t.io)).toBe(2);
    expect(t.stderr()).toContain('Usage');
    expect(await admin.run(['loop', 'nope'], t.io)).toBe(2);
    expect(t.stderr()).toContain(
      'Areas: workspace, members, groups, agents, keys, folders, grants, access, loop.',
    );
  });
});

describe('admin agents and keys', () => {
  it('creates an agent owned by the caller, with the email from /v1/me', async () => {
    const { api, calls } = fakeApi({
      'GET /v1/me': () => ({ body: me }),
      [`POST ${W}/agents`]: () => ({ status: 201, body: agent }),
    });
    const t = testIo({ api });
    expect(await admin.run(['agents', 'create', 'a-claude'], t.io)).toBe(0);
    expect(calls[1]?.body).toEqual({ name: 'a-claude', owner: 'admin@test' });
    expect(t.stdout()).toBe('ag1\n');
  });

  it('creates a workspace agent with --workspace-agent: no owner, no /v1/me call', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/agents`]: () => ({ status: 201, body: { ...agent, ownerKind: 'workspace' } }),
    });
    const t = testIo({ api });
    expect(await admin.run(['agents', 'create', 'ci-bot', '--workspace-agent'], t.io)).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${W}/agents`]);
    expect(calls[0]?.body).toEqual({ name: 'ci-bot' });
  });

  it('refuses --owner: a person creates their own agents, and nothing is sent', async () => {
    const { api, calls } = fakeApi({});
    const t = testIo({ api });
    expect(await admin.run(['agents', 'create', 'a-claude', '--owner', 'a@test'], t.io)).toBe(2);
    expect(t.stderr()).toContain('A person creates their own agents');
    expect(calls).toEqual([]);
  });

  it('says only the owner can create keys when the API answers 403', async () => {
    const { api } = fakeApi({
      [`GET ${W}/agents`]: () => ({ body: { data: [agent] } }),
      [`POST ${W}/agents/ag1/keys`]: () => ({
        status: 403,
        body: { error: { code: 'forbidden', message: 'Not allowed' } },
      }),
    });
    const t = testIo({ api });
    await expect(admin.run(['keys', 'create', 'a-claude'], t.io)).rejects.toMatchObject({
      status: 403,
    });
    expect(t.stderr()).toContain("Only the agent's owner can create its keys.");
  });

  it('describes agents and keys as yours to manage, not admin only', async () => {
    expect(admin.describe).toContain('you create your own agents');
    expect(admin.describe).not.toMatch(/admins? only/i);
    const t = testIo();
    await admin.run(['keys'], t.io);
    expect(t.stderr()).toContain("Only the agent's owner can create its keys.");
  });

  it('deletes an agent by name', async () => {
    const { api } = fakeApi({
      [`GET ${W}/agents`]: () => ({ body: { data: [agent] } }),
      [`DELETE ${W}/agents/ag1`]: () => ({ status: 204 }),
    });
    const t = testIo({ api });
    expect(await admin.run(['agents', 'delete', 'a-claude'], t.io)).toBe(0);
    expect(t.stdout()).toBe('deleted\n');
  });

  it('mints a key, prints it once and passes the scopes', async () => {
    const key = {
      id: 'k1',
      keyId: 'abc123def456',
      scopes: ['read', 'remember'],
      pathPrefix: null,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: at,
    };
    const { api, calls } = fakeApi({
      [`GET ${W}/agents`]: () => ({ body: { data: [agent] } }),
      [`POST ${W}/agents/ag1/keys`]: () => ({
        status: 201,
        body: { ...key, key: NEW_KEY },
      }),
    });
    const t = testIo({ api });
    expect(
      await admin.run(
        ['keys', 'create', 'a-claude', '--scope', 'read', '--scope', 'remember'],
        t.io,
      ),
    ).toBe(0);
    expect(calls[1]?.body).toEqual({ scopes: ['read', 'remember'] });
    expect(t.stdout()).toBe(`${NEW_KEY}\n`);
    expect(t.stderr()).toContain('Key id abc123def456.');
    expect(t.stderr()).toContain('not shown again');
    expect(await admin.run(['keys', 'create', 'a-claude', '--scope', 'root'], t.io)).toBe(2);
  });

  it('sends --expires as a UTC timestamp and revokes by the public key id', async () => {
    const key = {
      id: 'k1',
      keyId: 'abc123def456',
      scopes: ['read'],
      pathPrefix: null,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: at,
    };
    const { api, calls } = fakeApi({
      [`GET ${W}/agents`]: () => ({ body: { data: [agent] } }),
      [`POST ${W}/agents/ag1/keys`]: () => ({
        status: 201,
        body: { ...key, key: NEW_KEY },
      }),
      [`GET ${W}/agents/ag1/keys`]: () => ({ body: { data: [key] } }),
      [`DELETE ${W}/agents/ag1/keys/abc123def456`]: () => ({ status: 204 }),
    });
    const t = testIo({ api });
    expect(await admin.run(['keys', 'create', 'a-claude', '--expires', '2027-01-01'], t.io)).toBe(
      0,
    );
    expect(calls[1]?.body).toEqual({ expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(await admin.run(['keys', 'create', 'a-claude', '--expires', 'soon'], t.io)).toBe(2);
    expect(await admin.run(['keys', 'revoke', 'a-claude', 'k1'], t.io)).toBe(0);
    expect(calls.at(-1)?.path).toBe(`${W}/agents/ag1/keys/abc123def456`);
    expect(t.stdout()).toContain('revoked\n');
  });

  it('lists the keys of an agent', async () => {
    const key = {
      id: 'k1',
      keyId: 'abc123def456',
      scopes: ['read', 'write'],
      pathPrefix: 'clients',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: at,
    };
    const { api } = fakeApi({
      [`GET ${W}/agents`]: () => ({ body: { data: [agent] } }),
      [`GET ${W}/agents/ag1/keys`]: () => ({ body: { data: [key] } }),
    });
    const t = testIo({ api });
    expect(await admin.run(['keys', 'list', 'a-claude'], t.io)).toBe(0);
    expect(t.stdout()).toBe('abc123def456  read,write  clients  -  -  -  -\n');
  });

  it('shows a paused key in the list and resumes it by its public key id', async () => {
    const key = {
      id: 'k1',
      keyId: 'abc123def456',
      scopes: ['read', 'write'],
      pathPrefix: null,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: at,
      pausedAt: at,
      pauseReason: 'large_deletions',
    };
    const { api, calls } = fakeApi({
      [`GET ${W}/agents`]: () => ({ body: { data: [agent] } }),
      [`GET ${W}/agents/ag1/keys`]: () => ({ body: { data: [key] } }),
      [`POST ${W}/agents/ag1/keys/abc123def456/resume`]: () => ({
        body: { ...key, pausedAt: null, pauseReason: null },
      }),
    });
    const t = testIo({ api });
    expect(await admin.run(['keys', 'list', 'a-claude'], t.io)).toBe(0);
    expect(t.stdout()).toBe(`abc123def456  read,write  -  -  -  -  ${at}\n`);
    expect(await admin.run(['keys', 'resume', 'a-claude', 'k1'], t.io)).toBe(0);
    expect(calls.at(-1)?.method).toBe('POST');
    expect(calls.at(-1)?.path).toBe(`${W}/agents/ag1/keys/abc123def456/resume`);
    expect(t.stdout()).toContain('resumed\n');
    await expect(admin.run(['keys', 'resume', 'a-claude', 'nope'], t.io)).rejects.toThrow(
      'No key nope.',
    );
    expect(await admin.run(['keys', 'resume', 'a-claude'], t.io)).toBe(2);
  });
});

describe('admin folders and grants', () => {
  it('creates a restricted folder', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/folders`]: () => ({ status: 201, body: folder }),
    });
    const t = testIo({ api });
    expect(
      await admin.run(['folders', 'create', 'clients/acme', '--access', 'restricted'], t.io),
    ).toBe(0);
    expect(calls[0]?.body).toEqual({ path: 'clients/acme', access: 'restricted' });
    expect(t.stdout()).toBe('n1\n');
    expect(await admin.run(['folders', 'create', 'me/x', '--private'], t.io)).toBe(0);
    expect(calls[1]?.body).toEqual({ path: 'me/x', visibility: 'private' });
  });

  it('updates a folder', async () => {
    const { api, calls } = fakeApi({ [`PATCH ${W}/folders`]: () => ({ body: folder }) });
    const t = testIo({ api });
    expect(
      await admin.run(['folders', 'update', 'clients/acme', '--write-policy', 'direct'], t.io),
    ).toBe(0);
    expect(calls[0]?.body).toEqual({ path: 'clients/acme', writePolicy: 'direct' });
    expect(t.stdout()).toBe('updated clients/acme\n');
    expect(await admin.run(['folders', 'update', 'clients/acme', '--access', 'shut'], t.io)).toBe(
      2,
    );
  });

  it('grants a group edit on a folder', async () => {
    const grant = {
      id: 'gr1',
      path: 'clients/acme',
      granteeKind: 'group',
      grantee: { id: 'g1', name: 'acme-team' },
      role: 'edit',
      inheritedFrom: null,
    };
    const { api, calls } = fakeApi({ [`PUT ${W}/grants`]: () => ({ body: grant }) });
    const t = testIo({ api });
    expect(
      await admin.run(
        ['grants', 'put', 'clients/acme', '--group', 'acme-team', '--role', 'edit'],
        t.io,
      ),
    ).toBe(0);
    expect(calls[0]?.body).toEqual({ path: 'clients/acme', group: 'acme-team', role: 'edit' });
    expect(t.stdout()).toBe('gr1\n');
  });

  it('lists and deletes grants', async () => {
    const grant = {
      id: 'gr1',
      path: 'clients/acme',
      granteeKind: 'group',
      grantee: { id: 'g1', name: 'acme-team' },
      role: 'edit',
      inheritedFrom: null,
    };
    const { api, calls } = fakeApi({
      [`GET ${W}/grants`]: () => ({ body: { data: [grant] } }),
      [`DELETE ${W}/grants`]: () => ({ status: 204 }),
    });
    const t = testIo({ api });
    expect(await admin.run(['grants', 'list', 'clients/acme'], t.io)).toBe(0);
    expect(calls[0]?.query.get('path')).toBe('clients/acme');
    expect(t.stdout()).toBe('gr1  group  acme-team  edit  -\n');
    expect(
      await admin.run(['grants', 'delete', 'clients/acme', '--group', 'acme-team'], t.io),
    ).toBe(0);
    expect(calls[1]?.query.get('group')).toBe('acme-team');
    expect(calls[1]?.query.has('principal')).toBe(false);
    expect(t.stdout()).toContain('deleted\n');
  });

  it('passes on agent_is_owned', async () => {
    const { api } = fakeApi({
      [`PUT ${W}/grants`]: () => ({
        status: 400,
        body: { error: { code: 'agent_is_owned', message: 'b-claude acts for b@test' } },
      }),
    });
    await expect(
      admin.run(
        ['grants', 'put', 'clients/acme', '--principal', 'b-claude', '--role', 'view'],
        testIo({ api }).io,
      ),
    ).rejects.toMatchObject({ code: 'agent_is_owned' });
  });

  it('needs exactly one grantee', async () => {
    const t = testIo();
    expect(await admin.run(['grants', 'put', 'clients/acme', '--role', 'view'], t.io)).toBe(2);
    expect(
      await admin.run(
        ['grants', 'put', 'clients/acme', '--group', 'g', '--principal', 'p', '--role', 'view'],
        t.io,
      ),
    ).toBe(2);
    expect(await admin.run(['grants', 'delete', 'clients/acme'], t.io)).toBe(2);
  });
});
