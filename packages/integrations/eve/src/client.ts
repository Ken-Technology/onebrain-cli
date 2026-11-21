import { createOneBrain, DEFAULT_URL, type OneBrain, OneBrainError } from '@useonebrain/sdk';

/** What an `apiKey` function receives: the eve session the call runs in, with its signed-in caller. */
export type OneBrainCallContext = {
  readonly session: {
    readonly id: string;
    readonly auth: {
      readonly current: {
        readonly principalId?: string;
        readonly principalType?: string;
        readonly issuer?: string;
        readonly attributes?: Readonly<Record<string, unknown>>;
      } | null;
    };
  };
};

/**
 * A workspace agent key (`ob_...`) or a person's OAuth access token. A function is called for each
 * request with the eve session, so it can hand out the token of the person the turn runs for.
 */
export type ApiKey = string | ((context: OneBrainCallContext) => string | Promise<string>);

/** How to reach One Brain. Every field is optional: each falls back to the environment. */
export type ConnectionOptions = {
  /** Default: env ONEBRAIN_API_KEY, read when a request is made, so a build needs no key. */
  apiKey?: ApiKey;
  /** Default: env ONEBRAIN_URL, else https://api.useonebrain.com. */
  url?: string;
  /** The workspace slug. Default: env ONEBRAIN_WORKSPACE, else the key's own workspace. */
  workspace?: string;
  /** The fetch to send requests with. Default: the global fetch. */
  fetch?: typeof globalThis.fetch;
};

/** An environment variable, or undefined. Never throws. */
export function env(name: string): string | undefined {
  try {
    const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The API's base URL, without a trailing slash. */
export function baseUrl(options: ConnectionOptions): string {
  return (options.url ?? env('ONEBRAIN_URL') ?? DEFAULT_URL).replace(/\/+$/, '');
}

/** The key for a request made in `context`: the option, else env ONEBRAIN_API_KEY, else a clear error. */
export async function resolveKey(
  apiKey: ApiKey | undefined,
  context: OneBrainCallContext | undefined,
): Promise<string> {
  let key: string | undefined;
  if (typeof apiKey === 'function') {
    if (context === undefined) {
      throw new OneBrainError(
        'no_api_key',
        'One Brain: apiKey is a function of the eve session, and this call has no session.',
      );
    }
    try {
      key = await apiKey(context);
    } catch (error) {
      // The function is the agent's own code, such as Vercel Connect's getToken for a person who
      // has not signed in to One Brain yet: say that it failed and why.
      throw new OneBrainError(
        'no_token',
        `One Brain: the apiKey function failed for this caller (${shortError(error)}).`,
      );
    }
  } else {
    key = apiKey ?? env('ONEBRAIN_API_KEY');
  }
  if (typeof key !== 'string' || key === '') {
    throw new OneBrainError(
      typeof apiKey === 'function' ? 'no_token' : 'no_api_key',
      typeof apiKey === 'function'
        ? 'One Brain: the apiKey function gave no key or token for this caller.'
        : 'One Brain: no key. Set ONEBRAIN_API_KEY, or pass apiKey.',
    );
  }
  return key;
}

/** The longest a recall or a capture waits on One Brain, so neither can hold a turn for long. */
export const REQUEST_TIMEOUT_MS = 15_000;

const WORKSPACES_MAX = 500;

/**
 * Makes One Brain clients for eve calls. A client per call, so each request carries the key of the
 * caller it runs for and the call's abort signal; the workspace slug is asked once per key holder
 * (GET /v1/me) and kept.
 */
export function clientFactory(options: ConnectionOptions) {
  const workspaces = new Map<string, string>();
  const holder = (context: OneBrainCallContext | undefined) => holderOf(options, context);

  return async (
    context: OneBrainCallContext | undefined,
    signal?: AbortSignal,
  ): Promise<OneBrain> => {
    const send = options.fetch;
    const base = {
      url: baseUrl(options),
      apiKey: () => resolveKey(options.apiKey, context),
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const signals = [request.signal, signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter(
          (one): one is AbortSignal => one !== undefined,
        );
        return (send ?? globalThis.fetch)(
          new Request(request, { signal: AbortSignal.any(signals) }),
        );
      },
    };
    const named = options.workspace ?? env('ONEBRAIN_WORKSPACE');
    if (named !== undefined) return createOneBrain({ ...base, workspace: named });
    const who = holder(context);
    let slug = workspaces.get(who);
    if (slug === undefined) {
      slug = await createOneBrain(base).workspace();
      if (workspaces.size >= WORKSPACES_MAX)
        workspaces.delete(workspaces.keys().next().value ?? '');
      workspaces.set(who, slug);
    }
    return createOneBrain({ ...base, workspace: slug });
  };
}

export type ClientFactory = ReturnType<typeof clientFactory>;

/**
 * Who holds the key a call uses: `key` for one fixed key, else the signed-in caller (issuer and
 * principal id), whose token the apiKey function hands out.
 */
export function holderOf(
  options: Pick<ConnectionOptions, 'apiKey'>,
  context: OneBrainCallContext | undefined,
): string {
  if (typeof options.apiKey !== 'function') return 'key';
  const current = context?.session.auth.current;
  return JSON.stringify([current?.issuer ?? null, current?.principalId ?? null]);
}

/**
 * An error thrown by the agent's own code, for a message: its name and the start of its message,
 * with anything shaped like a key or a token (a run of 24 or more key characters) cut out.
 */
function shortError(error: unknown): string {
  if (!(error instanceof Error)) return 'not an Error';
  const message = error.message
    .replace(/[A-Za-z0-9_\-.~+/=]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return message === '' ? error.name : `${error.name}: ${message}`;
}

/** A short description of an error for a log line: its code and status, never content or a key. */
export function describeError(error: unknown): string {
  if (error instanceof OneBrainError) {
    return `${error.code}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`;
  }
  if (error instanceof Error) return error.name;
  return 'unknown error';
}
