import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import capture from '../src/commands/capture.ts';
import read from '../src/commands/read.ts';
import remember from '../src/commands/remember.ts';
import search from '../src/commands/search.ts';
import write from '../src/commands/write.ts';
import { fakeApi, testIo } from './helpers.ts';

const W = '/v1/workspaces/kenso';
const ID = '3f1c2a9e-0000-4000-8000-000000000001';
const ref = { id: 'p1', displayName: 'a-claude' };
const at = '2026-11-13T00:00:00.000Z';
const memory = (text: string) => ({
  id: ID,
  text,
  folder: 'clients/acme',
  visibility: 'workspace',
  status: 'unreviewed',
  validFrom: at,
  validTo: null,
  supersedesId: null,
  source: { kind: 'agent_save', ref: null },
  author: ref,
  onBehalfOf: null,
  createdAt: at,
});
const file = (version: number, body: string) => ({
  id: 'n1',
  path: 'clients/acme/overview.md',
  version,
  body,
  visibility: 'workspace',
  changeKind: 'create',
  author: ref,
  onBehalfOf: null,
  updatedAt: at,
});
const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
const temp = (name: string, body: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'onebrain-content-')), name);
  writeFileSync(path, body);
  return path;
};

describe('remember', () => {
  it('prints the memory id and its status', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/memories`]: () => ({
        status: 201,
        body: memory('Acme moved its renewal to April'),
      }),
    });
    const t = testIo({ api });
    expect(
      await remember.run(['Acme moved its renewal to April', '--folder', 'clients/acme'], t.io),
    ).toBe(0);
    expect(calls[0]?.body).toEqual({
      text: 'Acme moved its renewal to April',
      folder: 'clients/acme',
    });
    expect(t.stdout()).toBe(`${ID}\nstatus: unreviewed\n`);
  });

  it('says so when the memory already existed, and reads stdin for -', async () => {
    const { api, calls } = fakeApi({ [`POST ${W}/memories`]: () => ({ body: memory('x') }) });
    const t = testIo({ api, stdin: 'from stdin' });
    expect(await remember.run(['-'], t.io)).toBe(0);
    expect(calls[0]?.body).toEqual({ text: 'from stdin' });
    expect(t.stderr()).toContain('Already saved.');
  });

  it('saves a private memory with no folder or under me/, and refuses --private with a shared folder', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/memories`]: () => ({
        status: 201,
        body: { ...memory('mine'), folder: null, visibility: 'private' },
      }),
    });
    expect(await remember.run(['mine', '--private'], testIo({ api }).io)).toBe(0);
    expect(
      await remember.run(['mine', '--private', '--folder', 'me/notes'], testIo({ api }).io),
    ).toBe(0);
    expect(calls.map((c) => c.body)).toEqual([
      { text: 'mine', visibility: 'private' },
      { text: 'mine', folder: 'me/notes', visibility: 'private' },
    ]);
    const refused = testIo({ api });
    expect(await remember.run(['mine', '--private', '--folder', 'clients/acme'], refused.io)).toBe(
      2,
    );
    expect(refused.stderr()).toContain('clients/acme is shared');
    expect(calls).toHaveLength(2);
  });

  it('treats a padded me folder as private', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/memories`]: () => ({ status: 201, body: memory('mine') }),
    });
    expect(
      await remember.run(['mine', '--private', '--folder', ' /me/ '], testIo({ api }).io),
    ).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('refuses empty text', async () => {
    expect(await remember.run([], testIo({ stdin: null }).io)).toBe(2);
  });
});

describe('search', () => {
  it('sends the query and prints each result by path or id', async () => {
    const data = [
      {
        id: 'n1',
        kind: 'file',
        path: 'clients/acme/overview.md',
        snippet: 'Renewal is in March',
        status: 'accepted',
        source: null,
        score: 0.0331,
      },
      {
        id: ID,
        kind: 'memory',
        path: null,
        snippet: 'Acme moved its renewal to April',
        status: 'unreviewed',
        source: { kind: 'agent_save', ref: null },
        score: 0.0164,
      },
    ];
    const { api, calls } = fakeApi({
      [`POST ${W}/search`]: () => ({ body: { data, vector: false, workspace: 'kenso' } }),
    });
    const t = testIo({ api });
    expect(await search.run(['acme', 'renewal', '--kind', 'memory', '--limit', '5'], t.io)).toBe(0);
    expect(calls[0]?.body).toEqual({ query: 'acme renewal', kinds: ['memory'], limit: 5 });
    expect(t.stdout()).toContain(
      'file  clients/acme/overview.md  accepted  0.033\n  Renewal is in March\n',
    );
    expect(t.stdout()).toContain(`memory  ${ID}  unreviewed`);
    expect(t.stderr()).toContain('Full-text only');
  });

  it('prints nothing on stdout when nothing matches', async () => {
    const { api } = fakeApi({
      [`POST ${W}/search`]: () => ({ body: { data: [], vector: true, workspace: 'kenso' } }),
    });
    const t = testIo({ api });
    expect(await search.run(['acme'], t.io)).toBe(0);
    expect(t.stdout()).toBe('');
    expect(t.stderr()).toContain('No results.');
  });

  it('refuses an empty query', async () => {
    expect(await search.run([], testIo().io)).toBe(2);
  });
});

describe('read', () => {
  it('reads a memory by id', async () => {
    const { api } = fakeApi({
      [`GET ${W}/memories/${ID}`]: () => ({ body: memory('Deploy key is [redacted:secret]') }),
    });
    const t = testIo({ api });
    expect(await read.run([ID], t.io)).toBe(0);
    expect(t.stdout()).toBe('Deploy key is [redacted:secret]\n');
    expect(t.stderr()).toContain('status: unreviewed');
  });

  it('reads a file by path, and a skill folder when no file has that path', async () => {
    const { api, calls } = fakeApi({
      [`GET ${W}/files`]: (call) =>
        call.query.get('path') === 'clients/acme/overview.md'
          ? { body: file(1, '# Acme') }
          : notFound,
      [`GET ${W}/skills/reply-pricing`]: () => ({
        body: {
          name: 'reply-pricing',
          path: 'clients/acme/skills/reply-pricing',
          description: 'd',
          version: 1,
          updatedAt: at,
          files: [{ path: 'SKILL.md', body: '---\nname: reply-pricing\n---' }],
        },
      }),
    });
    const t = testIo({ api });
    expect(await read.run(['clients/acme/overview.md'], t.io)).toBe(0);
    expect(t.stdout()).toBe('# Acme\n');
    expect(t.stderr()).toContain('clients/acme/overview.md version 1 (create by a-claude)');
    expect(await read.run(['clients/acme/skills/reply-pricing'], t.io)).toBe(0);
    expect(t.stdout()).toContain('==> SKILL.md <==\n---\nname: reply-pricing');
    expect(calls.map((c) => c.path)).toContain(`${W}/skills/reply-pricing`);
  });

  it('reports the first error when the skill is missing too, and never tries a skill under me/', async () => {
    const { api, calls } = fakeApi({
      [`GET ${W}/files`]: () => notFound,
      [`GET ${W}/skills/nothing`]: () => notFound,
    });
    await expect(read.run(['a/nothing'], testIo({ api }).io)).rejects.toMatchObject({
      code: 'not_found',
    });
    const before = calls.length;
    await expect(read.run(['me/nothing'], testIo({ api }).io)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(calls.length - before).toBe(1);
  });
});

describe('write', () => {
  it('writes on top of the current version and reports a pending improvement', async () => {
    const body = '# Acme\nRenewal is in April. Pricing tier: Growth.';
    const { api, calls } = fakeApi({
      [`GET ${W}/files`]: () => ({
        body: file(1, '# Acme\nRenewal is in March. Pricing tier: Growth.'),
      }),
      [`PUT ${W}/files`]: () => ({
        status: 202,
        body: { improvement: { id: 'i1', path: 'clients/acme/overview.md', status: 'pending' } },
      }),
    });
    const t = testIo({ api });
    expect(
      await write.run(['clients/acme/overview.md', '--file', temp('new.md', body)], t.io),
    ).toBe(0);
    expect(calls[1]?.body).toEqual({ path: 'clients/acme/overview.md', body, baseVersion: 1 });
    expect(t.stdout()).toBe('pending improvement i1\n');
  });

  it('creates a missing file from stdin with base version 0', async () => {
    const { api, calls } = fakeApi({
      [`GET ${W}/files`]: () => notFound,
      [`PUT ${W}/files`]: () => ({ body: { ...file(1, 'hello'), path: 'notes/new.md' } }),
    });
    const t = testIo({ api, stdin: 'hello' });
    expect(await write.run(['notes/new.md'], t.io)).toBe(0);
    expect(calls[1]?.body).toMatchObject({ baseVersion: 0, body: 'hello' });
    expect(t.stdout()).toBe('notes/new.md version 1\n');
  });

  it('explains a stale base version', async () => {
    const { api } = fakeApi({
      [`PUT ${W}/files`]: () => ({
        status: 409,
        body: { error: { code: 'conflict', message: 'Stale', currentVersion: 3 } },
      }),
    });
    const t = testIo({ api, stdin: 'x' });
    expect(await write.run(['notes/new.md', '--base', '1'], t.io)).toBe(1);
    expect(t.stderr()).toContain(
      'notes/new.md changed: it is at version 3. Read it again and retry.',
    );
  });

  it('writes a private file under me/ with --private', async () => {
    const { api, calls } = fakeApi({
      [`GET ${W}/files`]: () => notFound,
      [`PUT ${W}/files`]: () => ({
        body: { ...file(1, 'mine'), path: 'me/notes.md', visibility: 'private' },
      }),
    });
    const t = testIo({ api, stdin: 'mine' });
    expect(await write.run(['me/notes.md', '--private'], t.io)).toBe(0);
    expect(calls[1]?.body).toEqual({
      path: 'me/notes.md',
      body: 'mine',
      baseVersion: 0,
      visibility: 'private',
    });
    expect(t.stdout()).toBe('me/notes.md version 1\n');
  });

  it('refuses to run with no body', async () => {
    expect(await write.run(['notes/new.md'], testIo({ stdin: null }).io)).toBe(2);
  });
});

describe('capture', () => {
  it('uploads the transcript as a session', async () => {
    const transcript = temp('session.jsonl', '{"type":"user"}\n');
    const { api, calls } = fakeApi({
      [`POST ${W}/sources`]: () => ({
        status: 201,
        body: {
          id: 's1',
          kind: 'session',
          folder: 'sessions',
          visibility: 'workspace',
          contentHash: 'h',
          duplicate: false,
          createdAt: at,
        },
      }),
    });
    const t = testIo({ api });
    expect(
      await capture.run([transcript, '--folder', 'sessions', '--ref', 'claude-code:abc'], t.io),
    ).toBe(0);
    const form = calls[0]?.form;
    expect(form?.get('kind')).toBe('session');
    expect(form?.get('folder')).toBe('sessions');
    expect(form?.get('externalRef')).toBe('claude-code:abc');
    expect(typeof form?.get('occurredAt')).toBe('string');
    const content = form?.get('content') as Blob;
    expect(await content.text()).toBe('{"type":"user"}\n');
    expect(t.stdout()).toBe('s1\n');
  });

  it('sends visibility private with --private, and refuses it together with --folder', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/sources`]: () => ({ status: 201, body: { id: 's2', duplicate: false } }),
    });
    const t = testIo({ api, stdin: 'transcript text' });
    expect(await capture.run(['-', '--private', '--ref', 'codex:abc'], t.io)).toBe(0);
    expect(calls[0]?.form?.get('visibility')).toBe('private');
    expect(calls[0]?.form?.get('folder')).toBeNull();
    expect(await capture.run(['-', '--private', '--folder', 'sessions'], t.io)).toBe(2);
    expect(calls).toHaveLength(1);
    expect(t.stderr()).toContain('--folder <path> | --private');
  });

  it('says so when the session was captured before', async () => {
    const { api } = fakeApi({
      [`POST ${W}/sources`]: () => ({ body: { id: 's1', duplicate: true } }),
    });
    const t = testIo({ api, stdin: 'transcript text' });
    expect(await capture.run(['-'], t.io)).toBe(0);
    expect(t.stderr()).toContain('Already captured.');
  });
});
