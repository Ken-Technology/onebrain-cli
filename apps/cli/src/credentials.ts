import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { configDir } from './config.ts';

export type StoredLogin = {
  url: string;
  issuer: string;
  clientId: string;
  audience: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
};

export type Runner = (
  command: string,
  args: string[],
  input?: string,
) => { status: number; stdout: string };

export type CredentialStore = {
  load(url: string): Promise<StoredLogin | null>;
  save(login: StoredLogin): Promise<'keychain' | 'file'>;
};

const SERVICE = 'onebrain';
/** How `security` ends when the keychain has no such item. */
const NO_SUCH_ITEM = 44;

/**
 * `security` would not say whether the keychain holds a login: the keychain is locked, as it is
 * over SSH (exit 36), or the person refused. Not the same as "not signed in".
 */
export class KeychainRefused extends Error {
  constructor(exit: number) {
    super(`The keychain refused (exit ${exit}). Run this in Terminal on the Mac.`);
    this.name = 'KeychainRefused';
  }
}

const helperFor = (platform: NodeJS.Platform) =>
  platform === 'darwin' ? 'security' : platform === 'linux' ? 'secret-tool' : null;

function onPath(name: string, path: string | undefined): boolean {
  return (path ?? '').split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const defaultRun: Runner = (command, args, input) => {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 10_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

function parseLogin(text: string, encoding: 'json' | 'base64'): StoredLogin | null {
  try {
    const json = encoding === 'base64' ? Buffer.from(text.trim(), 'base64').toString('utf8') : text;
    const parsed = JSON.parse(json) as StoredLogin;
    return typeof parsed.accessToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function createCredentialStore(options: {
  home: string;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  run?: Runner;
}): CredentialStore {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const helper = helperFor(platform);
  const useKeychain = helper !== null && onPath(helper, options.env.PATH);
  const file = join(configDir(options.home), 'credentials.json');

  const readFile = (): Record<string, StoredLogin> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredLogin>;
    } catch {
      return {};
    }
  };
  const writeFile = (all: Record<string, StoredLogin>) => {
    mkdirSync(configDir(options.home), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  };

  function keychainSave(account: string, json: string): boolean {
    if (!useKeychain) return false;
    const result =
      platform === 'darwin'
        ? run(
            'security',
            ['-i'],
            `add-generic-password -U -s ${SERVICE} -a ${account} -w ${Buffer.from(json).toString('base64')}\n`,
          )
        : run(
            'secret-tool',
            ['store', '--label=One Brain', 'service', SERVICE, 'account', account],
            json,
          );
    return result.status === 0;
  }

  /** The keychain's login, or null when it has none. On a Mac a refusal throws KeychainRefused. */
  function keychainLoad(account: string): StoredLogin | null {
    if (!useKeychain) return null;
    if (platform === 'darwin') {
      const result = run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      if (result.status === 0) return parseLogin(result.stdout, 'base64');
      if (result.status === NO_SUCH_ITEM) return null;
      throw new KeychainRefused(result.status);
    }
    const result = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    return result.status === 0 ? parseLogin(result.stdout, 'json') : null;
  }

  /** Takes the keychain's item away if it can. A refusal is fine: `load` reads the file first. */
  function keychainDelete(account: string): void {
    if (!useKeychain) return;
    if (platform === 'darwin') {
      run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
    } else run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
  }

  return {
    async load(url) {
      const account = new URL(url).origin;
      // The file holds an account only when the last save went there (a save the keychain
      // takes removes it): it is then the newest login, whatever the keychain still holds.
      const filed = readFile()[account] ?? null;
      return filed ?? keychainLoad(account);
    },
    async save(login) {
      const account = new URL(login.url).origin;
      if (keychainSave(account, JSON.stringify(login))) {
        const all = readFile();
        if (account in all) {
          delete all[account];
          writeFile(all);
        }
        return 'keychain';
      }
      writeFile({ ...readFile(), [account]: login });
      keychainDelete(account); // tidying: no older item stays behind; `load` reads the file first
      return 'file';
    },
  };
}

export type RefreshLockOptions = {
  home: string;
  /** Milliseconds since the epoch. Tests pass a fake clock. Default Date.now. */
  now?: () => number;
  /** Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

const LOCK_RETRY_MS = 100;
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
/** A lock is stale at 30 s, so reading the store and the token call end well before: 20 s. */
const REFRESH_BUDGET_MS = 20_000;

/** The lock stayed held for 15 s. Nobody is signed out by it. */
export class RefreshLockBusy extends Error {
  constructor() {
    super('Another One Brain process is refreshing your sign-in. Try again in a moment.');
    this.name = 'RefreshLockBusy';
  }
}

/** The lock's bytes and when it was taken: its `at`, else the file's time. Null: gone. */
function readLock(file: string): { text: string; at: number } | null {
  try {
    const text = readFileSync(file, 'utf8');
    let at = Number.NaN;
    try {
      const parsed = JSON.parse(text) as { at?: unknown } | null;
      if (typeof parsed?.at === 'string') at = Date.parse(parsed.at);
    } catch {}
    if (Number.isNaN(at)) at = statSync(file).mtimeMs;
    return { text, at };
  } catch {
    return null;
  }
}

/** Its holder died: older than 30 s, or dated more than 30 s ahead (a clock that was set back). */
const isStale = (age: number) => age > LOCK_STALE_MS || age < -LOCK_STALE_MS;

let takeovers = 0;

/**
 * Takes the dead lock that was judged out of the way. The rename is the claim: of two waiters
 * that judged one lock, one moves it and the other finds nothing to move. A lock that is not
 * the one judged is a live one that came after it, and goes back unless a newer one is there.
 * True: the dead lock is gone, so try at once.
 */
function takeOver(file: string, judged: string): boolean {
  const aside = `${file}.${process.pid}-${takeovers++}`;
  try {
    renameSync(file, aside);
  } catch {
    return false;
  }
  let dead = false;
  try {
    dead = readFileSync(aside, 'utf8') === judged;
  } catch {}
  if (!dead) {
    try {
      linkSync(aside, file);
    } catch {}
  }
  rmSync(aside, { force: true });
  return dead;
}

/**
 * Runs `inside` while holding ~/.config/onebrain/refresh.lock, the lock every One Brain program
 * on this machine (this CLI, the Mac app) takes before it refreshes the stored login. Exclusive
 * create; a held lock is retried every 100 ms for 15 s; one older than 30 s, or dated more than
 * 30 s ahead, is taken over. A takeover renames the lock to a name of its own and deletes it
 * there only if its bytes are the ones that were judged; any other lock it moved goes back.
 */
export async function withRefreshLock<T>(
  options: RefreshLockOptions,
  inside: () => Promise<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dir = configDir(options.home);
  const file = join(dir, 'refresh.lock');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = now() + LOCK_WAIT_MS;
  let mine = '';
  for (;;) {
    mine = JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() });
    try {
      writeFileSync(file, mine, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = readLock(file);
    // A dead lock is taken over and tried again at once. One that cannot be taken over is
    // waited on like a live one.
    if (held && isStale(now() - held.at) && takeOver(file, held.text)) continue;
    if (now() >= deadline) throw new RefreshLockBusy();
    await sleep(LOCK_RETRY_MS);
  }
  try {
    return await inside();
  } finally {
    if (readLock(file)?.text === mine) rmSync(file, { force: true });
  }
}

/** Reads the issuer's discovery document. A trailing slash on the issuer is dropped for the URL only. */
export async function discover(
  issuer: string,
  fetchFn: typeof fetch,
): Promise<{ deviceEndpoint: string | null; tokenEndpoint: string }> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await fetchFn(url);
  const doc = (await response.json().catch(() => ({}))) as {
    device_authorization_endpoint?: string;
    token_endpoint?: string;
  };
  if (!response.ok || !doc.token_endpoint) {
    throw new Error(`${issuer} does not publish OpenID configuration (HTTP ${response.status})`);
  }
  return {
    deviceEndpoint: doc.device_authorization_endpoint ?? null,
    tokenEndpoint: doc.token_endpoint,
  };
}

/** Null: no refresh token, or the issuer refused it. */
export async function refreshLogin(
  login: StoredLogin,
  fetchFn: typeof fetch,
): Promise<StoredLogin | null> {
  if (!login.refreshToken) return null;
  const { tokenEndpoint } = await discover(login.issuer, fetchFn);
  const response = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: login.refreshToken,
      client_id: login.clientId,
    }).toString(),
  });
  if (!response.ok) return null;
  const tokens = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token) return null;
  return {
    ...login,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? login.refreshToken,
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
  };
}

/**
 * The one refresh every path uses, under the lock. `stale` is the access token that expired or
 * that the server refused. Answers the login to go on with, or null when nobody is signed in any
 * more: no stored login, no refresh token, or the issuer refused it. When another login was saved
 * while the issuer answered, that login, saved over by nothing; null also when the store was
 * emptied meanwhile.
 */
export async function refreshShared(
  store: CredentialStore,
  url: string,
  stale: string,
  fetchFn: typeof fetch,
  lock: RefreshLockOptions,
): Promise<StoredLogin | null> {
  return withRefreshLock(lock, async () => {
    // One budget for reading the store and for the token call: a keychain prompt nobody answers
    // takes its 10 s out of the call's time, not out of the lock's 30 s.
    const signal = AbortSignal.timeout(REFRESH_BUDGET_MS);
    const current = await store.load(url);
    if (!current) return null;
    if (current.accessToken !== stale) return current; // another process refreshed: call nothing
    const bounded = ((input: string | URL | Request, init?: RequestInit) =>
      fetchFn(input, { ...init, signal })) as typeof fetch;
    const next = await refreshLogin(current, bounded).catch((error: unknown) => {
      throw signal.aborted ? signal.reason : error; // out of time, wherever it surfaced
    });
    if (!next) return null;
    // A login saved while the issuer took its time (`onebrain login`, or the Mac app's sign-in,
    // gives up on the lock after 15 s and saves without it) is newer than this refresh: it is not
    // written over. The caller goes on with it, or with nobody when the store was emptied
    // meanwhile. A store that will not say now gets the refreshed login, as before.
    const stored = await store.load(url).catch(() => current);
    if (stored?.accessToken !== current.accessToken) return stored;
    // An issuer that rotates has ended the old refresh token already, so this login is the only
    // one there is: the caller goes on with it even when the store refused it.
    await store.save(next).catch(() => undefined);
    return next;
  });
}
