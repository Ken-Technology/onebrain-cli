import { parseArgs } from 'node:util';
import type { components } from '@useonebrain/sdk';
import { ApiError, CliError, type Io, unwrap } from '../../client.ts';
import { pick, table, usage } from './shared.ts';

type LoopSettings = components['schemas']['LoopSettings'];
type LoopStatus = components['schemas']['LoopStatus'];

export const USAGE = `Usage: onebrain admin loop status [--json]
       onebrain admin loop on [--endpoint <name>] [--mode batch|direct] --cap <cents> [--key-stdin] [--json]
       onebrain admin loop off [--json]
       onebrain admin loop set [--endpoint <name>|default] [--mode batch|direct] [--cap <cents>] [--key-stdin] [--clear-key] [--json]
       onebrain admin loop run [--sources-since <YYYY-MM-DD>] [--json]
       onebrain admin loop lock <path> [--json]
       onebrain admin loop unlock <path>

The learning loop reads captured sessions into memories and drafts changes for review. Admins only.
status shows the settings and this month's numbers. --endpoint is a name from the server's list
(status shows them); default is the server's default chain. --cap is the month's limit in cents;
on needs one unless one is saved. --key-stdin reads the workspace's own key for the endpoint from
standard input; --clear-key removes it. run starts the first pass, or with --sources-since queues
the sources captured since that date. lock keeps the loop away from a file or a folder and
everything under it: no targets, no drafts, and its pending proposals there are superseded at its
next run. unlock lets it back in. --json prints the response body; for status, both bodies
under settings and status.`;

const MODES = ['batch', 'direct'] as const;
const MAX_CAP_CENTS = 10_000_000;
const MAX_KEY_CHARS = 500;
const ENDPOINT_NAME = /^[a-z0-9-]{1,40}$/;

/** What to type next, for the 400 answers an admin can fix from here. Keyed by the API's message. */
const HINTS = new Map([
  ['Set a monthly cap to switch the loop on', 'Add --cap <cents>.'],
  [
    "That endpoint is not on this server's list",
    'onebrain admin loop status lists the endpoints this server has.',
  ],
  [
    'No model endpoint on this server has a key',
    'Name an endpoint and give its key: --endpoint <name> --key-stdin.',
  ],
  ['A key needs an endpoint: name the endpoint it is for', 'Add --endpoint <name>.'],
  [
    'The loop is off for this workspace',
    'Switch it on first: onebrain admin loop on --cap <cents>.',
  ],
]);

/** The text as a sentence: a full stop at the end unless it has one. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Plain words for the answers an admin can act on, exit 1 like every API answer: a 400 keeps the
 * API's sentence and says what to type next, a 403 says who may manage the loop, a 409 says how to
 * free the agent name the loop needs. Anything else goes up as it is.
 */
function plain(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 403) {
    return new CliError(
      'Only a workspace admin can manage the learning loop, signed in as a person (onebrain login), not with an agent key.',
    );
  }
  if (error.status === 409) {
    return new CliError(
      `${sentence(error.message)} The loop needs that name for its own agent: delete the other one (onebrain admin agents delete one-brain), then run this command again.`,
    );
  }
  if (error.status === 400) {
    const hint = HINTS.get(error.message);
    return new CliError(hint ? `${sentence(error.message)} ${hint}` : sentence(error.message));
  }
  return error;
}

/** --cap as whole cents from 0 to 10,000,000, or a usage error. */
function readCap(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,8}$/.test(value) || Number(value) > MAX_CAP_CENTS) {
    throw new CliError(`--cap is a whole number of cents, from 0 to ${MAX_CAP_CENTS}.`, 2);
  }
  return Number(value);
}

/** --endpoint as a name from the server's list, or null for default: the server's default chain. */
function readEndpoint(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === 'default') return null;
  if (!ENDPOINT_NAME.test(value)) {
    throw new CliError(
      "--endpoint is a name from the server's list (onebrain admin loop status shows them), or default.",
      2,
    );
  }
  return value;
}

/** The workspace's own key, from standard input only. It is never printed. */
async function readKey(io: Io): Promise<string> {
  const key = ((await io.readStdin()) ?? '').trim();
  if (!key) throw new CliError('--key-stdin: give the key on stdin.', 2);
  if (key.length > MAX_KEY_CHARS) {
    throw new CliError(`--key-stdin: the key is longer than ${MAX_KEY_CHARS} characters.`, 2);
  }
  return key;
}

/** --sources-since as a real calendar day, YYYY-MM-DD. The value is not echoed back. */
function readDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  // new Date rolls 2026-02-30 over to 2 March, so the day must come back as it was given.
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new CliError('--sources-since takes a date as YYYY-MM-DD, such as 2026-11-01.', 2);
  }
  return value;
}

/** One line about the saved settings, as on, off and set print it. */
function summary(saved: LoopSettings): string {
  const cap = saved.monthlyCapCents === null ? 'no cap' : `cap ${saved.monthlyCapCents} cents`;
  const key = saved.hasKey ? '  own key' : '';
  return `${saved.enabled ? 'on' : 'off'}  ${saved.mode}  ${saved.endpoint ?? 'default chain'}  ${cap}${key}\n`;
}

/** Cents with at most two decimals: 12.5, 3.46, 0. */
const cents = (value: number) => String(Math.round(value * 100) / 100);

/** Why nothing runs, in plain words. A saved endpoint the server no longer lists counts too. */
function pausedWhy(settings: LoopSettings, status: LoopStatus): string {
  const { endpoint } = settings;
  if (status.enabled && endpoint !== null && !settings.endpoints.some((e) => e.name === endpoint)) {
    return `yes: the endpoint ${endpoint} is not on this server's list any more. Run: onebrain admin loop set --endpoint default`;
  }
  if (status.paused === 'cap') {
    return "yes: this month's estimated cost reached the cap. Raise it: onebrain admin loop set --cap <cents>";
  }
  if (status.paused === 'endpoint') {
    return 'yes: the model endpoint is not answering. The loop tries again by itself';
  }
  return 'no';
}

/** The status table: one row per setting and per number of this month, the last run last. */
function statusTable(settings: LoopSettings, status: LoopStatus): string {
  const { usage: used, monthlyCapCents: cap, lastRun } = status;
  const chain = settings.defaultChain.join(', ') || 'empty on this server';
  const endpoint =
    settings.endpoint === null
      ? `default chain (${chain})`
      : `${settings.endpoint}${settings.hasKey ? ", with the workspace's own key" : ''}`;
  const listed = settings.endpoints.map((e) =>
    e.hasServerKey ? e.name : `${e.name} (no server key)`,
  );
  const share = cap !== null && cap > 0 ? ` (${Math.floor((used.costCents / cap) * 100)}%)` : '';
  const spent =
    cap === null
      ? `about ${cents(used.costCents)} cents this month, no cap set`
      : `about ${cents(used.costCents)} of ${cap} cents this month${share}`;
  // The estimate of the batches not closed yet counts against the cap too: without it an admin
  // sees "paused: cap" with the spend well under the cap and no reason.
  const cost =
    used.inFlightCents > 0
      ? `${spent}, plus about ${cents(used.inFlightCents)} cents for batches still running`
      : spent;
  const firstPass = lastRun?.kind === 'first_pass';
  const last =
    lastRun === null
      ? 'none yet'
      : `${firstPass ? 'first pass' : 'older sources'} on ${lastRun.at.slice(0, 10)} ${lastRun.at.slice(11, 16)} UTC, ${lastRun.queued} ${firstPass ? 'drafts' : 'sources'} queued`;
  return table([
    ['loop', status.enabled ? 'on' : 'off'],
    ['paused', pausedWhy(settings, status)],
    ['mode', settings.mode],
    ['endpoint', endpoint],
    ['server endpoints', listed.join(', ') || 'none'],
    ['sources waiting', String(status.sourcesWaiting)],
    ['memories', `${status.memoriesThisMonth} this month`],
    [
      'proposals',
      `${status.proposals.pending} pending, ${status.proposals.applied} applied this month`,
    ],
    ['pages read', `${used.pagesRead} this month (${used.charsRead} characters)`],
    ['calls', `${used.calls} this month`],
    [
      'tokens',
      `${used.inputTokens} in (${used.cachedTokens} cached), ${used.outputTokens} out this month`,
    ],
    ['cost', cost],
    ['last run', last],
  ]);
}

/**
 * onebrain admin loop: an admin's switch, settings, status, run and locks for the learning loop.
 * Exit codes: 0 done; 2 for a usage mistake; 1 for an answer of the API, in plain words. The key
 * is read from stdin only, never from a flag, and never printed.
 */
export async function run(args: string[], io: Io): Promise<number> {
  try {
    return await act(args, io);
  } catch (error) {
    throw plain(error);
  }
}

async function act(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      endpoint: { type: 'string' },
      mode: { type: 'string' },
      cap: { type: 'string' },
      'key-stdin': { type: 'boolean' },
      'clear-key': { type: 'boolean' },
      'sources-since': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const [action, ...extra] = positionals;
  // lock and unlock take one path; every other action takes none.
  const takes = action === 'lock' || action === 'unlock' ? 1 : 0;
  if (extra.length !== takes) return usage(io, USAGE);
  const print = (body: unknown, text: string) =>
    io.stdout(values.json ? `${JSON.stringify(body, null, 2)}\n` : text);

  if (action === 'status') {
    const { api, workspace } = await io.client();
    const params = { path: { workspace } };
    const settings = unwrap(await api.GET('/v1/workspaces/{workspace}/loop/settings', { params }));
    const status = unwrap(await api.GET('/v1/workspaces/{workspace}/loop/status', { params }));
    print({ settings, status }, statusTable(settings, status));
    return 0;
  }

  if (action === 'on') {
    const cap = readCap(values.cap);
    const endpoint = readEndpoint(values.endpoint);
    const mode = pick(values.mode, MODES, '--mode');
    const key = values['key-stdin'] ? await readKey(io) : undefined;
    const { api, workspace } = await io.client();
    const params = { path: { workspace } };
    if (cap === undefined) {
      const saved = unwrap(await api.GET('/v1/workspaces/{workspace}/loop/settings', { params }));
      if (saved.monthlyCapCents === null) {
        throw new CliError('Set a monthly cap to switch the loop on: --cap <cents>.', 2);
      }
    }
    const saved = unwrap(
      await api.PUT('/v1/workspaces/{workspace}/loop/settings', {
        params,
        body: {
          enabled: true,
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(mode ? { mode } : {}),
          ...(cap !== undefined ? { monthlyCapCents: cap } : {}),
          ...(key ? { key } : {}),
        },
      }),
    );
    print(saved, summary(saved));
    return 0;
  }

  if (action === 'off') {
    const { api, workspace } = await io.client();
    const saved = unwrap(
      await api.PUT('/v1/workspaces/{workspace}/loop/settings', {
        params: { path: { workspace } },
        body: { enabled: false },
      }),
    );
    print(saved, summary(saved));
    return 0;
  }

  if (action === 'set') {
    const endpoint = readEndpoint(values.endpoint);
    const mode = pick(values.mode, MODES, '--mode');
    const cap = readCap(values.cap);
    if (values['key-stdin'] && values['clear-key']) {
      throw new CliError('Give --key-stdin or --clear-key, not both.', 2);
    }
    if (values['key-stdin'] && endpoint === null) {
      throw new CliError(
        'A key is for one endpoint: name it with --endpoint <name>, not default.',
        2,
      );
    }
    const key = values['key-stdin'] ? await readKey(io) : values['clear-key'] ? null : undefined;
    const body = {
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(mode ? { mode } : {}),
      ...(cap !== undefined ? { monthlyCapCents: cap } : {}),
      ...(key !== undefined ? { key } : {}),
    };
    if (Object.keys(body).length === 0) {
      throw new CliError(
        'set needs at least one of --endpoint, --mode, --cap, --key-stdin or --clear-key.',
        2,
      );
    }
    const { api, workspace } = await io.client();
    const saved = unwrap(
      await api.PUT('/v1/workspaces/{workspace}/loop/settings', {
        params: { path: { workspace } },
        body,
      }),
    );
    print(saved, summary(saved));
    return 0;
  }

  if (action === 'run') {
    const sourcesSince = readDate(values['sources-since']);
    const { api, workspace } = await io.client();
    const started = unwrap(
      await api.POST('/v1/workspaces/{workspace}/loop/run', {
        params: { path: { workspace } },
        body: sourcesSince ? { sourcesSince } : {},
      }),
    );
    print(started, 'started\n');
    const what = sourcesSince
      ? `The sources captured since ${sourcesSince} are being queued`
      : 'The first pass is running';
    io.stderr(
      `${what} in the worker. onebrain admin loop status shows what it did on its "last run" line.\n`,
    );
    return 0;
  }

  if (action === 'lock') {
    const { api, workspace } = await io.client();
    const locked = unwrap(
      await api.POST('/v1/workspaces/{workspace}/loop/locks', {
        params: { path: { workspace } },
        body: { path: extra[0] as string },
      }),
    );
    print(locked, `locked ${locked.path}\n`);
    return 0;
  }

  if (action === 'unlock') {
    const path = extra[0] as string;
    const { api, workspace } = await io.client();
    unwrap(
      await api.DELETE('/v1/workspaces/{workspace}/loop/locks', {
        params: { path: { workspace }, query: { path } },
      }),
    );
    // 204: no body to print, with --json or without.
    io.stdout(`unlocked ${path}\n`);
    return 0;
  }

  return usage(io, USAGE);
}
