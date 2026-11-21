// Task 32: onebrain admin loop lock <path> and unlock <path>.
import { describe, expect, it } from 'vitest';
import admin from '../src/commands/admin.ts';
import { main } from '../src/index.ts';
import { fakeApi, testIo } from './helpers.ts';

const LOCKS = '/v1/workspaces/kenso/loop/locks';
const LOCK = {
  path: 'clients/acme/overview.md',
  nodeId: '00000000-0000-4000-8000-000000000001',
  lockedAt: '2026-11-15T09:00:00.000Z',
};
const NOT_LOCKED =
  'That path is not locked for the loop. A lock on a folder above it is lifted at that folder';
const ADMIN_ONLY =
  'error: Only a workspace admin can manage the learning loop, signed in as a person (onebrain login), not with an agent key.\n';
const lockApi = () =>
  fakeApi({
    [`POST ${LOCKS}`]: () => ({ body: LOCK }),
    [`DELETE ${LOCKS}`]: () => ({ status: 204 }),
  });

describe('onebrain admin loop lock', () => {
  it('sends the path and prints the path locked', async () => {
    const { api, calls } = lockApi();
    const { io, stdout } = testIo({ api });
    expect(await admin.run(['loop', 'lock', 'clients/acme/overview.md'], io)).toBe(0);
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', LOCKS, { path: 'clients/acme/overview.md' }],
    ]);
    expect(stdout()).toBe('locked clients/acme/overview.md\n');
  });

  it('--json prints the lock', async () => {
    const { api } = lockApi();
    const { io, stdout } = testIo({ api });
    expect(await admin.run(['loop', 'lock', 'clients/acme/overview.md', '--json'], io)).toBe(0);
    expect(JSON.parse(stdout())).toEqual(LOCK);
  });
});

describe('onebrain admin loop unlock', () => {
  it('sends the path as a query and prints it', async () => {
    const { api, calls } = lockApi();
    const { io, stdout } = testIo({ api });
    expect(await admin.run(['loop', 'unlock', 'clients/acme'], io)).toBe(0);
    expect(calls.map((call) => [call.method, call.path, call.query.get('path')])).toEqual([
      ['DELETE', LOCKS, 'clients/acme'],
    ]);
    expect(stdout()).toBe('unlocked clients/acme\n');
  });
});

describe('lock and unlock, wrong use and refusals', () => {
  it('exit 2 without a path or with two, and call nothing', async () => {
    for (const args of [['lock'], ['unlock'], ['lock', 'a', 'b'], ['unlock', 'a', 'b']]) {
      const { api, calls } = lockApi();
      const { io, stderr } = testIo({ api });
      expect(await admin.run(['loop', ...args], io), args.join(' ')).toBe(2);
      expect(stderr()).toContain('onebrain admin loop lock <path>');
      expect(calls).toEqual([]);
    }
  });

  it('403 says who may manage the loop, 404 passes the answer on, and neither prints data', async () => {
    const denied = () => ({
      status: 403,
      body: { error: { code: 'forbidden', message: 'Only a workspace admin can do this' } },
    });
    const refused = fakeApi({ [`POST ${LOCKS}`]: denied, [`DELETE ${LOCKS}`]: denied });
    for (const args of [
      ['lock', 'clients'],
      ['unlock', 'clients'],
    ]) {
      const { io, stdout, stderr } = testIo({ api: refused.api });
      expect(await main(['admin', 'loop', ...args], io, [admin]), args.join(' ')).toBe(1);
      expect(stderr()).toBe(ADMIN_ONLY);
      expect(stdout()).toBe('');
    }
    const missing = fakeApi({
      [`DELETE ${LOCKS}`]: () => ({
        status: 404,
        body: { error: { code: 'not_found', message: NOT_LOCKED } },
      }),
    });
    const { io, stdout, stderr } = testIo({ api: missing.api });
    expect(await main(['admin', 'loop', 'unlock', 'clients/acme/overview.md'], io, [admin])).toBe(
      1,
    );
    expect(stderr()).toBe(`error: not_found: ${NOT_LOCKED}\n`);
    expect(stdout()).toBe('');
  });
});
