import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  function keychainLoad(account: string): StoredLogin | null {
    if (!useKeychain) return null;
    if (platform === 'darwin') {
      const result = run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      return result.status === 0 ? parseLogin(result.stdout, 'base64') : null;
    }
    const result = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    return result.status === 0 ? parseLogin(result.stdout, 'json') : null;
  }

  return {
    async load(url) {
      const account = new URL(url).origin;
      return keychainLoad(account) ?? readFile()[account] ?? null;
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
      return 'file';
    },
  };
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
