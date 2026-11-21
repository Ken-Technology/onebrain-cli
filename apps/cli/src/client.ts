import { homedir } from 'node:os';
import { createOneBrainClient, type OneBrainClient } from '@useonebrain/sdk';
import { readConfig } from './config.ts';
import {
  type CredentialStore,
  createCredentialStore,
  KeychainRefused,
  RefreshLockBusy,
  type RefreshLockOptions,
  refreshShared,
  type StoredLogin,
} from './credentials.ts';

export type { OneBrainClient };

export type CliClient = { api: OneBrainClient; workspace: string };

export type Io = {
  /** Writes as is; callers add '\n'. */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The whole of stdin as UTF-8, or null when stdin is a terminal. */
  readStdin: () => Promise<string | null>;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  /** getClient with the global --workspace flag. */
  client: (options?: { needWorkspace?: boolean }) => Promise<CliClient>;
};

export type Command = {
  name: string;
  describe: string;
  run: (args: string[], io: Io) => Promise<number>;
};

export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class ApiError extends CliError {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message, 1);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** createOneBrainClient plus the X-OneBrain-Via: cli header the API records on every write. */
export function connect(url: string, token: string, fetchFn?: typeof fetch): OneBrainClient {
  const api = createOneBrainClient({ baseUrl: url, token, ...(fetchFn ? { fetch: fetchFn } : {}) });
  api.use({
    onRequest: ({ request }) => {
      request.headers.set('X-OneBrain-Via', 'cli');
      return request;
    },
  });
  return api;
}

export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error === undefined && result.response.ok) return result.data as T;
  const body = (result.error ?? {}) as { error?: Record<string, unknown> };
  const { code, message, ...extra } = body.error ?? {};
  throw new ApiError(
    result.response.status,
    typeof code === 'string' ? code : `http_${result.response.status}`,
    typeof message === 'string' ? message : result.response.statusText,
    extra,
  );
}

export function apiUrl(env: Record<string, string | undefined>, home: string): string {
  const url = env.ONEBRAIN_URL || readConfig(home).url || 'http://localhost:8787';
  return url.replace(/\/+$/, '');
}

/** refreshShared, with its failures as the CLI says them. Nobody signed in is "expired". */
async function renewLogin(
  store: CredentialStore,
  url: string,
  stale: string,
  fetchFn: typeof fetch,
  lock: RefreshLockOptions,
): Promise<StoredLogin> {
  let next: StoredLogin | null;
  try {
    next = await refreshShared(store, url, stale, fetchFn, lock);
  } catch (error) {
    if (error instanceof RefreshLockBusy || error instanceof KeychainRefused) {
      throw new CliError(error.message);
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new CliError('The sign-in service did not answer in 20 seconds. Try again.');
    }
    throw error;
  }
  if (!next) throw new CliError('Your sign-in expired. Run onebrain login.');
  return next;
}

/**
 * A fetch that, on a 401, refreshes the stored login once and repeats the request with the new
 * token. Requests running at the same time share one refresh. If the new token is refused too,
 * nothing is refreshed again: every later 401 comes back as it is. The refresh runs under the
 * lock shared with the Mac app, and takes a newer stored login instead of refreshing when another
 * process already did.
 */
export function refreshingFetch(
  base: typeof fetch,
  store: CredentialStore,
  initial: StoredLogin,
  lock: RefreshLockOptions,
): typeof fetch {
  let login = initial;
  let refreshing: Promise<void> | null = null;
  let refused = false;

  const renew = async (): Promise<void> => {
    login = await renewLogin(store, login.url, login.accessToken, base, lock);
  };
  const refresh = (stale: string): Promise<void> => {
    if (login.accessToken !== stale) return Promise.resolve(); // another request already did it
    refreshing ??= renew().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const sent = login.accessToken; // after a refresh, every request starts with the new token
    request.headers.set('authorization', `Bearer ${sent}`);
    const again = request.clone();
    const response = await base(request);
    if (response.status !== 401 || refused) return response;

    await refresh(sent);
    again.headers.set('authorization', `Bearer ${login.accessToken}`);
    const second = await base(again);
    if (second.status === 401) refused = true;
    return second;
  }) as typeof fetch;
}

/**
 * The login the store holds for this server, or null. A Mac keychain that would not say is not
 * "Not signed in": the CLI ends with 1 and the store's own sentence.
 */
export async function storedLogin(
  store: CredentialStore,
  url: string,
): Promise<StoredLogin | null> {
  try {
    return await store.load(url);
  } catch (error) {
    throw error instanceof KeychainRefused ? new CliError(error.message) : error;
  }
}

export type GetClientOptions = {
  /** The global --workspace flag. */
  workspace?: string | null;
  /** Default true; false returns workspace '' when none is chosen. */
  needWorkspace?: boolean;
  env?: Record<string, string | undefined>;
  home?: string;
  fetch?: typeof fetch;
};

export async function getClient(options: GetClientOptions = {}): Promise<CliClient> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const fetchFn = options.fetch ?? fetch;
  const needWorkspace = options.needWorkspace ?? true;
  const url = apiUrl(env, home);

  const agentKey = env.ONEBRAIN_API_KEY;
  if (agentKey) {
    const api = connect(url, agentKey, options.fetch);
    if (!needWorkspace) return { api, workspace: '' };
    const me = unwrap(await api.GET('/v1/me'));
    const slug = me.currentWorkspace?.slug;
    if (!slug) throw new CliError('This agent key has no workspace.');
    if (options.workspace && options.workspace !== slug) {
      throw new CliError(`This agent key belongs to workspace ${slug}.`, 2);
    }
    return { api, workspace: slug };
  }

  let token = env.ONEBRAIN_TOKEN;
  let sendWith = options.fetch;
  if (!token) {
    const store = createCredentialStore({ home, env });
    let login = await storedLogin(store, url);
    if (login && new Date(login.expiresAt).getTime() - Date.now() < 60_000) {
      login = await renewLogin(store, url, login.accessToken, fetchFn, { home });
    }
    token = login?.accessToken;
    if (login) sendWith = refreshingFetch(fetchFn, store, login, { home });
  }
  if (!token) {
    throw new CliError(
      'Not signed in. Run onebrain login, or set ONEBRAIN_API_KEY or ONEBRAIN_TOKEN.',
    );
  }

  const api = connect(url, token, sendWith);
  const chosen = options.workspace || env.ONEBRAIN_WORKSPACE || readConfig(home).workspace;
  if (chosen) return { api, workspace: chosen };
  if (!needWorkspace) return { api, workspace: '' };

  const me = unwrap(await api.GET('/v1/me'));
  const slug =
    me.currentWorkspace?.slug ?? (me.workspaces.length === 1 ? me.workspaces[0]?.slug : undefined);
  if (slug) return { api, workspace: slug };
  const names = me.workspaces.map((w) => w.slug).join(', ');
  throw new CliError(
    `Choose a workspace: onebrain workspace use <slug> (you belong to: ${names || 'none'}).`,
    2,
  );
}
