import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ApiError, type CliClient, CliError, type Io, unwrap } from '../client.ts';
import type { Collected, Memory } from './collect.ts';

export type FileCounts = { created: number; proposed: number; existing: number; failed: number };
export type MemoryCounts = {
  created: number;
  existing: number;
  failed: number;
  /** Skipped because an earlier run finished them (the progress file). */
  resumed: number;
};
export type UploadOptions = {
  concurrency?: number;
  /** How many items between progress lines (1,000; tests use less). */
  progressEvery?: number;
};
export type MemoryOptions = UploadOptions & {
  /** The API's URL: a progress file made for another server is ignored. */
  server?: string;
  /** Where finished line numbers are kept; null for none. */
  progressFile?: string | null;
  /** Ignore and replace an existing progress file. */
  restart?: boolean;
};

export const DEFAULT_CONCURRENCY = 8;
const WAITS = [1, 2, 4, 8, 16]; // seconds before retry 1 to 5, so up to six requests per item
const MAX_RETRY_AFTER = 120;
const PROGRESS_EVERY = 1000;

const sleep = (seconds: number) => new Promise<void>((done) => setTimeout(done, seconds * 1000));

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value)
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER) : null;
}

/**
 * Sends one request. A network error, a 429 and a 5xx are retried after 1, 2, 4, 8 and 16 seconds
 * (or the server's Retry-After). A 401 is what the client could not fix by refreshing, so every
 * later request would fail too: it stops the run. Other answers are returned for the caller.
 */
async function send<T extends { response: Response }>(call: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    let result: T | null = null;
    let network = '';
    try {
      result = await call();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      const cause = (error as { cause?: { code?: string } }).cause;
      network = cause?.code ?? error.message;
    }
    const status = result?.response.status ?? 0;
    if (status === 401) {
      throw new CliError(
        'The server refused the sign-in (401), so the import stopped. Run onebrain login or check ONEBRAIN_TOKEN / ONEBRAIN_API_KEY, then run it again: what is already imported is skipped.',
      );
    }
    const again = result === null || status === 429 || status >= 500;
    if (!again || retry >= WAITS.length) {
      if (result) return result;
      throw new ApiError(0, 'network_error', `cannot reach the One Brain API (${network})`);
    }
    await sleep((result ? retryAfter(result.response) : null) ?? (WAITS[retry] as number));
  }
}

/** Runs `work` on every item with `size` in flight. After a thrown error nothing new starts. */
async function pool<T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<void>,
  onSettled: (done: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  let failure: unknown;
  const lane = async () => {
    while (failure === undefined && next < items.length) {
      try {
        await work(items[next++] as T);
      } catch (error) {
        failure ??= error;
        return;
      }
      onSettled(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, size) }, lane));
  if (failure !== undefined) throw failure;
}

function reportFailure(io: Io, label: string, error: ApiError): void {
  io.stderr(`failed ${label}: ${error.code}: ${error.message}\n`);
}

/**
 * PUT files on base version 0. A conflict that names the file's current version means it is
 * already there; any other conflict (its folder moved during the write) failed.
 */
export async function uploadFiles(
  client: CliClient,
  io: Io,
  files: Collected['files'],
  options: UploadOptions = {},
): Promise<FileCounts> {
  const counts: FileCounts = { created: 0, proposed: 0, existing: 0, failed: 0 };
  await pool(
    files,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (file) => {
      try {
        const result = await send(() =>
          client.api.PUT('/v1/workspaces/{workspace}/files', {
            params: { path: { workspace: client.workspace } },
            body: {
              path: file.target,
              body: readFileSync(file.source, 'utf8'),
              baseVersion: 0,
              changeKind: 'import',
            },
          }),
        );
        unwrap(result);
        if (result.response.status === 202) counts.proposed++;
        else counts.created++;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.code === 'conflict' && typeof error.extra.currentVersion === 'number') {
          counts.existing++;
        } else {
          counts.failed++;
          reportFailure(io, file.target, error);
        }
      }
    },
    (done) => {
      if (done % (options.progressEvery ?? PROGRESS_EVERY) === 0) {
        io.stderr(
          `files: ${counts.created + counts.proposed + counts.existing + counts.failed} done, ${counts.created + counts.proposed} created, ${counts.existing} already there, ${counts.failed} failed\n`,
        );
      }
    },
  );
  return counts;
}

/** The line numbers a progress file holds for this server, workspace and folder; none for another header. */
function readProgress(file: string, header: string): Set<number> {
  const done = new Set<number>();
  if (!existsSync(file)) return done;
  const [first, ...rest] = readFileSync(file, 'utf8').split('\n');
  if (first !== header) return done;
  for (const line of rest) if (/^\d+$/.test(line)) done.add(Number(line));
  return done;
}

/**
 * POST memories with the ken-brain id as the source ref. The API returns the existing memory with
 * 200 but still writes an audit row for it, so a rerun skips the lines the progress file lists.
 * A line counts as done when its memory was created or was already there.
 */
export async function uploadMemories(
  client: CliClient,
  io: Io,
  memories: Memory[],
  into: string,
  options: MemoryOptions = {},
): Promise<MemoryCounts> {
  const counts: MemoryCounts = { created: 0, existing: 0, failed: 0, resumed: 0 };
  const file = options.progressFile ?? null;
  const header = `# ${options.server ?? ''} ${client.workspace} ${into}`;
  const before = file && !options.restart ? readProgress(file, header) : new Set<number>();
  const todo = memories.filter((memory) => !before.has(memory.line));
  counts.resumed = memories.length - todo.length;
  if (file && counts.resumed > 0) {
    io.stderr(
      `Skipping ${counts.resumed} memories done in an earlier run (${file}). Pass --restart to import them again.\n`,
    );
  }

  let writable = file !== null;
  const finished: number[] = [];
  const giveUp = () => {
    writable = false;
    io.stderr(`cannot write ${file}: a rerun will post these memories again\n`);
  };
  const flush = () => {
    if (!file || !writable || finished.length === 0) return;
    try {
      appendFileSync(file, `${finished.join('\n')}\n`);
      finished.length = 0;
    } catch {
      giveUp();
    }
  };
  if (file && before.size === 0) {
    try {
      writeFileSync(file, `${header}\n`);
    } catch {
      giveUp();
    }
  }

  try {
    await pool(
      todo,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      async (memory) => {
        try {
          const result = await send(() =>
            client.api.POST('/v1/workspaces/{workspace}/memories', {
              params: { path: { workspace: client.workspace } },
              body: {
                text: memory.text,
                folder: into,
                source: { kind: 'import', ref: memory.id },
                ...(memory.createdAt ? { validFrom: memory.createdAt } : {}),
              },
            }),
          );
          unwrap(result);
          if (result.response.status === 200) counts.existing++;
          else counts.created++;
          finished.push(memory.line);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          counts.failed++;
          reportFailure(io, `memory ${memory.id}`, error);
        }
      },
      (done) => {
        if (done % (options.progressEvery ?? PROGRESS_EVERY) === 0) {
          flush();
          io.stderr(
            `memories: ${counts.created + counts.existing + counts.failed} done, ${counts.created} created, ${counts.existing} already there, ${counts.failed} failed\n`,
          );
        }
      },
    );
  } finally {
    flush();
  }
  return counts;
}
