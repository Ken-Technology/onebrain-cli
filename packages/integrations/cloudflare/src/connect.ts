import { createOneBrain, DEFAULT_URL, type OneBrain } from '@useonebrain/sdk';

/**
 * The bindings this package reads when no option names a value: the same names as the onebrain CLI.
 * Pass the agent's `this.env`. Each is read when it is first needed, never at import or
 * construction, so a build without secrets works.
 */
export type OneBrainEnv = {
  ONEBRAIN_URL?: string;
  ONEBRAIN_API_KEY?: string;
  ONEBRAIN_WORKSPACE?: string;
};

/** How to reach One Brain. Each option wins over its binding in `env`. */
export type ConnectOptions = {
  /** The Worker's bindings, usually `this.env`: ONEBRAIN_URL, ONEBRAIN_API_KEY, ONEBRAIN_WORKSPACE. */
  env?: OneBrainEnv;
  /** The API's base URL. Default: env ONEBRAIN_URL, else https://api.useonebrain.com. */
  url?: string;
  /**
   * A workspace agent key (`ob_...`) or a person's OAuth access token. A function is called before
   * every request, so it can hand out a fresh token. Default: env ONEBRAIN_API_KEY.
   */
  apiKey?: string | (() => string | Promise<string>);
  /** The workspace slug. Default: env ONEBRAIN_WORKSPACE, else the key's own workspace. */
  workspace?: string;
  /** The fetch to send requests with. Default: the global fetch. */
  fetch?: typeof globalThis.fetch;
};

const present = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The base URL, without a trailing slash. */
export function urlOf(options: ConnectOptions): string {
  return (present(options.url) ?? present(options.env?.ONEBRAIN_URL) ?? DEFAULT_URL).replace(
    /\/+$/,
    '',
  );
}

/** The key or token to send now, or undefined when there is none. */
export async function keyOf(options: ConnectOptions): Promise<string | undefined> {
  const key = typeof options.apiKey === 'function' ? await options.apiKey() : options.apiKey;
  return present(key) ?? present(options.env?.ONEBRAIN_API_KEY);
}

/**
 * A One Brain client made on first use, so the bindings are read then and not before. With no key
 * in the options or the bindings, the SDK falls back to the process's environment variables where
 * there are any, and refuses with `no_api_key` otherwise.
 */
export function lazyBrain(options: ConnectOptions): () => OneBrain {
  let brain: OneBrain | undefined;
  return () => {
    if (brain) return brain;
    const workspace = present(options.workspace) ?? present(options.env?.ONEBRAIN_WORKSPACE);
    const hasKey = options.apiKey !== undefined || present(options.env?.ONEBRAIN_API_KEY);
    brain = createOneBrain({
      url: urlOf(options),
      ...(hasKey ? { apiKey: async () => (await keyOf(options)) ?? '' } : {}),
      ...(workspace ? { workspace } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return brain;
  };
}

/**
 * Who is asking, as a hash: the URL, the workspace and the key. Caches are keyed by it, so what one
 * key may see is never served to another. The key itself is kept nowhere.
 */
export async function identityOf(options: ConnectOptions): Promise<string> {
  const workspace = present(options.workspace) ?? present(options.env?.ONEBRAIN_WORKSPACE) ?? '';
  const key = (await keyOf(options)) ?? '';
  const bytes = new TextEncoder().encode(`${urlOf(options)}\n${workspace}\n${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A Durable Object's storage, as much of it as this package uses. */
export type AgentStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
};

/**
 * The agent's Durable Object storage, or null when it has none. An Agent keeps it in `ctx`, which is
 * protected, so the public types here leave it out and it is read at run time.
 */
export function storageOf(agent: object): AgentStorage | null {
  const storage = (agent as { ctx?: { storage?: Partial<AgentStorage> } }).ctx?.storage;
  if (typeof storage?.get !== 'function' || typeof storage.put !== 'function') return null;
  return storage as AgentStorage;
}
