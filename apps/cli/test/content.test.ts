import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import capture from '../src/commands/capture.ts';
import read from '../src/commands/read.ts';
import remember from '../src/commands/remember.ts';
import search from '../src/commands/search.ts';
import write from '../src/commands/write.ts';
import { type FakeCall, type FakeReply, fakeApi, testIo } from './helpers.ts';

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
    expect(calls).toHaveLength(1);
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

describe('capture of a session over the cap', () => {
  type Posted = { bytes: Buffer; ref: string | null; name: string; form: FormData };
  /**
   * POST sources as the server answers it, with a small cap: 413 source_too_large with maxBytes
   * over `maxBytes`, 413 payload_too_large over `bodyLimit`, 400 for blank content, and a
   * duplicate for content it stored before. `answer` can step in first, for a 429.
   */
  const server = (
    maxBytes: number,
    options: { bodyLimit?: number; answer?: (sent: Posted) => FakeReply | null } = {},
  ) => {
    const posted: Posted[] = [];
    const stored = new Map<string, string>();
    let running = 0;
    let most = 0;
    const route = async (call: FakeCall): Promise<FakeReply> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      const form = call.form as FormData;
      const file = form.get('content') as File;
      const sent: Posted = {
        bytes: Buffer.from(await file.arrayBuffer()),
        ref: form.get('externalRef') as string | null,
        name: file.name,
        form,
      };
      posted.push(sent);
      const early = options.answer?.(sent);
      if (early) return early;
      const size = sent.bytes.length;
      if (options.bodyLimit !== undefined && size > options.bodyLimit) {
        return { status: 413, body: { error: { code: 'payload_too_large', message: 'big' } } };
      }
      if (size > maxBytes) {
        const error = { code: 'source_too_large', message: 'too large', sizeBytes: size, maxBytes };
        return { status: 413, body: { error } };
      }
      const text = sent.bytes.toString('utf8');
      if (text.trim() === '') {
        return { status: 400, body: { error: { code: 'invalid_request', message: 'empty' } } };
      }
      const duplicate = stored.has(text);
      if (!duplicate) stored.set(text, `s${stored.size + 1}`);
      return { status: duplicate ? 200 : 201, body: { id: stored.get(text), duplicate } };
    };
    const { api } = fakeApi({ [`POST ${W}/sources`]: route });
    return { api, posted, most: () => most };
  };
  /** JSON lines of about 40 bytes each, with a two-byte character in each. */
  const lines = (from: number, to: number) =>
    Array.from(
      { length: to - from },
      (_, i) => `{"type":"user","n":${from + i},"text":"café"}\n`,
    ).join('');
  const run = async (fake: ReturnType<typeof server>, path: string, ref = 'claude-code:abc') => {
    const t = testIo({ api: fake.api });
    const code = await capture.run([path, '--folder', 'sessions', '--ref', ref], t.io);
    return { code, stdout: t.stdout(), stderr: t.stderr() };
  };

  it('posts the whole transcript once, then parts within maxBytes, cut at line ends, that join back to it', async () => {
    // The last line has no line end: it ends a part all the same.
    const body = `${lines(0, 20)}{"type":"assistant","n":20}`;
    const fake = server(120);
    const done = await run(fake, temp('session.jsonl', body));
    expect(done.code).toBe(0);

    const [whole, ...parts] = fake.posted;
    expect(whole?.bytes.equals(Buffer.from(body))).toBe(true);
    expect(whole?.ref).toBe('claude-code:abc');
    expect(parts.length).toBeGreaterThan(3);
    expect(Buffer.concat(parts.map((part) => part.bytes)).equals(Buffer.from(body))).toBe(true);
    for (const [index, part] of parts.entries()) {
      expect(part.bytes.length).toBeLessThanOrEqual(120);
      if (index < parts.length - 1) expect(part.bytes.at(-1)).toBe(0x0a);
      expect(part.ref).toBe(`claude-code:abc#part-${index + 1}`);
      expect(part.name).toBe(`session.jsonl part ${index + 1} of ${parts.length}`);
      expect(part.form.get('kind')).toBe('session');
      expect(part.form.get('folder')).toBe('sessions');
      expect(part.form.get('occurredAt')).toBe(whole?.form.get('occurredAt'));
    }
    expect(fake.most()).toBe(1); // one after another
    expect(done.stdout).toBe(parts.map((_, i) => `s${i + 1}\n`).join(''));
    expect(done.stderr).toBe(
      `claude-code:abc: ${Buffer.byteLength(body)} bytes in ${parts.length} parts: ${parts.length} stored, 0 refused\n`,
    );
  });

  it('sends a line longer than the cap alone, and logs its refusal with sizes and no content', async () => {
    const long = `{"type":"tool_result","text":"${'zebra '.repeat(60)}"}\n`;
    const fake = server(200);
    const done = await run(
      fake,
      temp('long.jsonl', `${lines(0, 2)}${long}${lines(2, 4)}`),
      'codex:xyz',
    );
    expect(done.code).toBe(1);
    expect(fake.posted.slice(1).map((part) => part.bytes.toString('utf8'))).toEqual([
      lines(0, 2),
      long,
      lines(2, 4),
    ]);
    const size = Buffer.byteLength(long);
    expect(done.stderr).toBe(
      `codex:xyz: part 2 of 3 refused (source_too_large), ${size} bytes, the largest source is 200 bytes\n` +
        `codex:xyz: ${Buffer.byteLength(lines(0, 4)) + size} bytes in 3 parts: 2 stored, 1 refused\n`,
    );
    expect(done.stderr).not.toContain('zebra');
    expect(done.stdout).toBe('s1\ns2\n');
  });

  it('sends the same refs when the same session is captured again, and its unchanged parts are the ones stored before', async () => {
    const path = temp('again.jsonl', lines(0, 12));
    const fake = server(200);
    expect((await run(fake, path)).code).toBe(0);
    const first = fake.posted.splice(0).slice(1);
    const again = await run(fake, path);
    expect(again.code).toBe(0);
    const second = fake.posted.splice(0).slice(1);
    expect(second.map((part) => part.ref)).toEqual(first.map((part) => part.ref));
    expect(again.stdout).toBe(first.map((_, i) => `s${i + 1}\n`).join(''));
    expect(again.stderr).toContain(
      `${first.length} parts: ${first.length} stored (${first.length} captured before), 0 refused`,
    );

    // The session went on: the parts before its last are cut where they were, and are the same.
    writeFileSync(path, lines(0, 16));
    expect((await run(fake, path)).code).toBe(0);
    const grown = fake.posted.splice(0).slice(1);
    expect(first.length).toBeGreaterThan(2);
    for (const [index, part] of first.slice(0, -1).entries()) {
      expect(grown[index]?.ref).toBe(part.ref);
      expect(grown[index]?.bytes.equals(part.bytes)).toBe(true);
    }
  });

  it('waits for Retry-After once on a 429, then gives up on the rest with a log line', async () => {
    let limited = 0;
    const tooMany: FakeReply = {
      status: 429,
      body: { error: { code: 'too_many_requests', message: 'slow down' } },
      headers: { 'Retry-After': '0' },
    };
    // The second part's first try is over the rate limit, its second is not, the third part's is.
    const fake = server(200, {
      answer: (sent) => (/#part-[23]$/.test(sent.ref ?? '') && limited++ !== 1 ? tooMany : null),
    });
    const body = lines(0, 20);
    const done = await run(fake, temp('busy.jsonl', body));
    expect(done.code).toBe(1);
    expect(fake.posted.slice(1).map((part) => part.ref)).toEqual([
      'claude-code:abc#part-1',
      'claude-code:abc#part-2',
      'claude-code:abc#part-2', // after the wait
      'claude-code:abc#part-3', // a second 429: no more waiting
    ]);
    const total = Number(done.stderr.match(/in (\d+) parts/)?.[1]);
    expect(total).toBeGreaterThan(3);
    expect(done.stderr).toBe(
      `claude-code:abc: rate limited at part 3 of ${total}, ${total - 2} parts not sent\n` +
        `claude-code:abc: ${Buffer.byteLength(body)} bytes in ${total} parts: 2 stored, 0 refused, ${total - 2} not sent\n`,
    );
  });

  it('asks for the cap with blank probes when the transcript is over the request body limit, and stores no probe', async () => {
    const body = lines(0, 20);
    const size = Buffer.byteLength(body);
    // The whole and the first probe are over the body limit; the second probe is over the cap.
    const fake = server(100, { bodyLimit: Math.floor(size / 2) - 1 });
    expect((await run(fake, temp('huge.jsonl', body))).code).toBe(0);
    const sent = fake.posted.slice(1);
    const probes = sent.filter((one) => one.bytes.toString('utf8').trim() === '');
    expect(probes.map((probe) => probe.bytes.length)).toEqual([
      Math.floor(size / 2),
      Math.floor(size / 4),
    ]);
    expect(probes.every((probe) => probe.ref === 'claude-code:abc')).toBe(true);
    const parts = sent.slice(2);
    expect(parts.every((part) => part.ref?.includes('#part-'))).toBe(true);
    expect(Buffer.concat(parts.map((part) => part.bytes)).equals(Buffer.from(body))).toBe(true);
    for (const part of parts) expect(part.bytes.length).toBeLessThanOrEqual(100);

    // A probe refused as empty is under the cap: parts that long are stored.
    const roomy = server(1000, { bodyLimit: Math.floor(size / 2) - 1 });
    expect((await run(roomy, temp('roomy.jsonl', body))).code).toBe(0);
    const [, first, second, ...rest] = roomy.posted;
    expect([first?.bytes.length, second?.bytes.length]).toEqual([
      Math.floor(size / 2),
      Math.floor(size / 4),
    ]);
    expect(Buffer.concat(rest.map((part) => part.bytes)).equals(Buffer.from(body))).toBe(true);
    for (const part of rest) expect(part.bytes.length).toBeLessThanOrEqual(Math.floor(size / 4));
  });
});
