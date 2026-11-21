import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import review, { lineDiff } from '../src/commands/review.ts';
import { fakeApi, testIo } from './helpers.ts';

const W = '/v1/workspaces/kenso';
const at = '2026-11-13T00:00:00.000Z';
const improvement = {
  id: 'i1',
  path: 'clients/acme/overview.md',
  baseVersion: 1,
  title: 'Renewal moved to April',
  why: 'A newer note says April',
  status: 'pending',
  citations: [{ kind: 'memory', ref: 'm1' }],
  proposedBy: { id: 'p1', displayName: 'a-claude' },
  decidedBy: null,
  decidedAt: null,
  createdAt: at,
};
const detail = {
  ...improvement,
  currentBody: '# Acme\nRenewal is in March.',
  newBody: '# Acme\nRenewal is in April.',
};
const accepted = (body: string) => ({
  improvement: { ...improvement, status: 'accepted' },
  file: {
    id: 'n1',
    path: improvement.path,
    version: 2,
    body,
    visibility: 'workspace',
    changeKind: 'improvement',
    author: { id: 'p2', displayName: 'A' },
    onBehalfOf: null,
    updatedAt: at,
  },
});

describe('review', () => {
  it('lists pending improvements', async () => {
    const { api, calls } = fakeApi({
      [`GET ${W}/improvements`]: () => ({ body: { data: [improvement] } }),
    });
    const t = testIo({ api });
    expect(await review.run([], t.io)).toBe(0);
    expect(calls[0]?.query.get('status')).toBe('pending');
    expect(t.stdout()).toContain(
      'i1  clients/acme/overview.md  Renewal moved to April  (a-claude, 2026-11-13)',
    );
  });

  it('says when there is nothing to review', async () => {
    const { api } = fakeApi({ [`GET ${W}/improvements`]: () => ({ body: { data: [] } }) });
    const t = testIo({ api });
    expect(await review.run(['list', '--status', 'accepted'], t.io)).toBe(0);
    expect(t.stdout()).toBe('');
    expect(t.stderr()).toContain('Nothing to review.');
  });

  it('shows the reason, the sources and the diff', async () => {
    const { api } = fakeApi({ [`GET ${W}/improvements/i1`]: () => ({ body: detail }) });
    const t = testIo({ api });
    expect(await review.run(['i1'], t.io)).toBe(0);
    expect(t.stdout()).toContain('Why: A newer note says April');
    expect(t.stdout()).toContain('Sources: memory:m1');
    expect(t.stdout()).toContain('-Renewal is in March.\n+Renewal is in April.');
  });

  it('accepts and prints accepted', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/improvements/i1/accept`]: () => ({ body: accepted(detail.newBody) }),
    });
    const t = testIo({ api });
    expect(await review.run(['accept', 'i1'], t.io)).toBe(0);
    expect(calls[0]?.body).toEqual({});
    expect(t.stdout()).toBe('accepted\nclients/acme/overview.md version 2\n');
  });

  it('says so when accepting a private proposal only shared it for review', async () => {
    const { api } = fakeApi({
      [`POST ${W}/improvements/i1/accept`]: () => ({ body: { improvement, file: null } }),
    });
    const t = testIo({ api });
    expect(await review.run(['accept', 'i1'], t.io)).toBe(0);
    expect(t.stdout()).toBe('shared for review\nclients/acme/overview.md\n');
  });

  it('keeps an improvement pending when the file moved on', async () => {
    const { api } = fakeApi({
      [`POST ${W}/improvements/i1/accept`]: () => ({
        status: 409,
        body: { error: { code: 'conflict', message: 'Stale', currentVersion: 3 } },
      }),
    });
    const t = testIo({ api });
    expect(await review.run(['accept', 'i1'], t.io)).toBe(1);
    expect(t.stderr()).toContain('It stays pending');
  });

  it('accepts the body the editor saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebrain-review-'));
    const editor = join(dir, 'editor.mjs');
    writeFileSync(
      editor,
      "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.argv[2];\nwriteFileSync(f, readFileSync(f, 'utf8').replace('April', 'May'));\n",
    );
    const { api, calls } = fakeApi({
      [`GET ${W}/improvements/i1`]: () => ({ body: detail }),
      [`POST ${W}/improvements/i1/accept`]: () => ({
        body: accepted('# Acme\nRenewal is in May.'),
      }),
    });
    const t = testIo({ api, env: { EDITOR: `"${process.execPath}" "${editor}"` } });
    expect(await review.run(['edit', 'i1'], t.io)).toBe(0);
    expect(calls[1]?.body).toEqual({ body: '# Acme\nRenewal is in May.' });
  });

  it('accepts nothing when the editor fails', async () => {
    const { api, calls } = fakeApi({ [`GET ${W}/improvements/i1`]: () => ({ body: detail }) });
    const t = testIo({ api, env: { EDITOR: `"${process.execPath}" -e "process.exit(3)"` } });
    expect(await review.run(['edit', 'i1'], t.io)).toBe(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('accepts the content of --file without opening an editor', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'onebrain-review-')), 'new.md');
    writeFileSync(path, '# Acme\nRenewal is in June.');
    const { api, calls } = fakeApi({
      [`POST ${W}/improvements/i1/accept`]: () => ({
        body: accepted('# Acme\nRenewal is in June.'),
      }),
    });
    const t = testIo({ api });
    expect(await review.run(['edit', 'i1', '--file', path], t.io)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ body: '# Acme\nRenewal is in June.' });
    expect(t.stdout()).toBe('accepted\nclients/acme/overview.md version 2\n');
  });

  it('dismisses with a reason', async () => {
    const { api, calls } = fakeApi({
      [`POST ${W}/improvements/i1/dismiss`]: () => ({
        body: { ...improvement, status: 'dismissed' },
      }),
    });
    const t = testIo({ api });
    expect(await review.run(['dismiss', 'i1', '--reason', 'Not true'], t.io)).toBe(0);
    expect(calls[0]?.body).toEqual({ reason: 'Not true' });
    expect(t.stdout()).toBe('dismissed\n');
  });
});

describe('lineDiff', () => {
  it('marks removed lines before added ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toBe(' a\n-b\n+B\n c');
    expect(lineDiff('', 'x')).toBe('-\n+x');
  });
});
