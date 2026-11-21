/** What an openapi-fetch call resolves with: the parsed body on success, the parsed error body otherwise. */
export type Reply<T = unknown> = { data?: T; error?: unknown; response: Response };

/**
 * An answer of the One Brain API that is not a success, or a request the client could not make.
 * `code` is the API's own error code (`not_found`, `conflict`, `too_many_requests`,
 * `source_too_large`, ...), else `http_<status>`. `details` holds the error's other fields as the
 * API sent them, such as `currentVersion` on a conflict or `maxBytes` on `source_too_large`.
 * `retryAfter` is in seconds, from the Retry-After header or the body's `retryAfterSeconds`.
 *
 * The message is the API's own, or one written here; it never holds the key, a token or content.
 */
export class OneBrainError extends Error {
  readonly code: string;
  /** The HTTP status; 0 when no request was made (no key, no workspace). */
  readonly status: number;
  readonly retryAfter: number | undefined;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryAfter?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'OneBrainError';
    this.code = code;
    this.status = options.status ?? 0;
    this.retryAfter = options.retryAfter;
    this.details = options.details ?? {};
  }
}

/** The `error` object of an API error body, `{ error: { code, message, ...details } }`; else {}. */
export function errorBody(reply: Reply): Record<string, unknown> {
  const body = reply.error as { error?: unknown } | undefined;
  const inner = body?.error;
  return typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : {};
}

/** The API's error code of a reply, else `http_<status>`. */
export function codeOf(reply: Reply): string {
  const code = errorBody(reply).code;
  return typeof code === 'string' ? code : `http_${reply.response.status}`;
}

/** Seconds to wait from Retry-After, else the body's retryAfterSeconds; undefined when neither says. */
export function retryAfterOf(reply: Reply): number | undefined {
  for (const value of [
    reply.response.headers.get('retry-after'),
    errorBody(reply).retryAfterSeconds,
  ]) {
    if (value === null || value === undefined || value === '') continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  return undefined;
}

/** The OneBrainError of a reply that is not a success. */
export function errorOf(reply: Reply): OneBrainError {
  const { code: _code, message, ...details } = errorBody(reply);
  const retryAfter = retryAfterOf(reply);
  return new OneBrainError(
    codeOf(reply),
    typeof message === 'string' && message !== ''
      ? message
      : `The One Brain API answered ${reply.response.status}`,
    {
      status: reply.response.status,
      details,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    },
  );
}

/** The body of a successful reply; a OneBrainError otherwise. */
export function unwrap<T>(reply: Reply<T>): T {
  if (reply.error === undefined && reply.response.ok) return reply.data as T;
  throw errorOf(reply);
}
