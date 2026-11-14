import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import importCommand from '../src/commands/import.ts';
import { toOneBrainPath } from '../src/import/paths.ts';
import { fakeApi, testIo } from './helpers.ts';

const W = '/v1/workspaces/kenso';
const at = '2026-11-13T00:00:00.000Z';
const fixtures = fileURLToPath(new URL('./fixtures/ken-brain/', import.meta.url));
const person = {
  principal: { id: 'p0', kind: 'user', displayName: 'Admin', email: 'admin@test' },
  actsFor: null,
  currentWorkspace: null,
  workspaces: [],
  organizations: [],
};
const ownedAgent = {
  ...person,
  principal: { id: 'p9', kind: 'agent', displayName: 'a-claude', email: null },
  actsFor: { id: 'pa', displayName: 'A', email: 'a@test' },
};
const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };

/** A fake API that remembers what was written, so a second run sees the first one's work. */
function brain(me: object = person, access = 'restricted', existing: string[] = []) {
  const folders = new Set<string>(existing);
  const files = new Set<string>();
  const memories = new Set<string>();
  return fakeApi({
    'GET /v1/me': () => ({ body: me }),
    [`GET ${W}/tree`]: (call) => {
      const path = call.query.get('path') ?? '';
      return folders.has(path)
        ? {
            body: {
              node: {
                id: 'f1',
                kind: 'folder',
                name: path,
                path,
                visibility: 'workspace',
                access,
                writePolicy: 'inherit',
                currentVersion: null,
                updatedAt: at,
              },
              children: [],
            },
          }
        : notFound;
    },
    [`POST ${W}/folders`]: (call) => {
      const { path } = call.body as { path: string };
      folders.add(path);
      return {
        status: 201,
        body: {
          id: 'f1',
          kind: 'folder',
          name: path,
          path,
          visibility: 'workspace',
          access: 'restricted',
          writePolicy: 'inherit',
          currentVersion: null,
          updatedAt: at,
        },
      };
    },
    [`PUT ${W}/grants`]: () => ({
      body: {
        id: 'gr1',
        path: 'ken-brain',
        granteeKind: 'principal',
        grantee: { id: 'p0', name: 'admin@test' },
        role: 'manage',
        inheritedFrom: null,
      },
    }),
    [`PUT ${W}/files`]: (call) => {
      const { path, body } = call.body as { path: string; body: string };
      if (files.has(path)) {
        return {
          status: 409,
          body: { error: { code: 'conflict', message: 'Stale', currentVersion: 1 } },
        };
      }
      files.add(path);
      return {
        body: {
          id: path,
          path,
          version: 1,
          body,
          visibility: 'workspace',
          changeKind: 'create',
          author: { id: 'p0', displayName: 'Admin' },
          onBehalfOf: null,
          updatedAt: at,
        },
      };
    },
    [`POST ${W}/memories`]: (call) => {
      const { text, folder, source } = call.body as {
        text: string;
        folder: string;
        source: { kind: string; ref: string };
      };
      const existed = memories.has(source.ref);
      memories.add(source.ref);
      return {
        status: existed ? 200 : 201,
        body: {
          id: source.ref,
          text,
          folder,
          visibility: 'workspace',
          status: 'unreviewed',
          validFrom: at,
          validTo: null,
          supersedesId: null,
          source,
          author: { id: 'p0', displayName: 'Admin' },
          onBehalfOf: null,
          createdAt: at,
        },
      };
    },
  });
}

/** ken-brain arguments on a copy of the memories file, so its progress file lands in a temp folder. */
function kenBrainArgs(): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
  copyFileSync(join(fixtures, 'memories.jsonl'), join(dir, 'memories.jsonl'));
  return ['ken-brain', join(fixtures, 'repo'), join(dir, 'memories.jsonl'), '--into', 'ken-brain'];
}

describe('toOneBrainPath', () => {
  it('keeps names and case as written, and refuses a name the API would refuse', () => {
    expect(toOneBrainPath('runbooks/alerts/README.md')).toBe('runbooks/alerts/README.md');
    expect(toOneBrainPath('skills/reply-pricing/scripts/fill_form.py')).toBe(
      'skills/reply-pricing/scripts/fill_form.py',
    );
    expect(toOneBrainPath('Client Notes/file.md')).toBeNull();
    expect(toOneBrainPath('notes/(draft).md')).toBeNull();
  });
});

describe('import ken-brain', () => {
  it('creates a restricted folder for the importer, 3 files and 5 imported memories, then nothing on a second run', async () => {
    const { api, calls } = brain();
    const kenBrain = kenBrainArgs();
    const first = testIo({ api });
    expect(await importCommand.run(kenBrain, first.io)).toBe(0);
    expect(calls.find((c) => c.method === 'POST' && c.path === `${W}/folders`)?.body).toEqual({
      path: 'ken-brain',
      access: 'restricted',
    });
    expect(calls.find((c) => c.path === `${W}/grants`)?.body).toEqual({
      path: 'ken-brain',
      principal: 'admin@test',
      role: 'manage',
    });
    const puts = calls.filter((c) => c.path === `${W}/files`);
    expect(puts.map((c) => (c.body as { path: string }).path)).toEqual([
      'ken-brain/articles/cold-email-basics.md',
      'ken-brain/clients/acme.md',
      'ken-brain/runbooks/alerts/README.md',
    ]);
    expect(puts[0]?.body).toEqual({
      path: 'ken-brain/articles/cold-email-basics.md',
      body: '# Cold email basics\nKeep the first line under 12 words.\n',
      baseVersion: 0,
      changeKind: 'import',
    });
    const saved = calls
      .filter((c) => c.path === `${W}/memories`)
      .map((c) => c.body as Record<string, unknown>);
    expect(saved).toHaveLength(5);
    expect(saved[0]).toEqual({
      text: 'Acme prefers Tuesday sends.',
      folder: 'ken-brain',
      source: { kind: 'import', ref: '6f0c1a2e-0000-4000-8000-000000000001' },
      validFrom: '2026-09-01T10:00:00.000Z',
    });
    expect(saved[1]?.validFrom).toBe('2026-09-02T10:00:00.000Z'); // the -07:00 offset, moved to UTC
    expect(saved[3]).not.toHaveProperty('validFrom');
    expect(first.stdout()).toContain('files: 3 created, 0 proposed, 0 already there');
    expect(first.stdout()).toContain('memories: 5 created, 0 already there, 0 failed');

    const before = calls.length;
    const second = testIo({ api });
    expect(await importCommand.run(kenBrain, second.io)).toBe(0);
    const again = calls.slice(before);
    expect(again.some((c) => c.path === `${W}/folders` || c.path === `${W}/grants`)).toBe(false);
    expect(second.stdout()).toContain('files: 0 created, 0 proposed, 3 already there');
    expect(again.some((c) => c.path === `${W}/memories`)).toBe(false); // the progress file skips all 5
    expect(second.stdout()).toContain(
      'memories: 0 created, 0 already there, 0 failed, 5 done in an earlier run',
    );
    expect(second.stderr()).toContain('Skipping 5 memories done in an earlier run (');
    expect(second.stderr()).toContain('Pass --restart to import them again.');
    const progress = readFileSync(`${kenBrain[2]}.onebrain-progress`, 'utf8');
    expect(progress.split('\n')[0]).toBe('# http://localhost:8787 kenso ken-brain');
  });

  it('leaves creating the folder to a person when an agent key imports', async () => {
    const { api, calls } = brain(ownedAgent);
    await expect(importCommand.run(kenBrainArgs(), testIo({ api }).io)).rejects.toThrow(
      'onebrain admin folders create ken-brain',
    );
    expect(
      calls.some((c) =>
        [`${W}/folders`, `${W}/grants`, `${W}/files`, `${W}/memories`].includes(c.path),
      ),
    ).toBe(false);
  });

  it('reports a bad memories line by number and exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
    writeFileSync(join(dir, 'memories.jsonl'), '{"id":"m1","text":"ok"}\nnot json\n{"id":"m3"}\n');
    const t = testIo({ api: brain().api });
    expect(
      await importCommand.run(
        ['ken-brain', join(fixtures, 'repo'), join(dir, 'memories.jsonl'), '--into', 'ken-brain'],
        t.io,
      ),
    ).toBe(1);
    expect(t.stderr()).toContain('line 2');
    expect(t.stderr()).toContain('line 3');
    expect(t.stdout()).toContain('memories: 1 created, 0 already there, 2 failed');
  });
});

describe('import <path>', () => {
  it('imports the text files of a folder under the names they have', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
    mkdirSync(join(dir, 'Sub_Folder'));
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'Guide.md'), '# Guide');
    writeFileSync(join(dir, 'Sub_Folder/Notes.txt'), 'notes');
    writeFileSync(join(dir, 'My Notes.md'), 'a space in the name');
    writeFileSync(join(dir, '.git/config.md'), 'no');
    writeFileSync(join(dir, 'logo.png'), 'png');
    const { api, calls } = brain();
    const t = testIo({ api });
    expect(await importCommand.run([dir, '--into', 'Docs'], t.io)).toBe(0);
    const written = calls
      .filter((c) => c.path === `${W}/files`)
      .map((c) => (c.body as { path: string }).path);
    expect(written).toEqual(['Docs/Guide.md', 'Docs/Sub_Folder/Notes.txt']);
    expect(t.stdout()).toContain(
      'files: 2 created, 0 proposed, 0 already there, 2 skipped, 0 failed',
    );
    expect(t.stderr()).toContain('skipped My Notes.md: not a valid One Brain name');
  });

  it('uses an existing folder as it is', async () => {
    const { api, calls } = brain();
    await importCommand.run(kenBrainArgs(), testIo({ api }).io);
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
    writeFileSync(join(dir, 'extra.md'), 'x');
    const before = calls.length;
    expect(
      await importCommand.run([join(dir, 'extra.md'), '--into', 'ken-brain'], testIo({ api }).io),
    ).toBe(0);
    expect(calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${W}/tree`,
      `PUT ${W}/files`,
    ]);
  });

  it('refuses an existing open folder before uploading anything', async () => {
    const { api, calls } = brain(person, 'open', ['team-docs']);
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
    writeFileSync(join(dir, 'extra.md'), 'x');
    await expect(
      importCommand.run([join(dir, 'extra.md'), '--into', 'team-docs'], testIo({ api }).io),
    ).rejects.toThrow(
      'team-docs is open to the whole workspace. Import into a restricted folder, or pass --allow-open to import where everyone can read.',
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${W}/tree`]);
  });

  it('imports into an open folder with --allow-open', async () => {
    const { api, calls } = brain(person, 'open', ['team-docs']);
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
    writeFileSync(join(dir, 'extra.md'), 'x');
    expect(
      await importCommand.run(
        [join(dir, 'extra.md'), '--into', 'team-docs', '--allow-open'],
        testIo({ api }).io,
      ),
    ).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${W}/tree`, `PUT ${W}/files`]);
  });

  it('does not ask for --allow-open under me/', async () => {
    const { api, calls } = brain(person, 'open', ['me/imported']);
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
    writeFileSync(join(dir, 'extra.md'), 'x');
    expect(
      await importCommand.run([join(dir, 'extra.md'), '--into', 'me/imported'], testIo({ api }).io),
    ).toBe(0);
    expect(calls.some((c) => c.path === `${W}/files`)).toBe(true);
  });

  it('rejects a --concurrency outside 1 to 16', async () => {
    const t = testIo();
    expect(await importCommand.run(['a.md', '--into', 'docs', '--concurrency', '17'], t.io)).toBe(
      2,
    );
    expect(await importCommand.run(['a.md', '--into', 'docs', '--concurrency', '0'], t.io)).toBe(2);
    expect(t.stderr()).toContain('--concurrency must be a whole number from 1 to 16');
  });

  it('creates a missing folder under me/ with no restriction or grant, for an agent key too', async () => {
    const { api, calls } = brain(ownedAgent);
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-import-'));
    writeFileSync(join(dir, 'notes.md'), 'x');
    expect(
      await importCommand.run([join(dir, 'notes.md'), '--into', 'me/imported'], testIo({ api }).io),
    ).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${W}/tree`,
      `POST ${W}/folders`,
      `PUT ${W}/files`,
    ]);
    expect(calls[1]?.body).toEqual({ path: 'me/imported' });
    expect(calls[2]?.body).toMatchObject({ path: 'me/imported/notes.md' });
  });

  it('needs a valid --into', async () => {
    expect(await importCommand.run(['notes.md'], testIo().io)).toBe(2);
    expect(await importCommand.run(['notes.md', '--into', 'My Docs'], testIo().io)).toBe(2);
  });
});
