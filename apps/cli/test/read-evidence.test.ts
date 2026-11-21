import { describe, expect, it } from 'vitest';
import read from '../src/commands/read.ts';
import { fakeApi, testIo } from './helpers.ts';

const W = '/v1/workspaces/kenso';
const ID = '3f1c2a9e-0000-4000-8000-000000000015';
const at = '2026-11-13T00:00:00.000Z';
// A memory as a server before the loop sends it: no kind, no evidence.
const base = {
  id: ID,
  text: 'The Acme renewal moves to April.',
  folder: 'clients/acme',
  visibility: 'workspace',
  status: 'unreviewed',
  validFrom: at,
  validTo: null,
  supersedesId: null,
  source: { kind: 'upload', ref: null },
  author: { id: 'p1', displayName: 'one-brain' },
  onBehalfOf: null,
  createdAt: at,
};
const evidence = [
  {
    sourceId: 'a1b2c3d4-0000-4000-8000-000000000001',
    sourceKind: 'session',
    quote: 'ok so renewal is april now, not march',
    at: '2026-11-03T09:00:00.000Z',
  },
  {
    sourceId: 'a1b2c3d4-0000-4000-8000-000000000002',
    sourceKind: 'upload',
    quote: 'Contract addendum: renewal date April 1.',
    at: '2026-11-10T23:30:00.000Z',
  },
];

async function readMemory(body: unknown, args: string[] = []) {
  const { api } = fakeApi({ [`GET ${W}/memories/${ID}`]: () => ({ body }) });
  const t = testIo({ api });
  expect(await read.run([ID, ...args], t.io)).toBe(0);
  return t;
}

describe('read, a memory', () => {
  it('prints the memory kind and each quote on its own indented line with the source kind and date', async () => {
    const t = await readMemory({ ...base, kind: 'decision', evidence });
    expect(t.stdout()).toBe('The Acme renewal moves to April.\n');
    expect(t.stderr()).toBe(
      'status: unreviewed\n' +
        'kind: decision\n' +
        'evidence:\n' +
        '  session 2026-11-03  "ok so renewal is april now, not march"\n' +
        '  upload 2026-11-10  "Contract addendum: renewal date April 1."\n',
    );
  });

  it('prints neither for a saved memory, nor when an older server sends neither field', async () => {
    const saved = await readMemory({ ...base, kind: null, evidence: [] });
    expect(saved.stderr()).toBe('status: unreviewed\n');
    const older = await readMemory(base);
    expect(older.stderr()).toBe('status: unreviewed\n');
  });

  it('keeps a quote to one line of plain text', async () => {
    const quote = 'line one\n\tline two \u001b]52;c;aGk=\u0007 end\r\n';
    const t = await readMemory({ ...base, kind: 'fact', evidence: [{ ...evidence[0], quote }] });
    expect(t.stderr()).toContain('  session 2026-11-03  "line one line two ]52;c;aGk= end"\n');
    expect(t.stderr()).not.toContain('\u001b');
    expect(t.stderr()).not.toContain('\u0007');
  });

  it('prints the evidence in --json', async () => {
    const t = await readMemory({ ...base, kind: 'decision', evidence }, ['--json']);
    expect(JSON.parse(t.stdout())).toMatchObject({ kind: 'decision', evidence });
    expect(t.stderr()).toBe('');
  });
});
