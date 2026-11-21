import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from '../src/config.ts';
import {
  type CredentialStore,
  createCredentialStore,
  KeychainRefused,
  RefreshLockBusy,
  refreshLogin,
  refreshShared,
  type StoredLogin,
  withRefreshLock,
} from '../src/credentials.ts';
import { fakeFetch } from './helpers.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'onebrain-cred-'));
const login: StoredLogin = {
  url: 'http://localhost:8787',
  issuer: 'https://issuer.test',
  clientId: 'cli',
  audience: null,
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function fakeHelper(name: string): string {
  const bin = temp();
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, name), 0o755);
  return bin;
}

describe('config', () => {
  it('merges and reads settings', () => {
    const home = temp();
    expect(readConfig(home)).toEqual({});
    writeConfig(home, { url: 'https://brain.test' });
    writeConfig(home, { workspace: 'kenso' });
    expect(readConfig(home)).toEqual({ url: 'https://brain.test', workspace: 'kenso' });
  });
});

describe('credential store', () => {
  it('falls back to a mode 600 file when no keychain helper is on PATH', async () => {
    const home = temp();
    const store = createCredentialStore({ home, env: { PATH: '' }, platform: 'linux' });
    expect(await store.save(login)).toBe('file');
    const file = join(home, '.config/onebrain/credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.load('http://localhost:8787/')).toEqual(login);
  });

  it('uses secret-tool on Linux and keeps no file copy', async () => {
    const home = temp();
    const calls: { command: string; args: string[]; input?: string }[] = [];
    let saved = '';
    const store = createCredentialStore({
      home,
      env: { PATH: fakeHelper('secret-tool') },
      platform: 'linux',
      run: (command, args, input) => {
        calls.push({ command, args, ...(input === undefined ? {} : { input }) });
        if (args[0] === 'store') saved = input ?? '';
        return { status: 0, stdout: args[0] === 'lookup' ? saved : '' };
      },
    });
    expect(await store.save(login)).toBe('keychain');
    expect(calls[0]?.args).toEqual([
      'store',
      '--label=One Brain',
      'service',
      'onebrain',
      'account',
      'http://localhost:8787',
    ]);
    expect(calls[0]?.args.join(' ')).not.toContain('at-1');
    expect(existsSync(join(home, '.config/onebrain/credentials.json'))).toBe(false);
    expect(await store.load(login.url)).toEqual(login);
  });

  it('falls back to the file when the helper fails', async () => {
    const home = temp();
    const store = createCredentialStore({
      home,
      env: { PATH: fakeHelper('secret-tool') },
      platform: 'linux',
      run: () => ({ status: 1, stdout: '' }),
    });
    expect(await store.save(login)).toBe('file');
  });

  it('clears the secret-tool item when a save falls back to the file', async () => {
    const calls: string[][] = [];
    const store = createCredentialStore({
      home: temp(),
      env: { PATH: fakeHelper('secret-tool') },
      platform: 'linux',
      run: (command, args) => {
        calls.push([command, ...args]);
        return { status: 1, stdout: '' };
      },
    });
    expect(await store.save(login)).toBe('file');
    expect(calls).toContainEqual([
      'secret-tool',
      'clear',
      'service',
      'onebrain',
      'account',
      'http://localhost:8787',
    ]);
  });
});

describe('the Mac keychain', () => {
  /** A Mac whose `security` ends every call with this exit code. */
  const mac = (home: string, status: number) =>
    createCredentialStore({
      home,
      env: { PATH: fakeHelper('security') },
      platform: 'darwin',
      run: () => ({ status, stdout: '' }),
    });

  it('says the keychain refused when security fails with anything but "no such item"', async () => {
    // Over SSH the login keychain is locked: find-generic-password exits 36.
    const loading = mac(temp(), 36).load(login.url);
    await expect(loading).rejects.toThrow(
      'The keychain refused (exit 36). Run this in Terminal on the Mac.',
    );
    await expect(loading).rejects.toBeInstanceOf(KeychainRefused);
  });

  it('reads exit 44, no such item, as nobody signed in', async () => {
    expect(await mac(temp(), 44).load(login.url)).toBeNull();
  });

  it('still reads a login the file holds when the keychain refuses', async () => {
    const home = temp();
    expect(await mac(home, 36).save(login)).toBe('file'); // a sign-in over SSH lands in the file
    expect(await mac(home, 36).load(login.url)).toEqual(login);
  });

  it('takes an older keychain item out of the way when a save falls back to the file', async () => {
    const home = temp();
    // A keychain that holds last month's login, reads and deletes, and takes no new item.
    const old = { ...login, accessToken: 'at-old' };
    let held: string | null = Buffer.from(JSON.stringify(old)).toString('base64');
    const store = createCredentialStore({
      home,
      env: { PATH: fakeHelper('security') },
      platform: 'darwin',
      run: (_command, args) => {
        if (args[0] === 'find-generic-password') {
          return held ? { status: 0, stdout: `${held}\n` } : { status: 44, stdout: '' };
        }
        if (args[0] === 'delete-generic-password') {
          held = null;
          return { status: 0, stdout: '' };
        }
        return { status: 1, stdout: '' }; // -i: the new item is refused
      },
    });
    expect(await store.save(login)).toBe('file');
    expect((await store.load(login.url))?.accessToken).toBe('at-1');
  });

  it('reads the login the file holds when an older keychain item would not go', async () => {
    const home = temp();
    // A locked keychain that still reads: it holds last month's login, takes no new item and
    // deletes none.
    const old = { ...login, accessToken: 'at-old' };
    const held = Buffer.from(JSON.stringify(old)).toString('base64');
    const store = createCredentialStore({
      home,
      env: { PATH: fakeHelper('security') },
      platform: 'darwin',
      run: (_command, args) => {
        if (args[0] === 'find-generic-password') return { status: 0, stdout: `${held}\n` };
        if (args[0] === 'delete-generic-password') return { status: 36, stdout: '' };
        return { status: 1, stdout: '' }; // -i: the new item is refused
      },
    });
    expect((await store.load(login.url))?.accessToken).toBe('at-old');
    expect(await store.save(login)).toBe('file');
    expect((await store.load(login.url))?.accessToken).toBe('at-1');
  });
});

describe('the stored format the Mac app reads', () => {
  // The Rust helper reads and writes these bytes too: its tests read the same two files.
  const fixture = (name: string) =>
    readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
  const fixed: StoredLogin = {
    url: 'https://api.useonebrain.com',
    issuer: 'https://auth.example.test/',
    clientId: 'cli-client',
    audience: 'https://api.useonebrain.com',
    accessToken: 'fixture-access-token',
    refreshToken: 'fixture-refresh-token',
    expiresAt: '2026-11-18T10:00:00.000Z',
  };

  it('writes credentials.json byte for byte as cli-credentials.fixture', async () => {
    const home = temp();
    const store = createCredentialStore({ home, env: { PATH: '' }, platform: 'linux' });
    expect(await store.save(fixed)).toBe('file');
    const written = readFileSync(join(home, '.config/onebrain/credentials.json'), 'utf8');
    expect(written).toBe(fixture('cli-credentials.fixture'));
  });

  it('gives security the line of cli-keychain-line.fixture on stdin', async () => {
    let stdin = '';
    const store = createCredentialStore({
      home: temp(),
      env: { PATH: fakeHelper('security') },
      platform: 'darwin',
      run: (_command, _args, input) => {
        stdin = input ?? '';
        return { status: 0, stdout: '' };
      },
    });
    expect(await store.save(fixed)).toBe('keychain');
    expect(stdin).toBe(fixture('cli-keychain-line.fixture'));
  });
});

describe('refreshLogin', () => {
  it('trades the refresh token for a new access token', async () => {
    const fetchFn = fakeFetch({
      'GET /.well-known/openid-configuration': () => ({
        body: { token_endpoint: 'https://issuer.test/oauth/token' },
      }),
      'POST /oauth/token': (call) => {
        const form = new URLSearchParams(call.body as string);
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('rt-1');
        return { body: { access_token: 'at-2', expires_in: 600 } };
      },
    });
    const next = await refreshLogin(login, fetchFn);
    expect(next?.accessToken).toBe('at-2');
    expect(next?.refreshToken).toBe('rt-1');
  });

  it('returns null without a refresh token', async () => {
    expect(await refreshLogin({ ...login, refreshToken: null }, fakeFetch({}))).toBeNull();
  });
});

describe('refreshShared', () => {
  it('hands the refreshed login back even when it cannot be stored', async () => {
    const home = temp();
    let saves = 0;
    const store: CredentialStore = {
      load: async () => login,
      save: async () => {
        saves++;
        throw new Error('the disk is full');
      },
    };
    const fetchFn = fakeFetch({
      'GET /.well-known/openid-configuration': () => ({
        body: { token_endpoint: 'https://issuer.test/oauth/token' },
      }),
      'POST /oauth/token': () => ({
        body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 600 },
      }),
    });
    const next = await refreshShared(store, login.url, 'at-1', fetchFn, { home });
    // The issuer rotated: rt-1 is dead, so this login is the only one there is.
    expect(next?.accessToken).toBe('at-2');
    expect(next?.refreshToken).toBe('rt-2');
    expect(saves).toBe(1);
    expect(existsSync(join(home, '.config/onebrain/refresh.lock'))).toBe(false);
  });

  it('writes no refreshed login over one saved while the issuer took its time', async () => {
    for (const emptied of [false, true]) {
      const home = temp();
      const ben: StoredLogin = { ...login, accessToken: 'ben-at', refreshToken: 'ben-rt' };
      let stored: StoredLogin | null = login;
      const saved: StoredLogin[] = [];
      const store: CredentialStore = {
        load: async () => stored,
        save: async (next) => {
          saved.push(next);
          stored = next;
          return 'file';
        },
      };
      const fetchFn = fakeFetch({
        'GET /.well-known/openid-configuration': () => ({
          body: { token_endpoint: 'https://issuer.test/oauth/token' },
        }),
        'POST /oauth/token': () => {
          // Meanwhile `onebrain login` gave up on the lock and saved, or the store was emptied.
          stored = emptied ? null : ben;
          return { body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 600 } };
        },
      });
      const next = await refreshShared(store, login.url, 'at-1', fetchFn, { home });
      expect(next).toEqual(emptied ? null : ben);
      expect(saved).toEqual([]);
      expect(stored).toEqual(emptied ? null : ben);
      expect(existsSync(join(home, '.config/onebrain/refresh.lock'))).toBe(false);
    }
  });
});

describe('withRefreshLock', () => {
  const lockFile = (home: string) => join(home, '.config/onebrain/refresh.lock');
  /** A clock that moves only when the lock sleeps. */
  const fakeTime = (start = Date.parse('2026-11-18T10:00:00.000Z')) => {
    let t = start;
    let sleeps = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
        sleeps++;
      },
      sleeps: () => sleeps,
    };
  };
  const hold = (home: string, content: string) => {
    mkdirSync(join(home, '.config/onebrain'), { recursive: true });
    writeFileSync(lockFile(home), content);
  };
  const lockAt = (ms: number) => JSON.stringify({ pid: 1, at: new Date(ms).toISOString() });

  it('writes { pid, at } with mode 600, runs the work and removes the lock, also when the work throws', async () => {
    const home = temp();
    const time = fakeTime();
    const seen = await withRefreshLock({ home, ...time }, async () => ({
      text: readFileSync(lockFile(home), 'utf8'),
      mode: statSync(lockFile(home)).mode & 0o777,
    }));
    expect(seen.text).toBe(`{"pid":${process.pid},"at":"2026-11-18T10:00:00.000Z"}`);
    expect(seen.mode).toBe(0o600);
    expect(existsSync(lockFile(home))).toBe(false);
    await expect(
      withRefreshLock({ home, ...time }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockFile(home))).toBe(false);
  });

  it('waits for a holder and goes in when it lets go', async () => {
    const home = temp();
    const order: string[] = [];
    let release = () => {};
    const first = withRefreshLock(
      { home },
      () =>
        new Promise<void>((resolve) => {
          order.push('first in');
          release = () => {
            order.push('first out');
            resolve();
          };
        }),
    );
    const second = withRefreshLock(
      {
        home,
        sleep: async () => {
          release();
          await new Promise((resolve) => setImmediate(resolve));
        },
      },
      async () => {
        order.push('second in');
      },
    );
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
  });

  it('takes over a lock older than 30 s at once, and waits for a younger one until it is', async () => {
    const home = temp();
    const time = fakeTime();
    hold(home, lockAt(time.now() - 31_000));
    await withRefreshLock({ home, ...time }, async () => {});
    expect(time.sleeps()).toBe(0);

    hold(home, lockAt(time.now() - 29_000));
    await withRefreshLock({ home, ...time }, async () => {});
    expect(time.sleeps()).toBe(11); // 29.0 s plus 11 x 100 ms is the first age over 30 s
  });

  it('gives up after 15 s on a live lock and leaves it alone', async () => {
    const home = temp();
    const time = fakeTime();
    const theirs = lockAt(time.now());
    hold(home, theirs);
    await expect(withRefreshLock({ home, ...time }, async () => {})).rejects.toBeInstanceOf(
      RefreshLockBusy,
    );
    expect(time.sleeps()).toBe(150);
    expect(readFileSync(lockFile(home), 'utf8')).toBe(theirs);
  });

  it('judges a lock it cannot read by the time of the file', async () => {
    const home = temp();
    const time = fakeTime(Date.now());
    hold(home, 'not json');
    const old = new Date(time.now() - 31_000);
    utimesSync(lockFile(home), old, old);
    await withRefreshLock({ home, ...time }, async () => {});
    expect(time.sleeps()).toBe(0);
  });

  it('takes a lock from more than 30 s ahead for a dead one, and waits for a nearer one', async () => {
    // A clock that was set back, or a holder whose clock runs ahead: its `at` is in the future.
    const home = temp();
    const time = fakeTime();
    hold(home, lockAt(time.now() + 30_001));
    await withRefreshLock({ home, ...time }, async () => {});
    expect(time.sleeps()).toBe(0);

    const theirs = lockAt(time.now() + 30_000);
    hold(home, theirs);
    await expect(withRefreshLock({ home, ...time }, async () => {})).rejects.toBeInstanceOf(
      RefreshLockBusy,
    );
    expect(time.sleeps()).toBe(150);
    expect(readFileSync(lockFile(home), 'utf8')).toBe(theirs);
  });

  it('leaves nothing beside the lock when it takes one over', async () => {
    const home = temp();
    const time = fakeTime();
    hold(home, lockAt(time.now() - 31_000));
    const names = () => readdirSync(join(home, '.config/onebrain'));
    expect(await withRefreshLock({ home, ...time }, async () => names())).toEqual(['refresh.lock']);
    expect(names()).toEqual([]);
  });

  it('puts back a live lock it moved because another waiter took the dead one first', async () => {
    const home = temp();
    const time = fakeTime();
    hold(home, lockAt(time.now() - 31_000));
    // The other waiter takes the dead lock over right after this one read it: the clock is read
    // for the deadline, for this one's own lock, and then for the age of the lock it read.
    const theirs = lockAt(time.now());
    let reads = 0;
    const now = () => {
      if (++reads === 3) writeFileSync(lockFile(home), theirs);
      return time.now();
    };
    await expect(
      withRefreshLock({ home, now, sleep: time.sleep }, async () => {}),
    ).rejects.toBeInstanceOf(RefreshLockBusy);
    expect(time.sleeps()).toBe(150); // waited on like any live lock
    expect(readFileSync(lockFile(home), 'utf8')).toBe(theirs);
    expect(readdirSync(join(home, '.config/onebrain'))).toEqual(['refresh.lock']);
  });

  it('does not remove a lock that is no longer its own', async () => {
    const home = temp();
    const theirs = '{"pid":2,"at":"2026-11-18T10:00:00.000Z"}';
    await withRefreshLock({ home }, async () => {
      writeFileSync(lockFile(home), theirs);
    });
    expect(readFileSync(lockFile(home), 'utf8')).toBe(theirs);
  });
});
