import {
  codeOf,
  errorBody,
  errorOf,
  type OneBrainError,
  type Reply,
  retryAfterOf,
} from './errors.ts';
import type { components } from './schema.ts';

type Source = components['schemas']['Source'];

/** Which part of a session a post carries. */
export type Part = { n: number; of: number };
/** Posts the whole session, or with `part` one part of it, as its own source. */
export type PostSource = (content: Uint8Array, part?: Part) => Promise<Reply<Source>>;

/** What happened to one part of a session over the cap (`maxBytes`), as it happens. */
export type PartOutcome = { part: Part; bytes: number; maxBytes: number } & (
  | { stored: Source }
  | { refused: OneBrainError }
  | { rateLimited: OneBrainError }
);

/**
 * What uploadSession did. `whole`: the server answered the whole session with something other than
 * "too large", success or not. `parts`: it was over the largest source the server stores
 * (`maxBytes`), so it was sent in parts.
 */
export type UploadOutcome =
  | { whole: Reply<Source> }
  | {
      maxBytes: number;
      /** Every part, in order. */
      parts: number;
      stored: Source[];
      /** How many of the stored parts had been stored before. */
      duplicates: number;
      refused: { part: Part; bytes: number; error: OneBrainError }[];
      /** The part a second 429 stopped at, and that 429; the parts from it on were not sent. */
      rateLimited: { part: Part; error: OneBrainError } | null;
      notSent: number;
    };

/** The largest source the server stores, from a 413 source_too_large; else null. */
function capFrom(reply: Reply): number | null {
  const error = errorBody(reply);
  return reply.response.status === 413 &&
    error.code === 'source_too_large' &&
    typeof error.maxBytes === 'number'
    ? error.maxBytes
    : null;
}

/**
 * The cap when the server refused the whole session as too large, else null. A 413
 * source_too_large carries it. A session over the request body limit gets payload_too_large,
 * which does not: then a body of spaces half as long, and half again, asks for it. The server
 * checks the size before anything else and refuses spaces as empty, so a probe stores nothing.
 */
async function capOf(whole: Reply, size: number, post: PostSource): Promise<number | null> {
  let reply = whole;
  for (let probe = Math.floor(size / 2); probe > 0; probe = Math.floor(probe / 2)) {
    const cap = capFrom(reply);
    if (cap !== null) return cap;
    if (codeOf(reply) !== 'payload_too_large') return null;
    reply = await post(new Uint8Array(probe).fill(0x20));
    if (codeOf(reply) === 'invalid_request') return probe; // under the cap: a part this size fits
  }
  return capFrom(reply);
}

/** The byte offsets after each line end, and the end: where a session of JSON lines may be cut. */
export function lineEnds(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  for (let at = 0; at < bytes.length; ) {
    const newline = bytes.indexOf(0x0a, at);
    at = newline === -1 ? bytes.length : newline + 1;
    ends.push(at);
  }
  return ends;
}

/**
 * The session in parts of at most `maxBytes` bytes, each cut only at one of `ends` (increasing
 * byte offsets where a message ends; by default after each line end, as for a transcript of one
 * JSON record per line). Joined, the parts give back the session byte for byte. A message longer
 * than `maxBytes` is a part of its own.
 */
export function splitSession(
  bytes: Uint8Array,
  maxBytes: number,
  ends: readonly number[] = lineEnds(bytes),
): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0; // where the current part starts
  let end = 0; // where its last whole message ends
  for (const next of [...ends, bytes.length]) {
    if (next <= end || next > bytes.length) continue;
    if (next - start > maxBytes && end > start) {
      parts.push(bytes.subarray(start, end));
      start = end;
    }
    end = next;
  }
  if (end > start) parts.push(bytes.subarray(start, end));
  return parts;
}

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Posts a session as a source: whole first, and when that is over the largest source the server
 * stores, again in parts that fit, one after another, each its own source (`post` names its ref,
 * `<ref>#part-<n>`). On a 429 it waits for Retry-After once (1 second when none is given) and sends
 * that part again; a second 429 stops it, and the parts left are not sent. A part refused for
 * another reason is reported and the rest are still sent. `onPart` hears of each part as it is
 * answered; nothing it hears holds content.
 */
export async function uploadSession(options: {
  bytes: Uint8Array;
  post: PostSource;
  /** Where a part may end; by default after each line end. */
  ends?: readonly number[];
  onPart?: (outcome: PartOutcome) => void;
}): Promise<UploadOutcome> {
  const { bytes, post } = options;
  const whole = await post(bytes);
  const maxBytes = await capOf(whole, bytes.length, post);
  if (maxBytes === null) return { whole };

  const parts = splitSession(bytes, maxBytes, options.ends);
  const stored: Source[] = [];
  const refused: { part: Part; bytes: number; error: OneBrainError }[] = [];
  let duplicates = 0;
  let waited = false;
  let rateLimited: { part: Part; error: OneBrainError } | null = null;
  for (const [index, content] of parts.entries()) {
    const part = { n: index + 1, of: parts.length };
    const about = { part, bytes: content.length, maxBytes };
    let reply = await post(content, part);
    if (reply.response.status === 429 && !waited) {
      waited = true;
      await wait(retryAfterOf(reply) ?? 1);
      reply = await post(content, part);
    }
    if (reply.response.status === 429) {
      rateLimited = { part, error: errorOf(reply) };
      options.onPart?.({ ...about, rateLimited: rateLimited.error });
      break;
    }
    if (reply.data && reply.response.ok) {
      stored.push(reply.data);
      if (reply.data.duplicate) duplicates += 1;
      options.onPart?.({ ...about, stored: reply.data });
      continue;
    }
    const error = errorOf(reply);
    refused.push({ part, bytes: content.length, error });
    options.onPart?.({ ...about, refused: error });
  }
  return {
    maxBytes,
    parts: parts.length,
    stored,
    duplicates,
    refused,
    rateLimited,
    notSent: parts.length - stored.length - refused.length,
  };
}
