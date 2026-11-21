import { describe, expect, it } from 'vitest';
import admin from '../src/commands/admin.ts';
import { main } from '../src/index.ts';
import { fakeApi, testIo } from './helpers.ts';

const ROUTE = '/v1/workspaces/kenso/loop/settings';
// Built at run time: never a key-shaped literal in a file.
const KEY = ['typed', 'model', 'key'].join('-');
const settings = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  mode: 'batch',
  endpoint: null,
  hasKey: false,
  monthlyCapCents: null,
  pausedReason: null,
  endpoints: [],
  defaultChain: ['fake'],
  ...over,
});
const api = (saved = settings()) =>
  fakeApi({
    [`GET ${ROUTE}`]: () => ({ body: saved }),
    [`PUT ${ROUTE}`]: (call) => {
      // As the API answers: the key is write only.
      const { key, ...rest } = call.body as Record<string, unknown>;
      return { body: { ...saved, ...rest, hasKey: key !== undefined } };
    },
  });
const puts = (calls: { method: string; body: unknown }[]) =>
  calls.filter((call) => call.method === 'PUT').map((call) => call.body);

describe('onebrain admin loop on', () => {
  it('exits 2 without --cap when none is saved, and changes nothing', async () => {
    const { api: client, calls } = api();
    const { io, stderr } = testIo({ api: client });
    expect(await admin.run(['loop', 'on', '--endpoint', 'fake', '--mode', 'direct'], io)).toBe(2);
    expect(stderr()).toBe('error: Set a monthly cap to switch the loop on: --cap <cents>.\n');
    expect(puts(calls)).toEqual([]);
  });

  it('switches on with the flags it was given', async () => {
    const { api: client, calls } = api();
    const { io, stdout } = testIo({ api: client });
    expect(
      await admin.run(['loop', 'on', '--endpoint', 'fake', '--mode', 'direct', '--cap', '500'], io),
    ).toBe(0);
    expect(puts(calls)).toEqual([
      { enabled: true, endpoint: 'fake', mode: 'direct', monthlyCapCents: 500 },
    ]);
    expect(stdout()).toBe('on  direct  fake  cap 500 cents\n');
  });

  it('keeps the saved cap, endpoint and mode when the flags are left out', async () => {
    const { api: client, calls } = api(settings({ monthlyCapCents: 300 }));
    const { io, stdout } = testIo({ api: client });
    expect(await admin.run(['loop', 'on'], io)).toBe(0);
    expect(puts(calls)).toEqual([{ enabled: true }]);
    expect(stdout()).toBe('on  batch  default chain  cap 300 cents\n');
  });

  it('reads the key from stdin with --key-stdin and never prints it', async () => {
    const { api: client, calls } = api();
    const { io, stdout, stderr } = testIo({ api: client, stdin: `${KEY}\n` });
    expect(
      await admin.run(
        ['loop', 'on', '--endpoint', 'fake', '--cap', '500', '--key-stdin', '--json'],
        io,
      ),
    ).toBe(0);
    expect(puts(calls)).toEqual([
      { enabled: true, endpoint: 'fake', monthlyCapCents: 500, key: KEY },
    ]);
    expect(JSON.parse(stdout())).toMatchObject({ enabled: true, hasKey: true });
    expect(stdout() + stderr()).not.toContain(KEY);
  });

  it('exits 2 for a cap that is not a whole number of cents, an unknown mode, an empty stdin and an extra argument', async () => {
    for (const args of [
      ['--cap', '5.5'],
      ['--cap=-1'],
      ['--cap', ''],
      ['--cap', '500', '--mode', 'fast'],
      ['--cap', '500', '--key-stdin'],
      ['--cap', '500', 'now'],
    ]) {
      const { api: client, calls } = api();
      const { io } = testIo({ api: client, stdin: '' });
      expect(await admin.run(['loop', 'on', ...args], io), args.join(' ')).toBe(2);
      expect(calls).toEqual([]);
    }
  });

  it('exits 1 with the API error for a caller who is not an admin', async () => {
    const denied = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'Only a workspace admin can do this' } },
    };
    const { api: client } = fakeApi({
      [`GET ${ROUTE}`]: () => denied,
      [`PUT ${ROUTE}`]: () => denied,
    });
    const { io, stderr } = testIo({ api: client });
    expect(await main(['admin', 'loop', 'on', '--cap', '500'], io, [admin])).toBe(1);
    expect(stderr()).toBe(
      'error: Only a workspace admin can manage the learning loop, signed in as a person (onebrain login), not with an agent key.\n',
    );
  });
});

const STATUS_ROUTE = '/v1/workspaces/kenso/loop/status';
const RUN_ROUTE = '/v1/workspaces/kenso/loop/run';
const ENDPOINTS = [
  { name: 'fake', shape: 'openai', model: 'fake-model', batch: 'openai', hasServerKey: true },
  { name: 'luna', shape: 'openai', model: 'luna-model', batch: 'openai', hasServerKey: false },
];
/** Settings of a loop that is on, in direct mode, on the endpoint fake, with a cap of 500 cents. */
const onSettings = (over: Record<string, unknown> = {}) =>
  settings({
    enabled: true,
    mode: 'direct',
    endpoint: 'fake',
    monthlyCapCents: 500,
    endpoints: ENDPOINTS,
    ...over,
  });
const USED = {
  calls: 57,
  charsRead: 123000,
  pagesRead: 41,
  inputTokens: 40000,
  cachedTokens: 1200,
  outputTokens: 3000,
  costCents: 12.5,
};
const loopStatus = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  paused: null,
  sourcesWaiting: 3,
  memoriesThisMonth: 12,
  proposals: { pending: 2, applied: 5 },
  usage: USED,
  monthlyCapCents: 500,
  lastRun: { at: '2026-11-14T10:05:00.000Z', kind: 'first_pass', queued: 20 },
  ...over,
});
/** Answers like the API: PUT merges the body and never sends the key back; hasKey follows it. */
const loopApi = (
  saved: Record<string, unknown> = onSettings(),
  status: Record<string, unknown> = loopStatus(),
) =>
  fakeApi({
    [`GET ${ROUTE}`]: () => ({ body: saved }),
    [`PUT ${ROUTE}`]: (call) => {
      const { key, ...rest } = call.body as { key?: string | null };
      return {
        body: { ...saved, ...rest, hasKey: key === undefined ? saved.hasKey : key !== null },
      };
    },
    [`GET ${STATUS_ROUTE}`]: () => ({ body: status }),
    [`POST ${RUN_ROUTE}`]: () => ({ body: { started: true } }),
  });
/** Lines of the status table: the label column is as wide as "server endpoints" plus two spaces. */
const rows = (pairs: [string, string][]) =>
  pairs.map(([label, value]) => `${label.padEnd(18)}${value}\n`).join('');
const paths = (calls: { method: string; path: string }[]) =>
  calls.map((call) => `${call.method} ${call.path}`);
const ADMIN_ONLY =
  'error: Only a workspace admin can manage the learning loop, signed in as a person (onebrain login), not with an agent key.\n';

describe('onebrain admin loop status', () => {
  it("prints the settings and this month's numbers, one row each, the last run on its own line", async () => {
    const { api: client, calls } = loopApi();
    const { io, stdout } = testIo({ api: client });
    expect(await admin.run(['loop', 'status'], io)).toBe(0);
    expect(paths(calls)).toEqual([`GET ${ROUTE}`, `GET ${STATUS_ROUTE}`]);
    expect(stdout()).toBe(
      rows([
        ['loop', 'on'],
        ['paused', 'no'],
        ['mode', 'direct'],
        ['endpoint', 'fake'],
        ['server endpoints', 'fake, luna (no server key)'],
        ['sources waiting', '3'],
        ['memories', '12 this month'],
        ['proposals', '2 pending, 5 applied this month'],
        ['pages read', '41 this month (123000 characters)'],
        ['calls', '57 this month'],
        ['tokens', '40000 in (1200 cached), 3000 out this month'],
        ['cost', 'about 12.5 of 500 cents this month (2%)'],
        ['last run', 'first pass on 2026-11-14 10:05 UTC, 20 drafts queued'],
      ]),
    );
  });

  it('says in plain words why the loop is paused, an endpoint gone from the list included', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [
        {},
        { paused: 'cap' },
        "yes: this month's estimated cost reached the cap. Raise it: onebrain admin loop set --cap <cents>",
      ],
      [
        {},
        { paused: 'endpoint' },
        'yes: the model endpoint is not answering. The loop tries again by itself',
      ],
      [
        { endpoint: 'gone' },
        {},
        "yes: the endpoint gone is not on this server's list any more. Run: onebrain admin loop set --endpoint default",
      ],
      [{ endpoint: 'gone', enabled: false }, { enabled: false }, 'no'],
    ];
    for (const [saved, status, paused] of cases) {
      const { api: client } = loopApi(onSettings(saved), loopStatus(status));
      const { io, stdout } = testIo({ api: client });
      expect(await admin.run(['loop', 'status'], io)).toBe(0);
      expect(stdout()).toContain(rows([['paused', paused]]));
    }
  });

  it("names the default chain or the workspace's own key, the cost without a cap, and a run of older sources", async () => {
    const chain = loopApi(
      onSettings({ endpoint: null, defaultChain: ['fake', 'luna'] }),
      loopStatus({
        monthlyCapCents: null,
        usage: { ...USED, costCents: 3.456 },
        lastRun: { at: '2026-11-13T23:59:59.000Z', kind: 'old_sources', queued: 7 },
      }),
    );
    const t = testIo({ api: chain.api });
    expect(await admin.run(['loop', 'status'], t.io)).toBe(0);
    expect(t.stdout()).toContain(rows([['endpoint', 'default chain (fake, luna)']]));
    expect(t.stdout()).toContain(rows([['cost', 'about 3.46 cents this month, no cap set']]));
    expect(t.stdout()).toContain(
      rows([['last run', 'older sources on 2026-11-13 23:59 UTC, 7 sources queued']]),
    );

    const empty = loopApi(onSettings({ endpoint: null, defaultChain: [] }));
    const e = testIo({ api: empty.api });
    expect(await admin.run(['loop', 'status'], e.io)).toBe(0);
    expect(e.stdout()).toContain(rows([['endpoint', 'default chain (empty on this server)']]));

    const own = loopApi(
      onSettings({ hasKey: true, endpoints: [] }),
      loopStatus({ lastRun: null, monthlyCapCents: 0 }),
    );
    const o = testIo({ api: own.api });
    expect(await admin.run(['loop', 'status'], o.io)).toBe(0);
    expect(o.stdout()).toContain(rows([['endpoint', "fake, with the workspace's own key"]]));
    expect(o.stdout()).toContain(rows([['server endpoints', 'none']]));
    expect(o.stdout()).toContain(rows([['cost', 'about 12.5 of 0 cents this month']]));
    expect(o.stdout()).toContain(rows([['last run', 'none yet']]));
  });

  it('shows the money held for batches still running beside the spend, and nothing when there is none', async () => {
    const held = loopApi(
      onSettings({ mode: 'batch' }),
      loopStatus({ paused: 'cap', usage: { ...USED, inFlightCents: 488 } }),
    );
    const h = testIo({ api: held.api });
    expect(await admin.run(['loop', 'status'], h.io)).toBe(0);
    expect(h.stdout()).toContain(
      rows([
        [
          'cost',
          'about 12.5 of 500 cents this month (2%), plus about 488 cents for batches still running',
        ],
      ]),
    );
    const uncapped = loopApi(
      onSettings(),
      loopStatus({ monthlyCapCents: null, usage: { ...USED, inFlightCents: 0.5 } }),
    );
    const u = testIo({ api: uncapped.api });
    expect(await admin.run(['loop', 'status'], u.io)).toBe(0);
    expect(u.stdout()).toContain(
      rows([
        [
          'cost',
          'about 12.5 cents this month, no cap set, plus about 0.5 cents for batches still running',
        ],
      ]),
    );
    const none = loopApi(onSettings(), loopStatus({ usage: { ...USED, inFlightCents: 0 } }));
    const n = testIo({ api: none.api });
    expect(await admin.run(['loop', 'status'], n.io)).toBe(0);
    expect(n.stdout()).toContain(rows([['cost', 'about 12.5 of 500 cents this month (2%)']]));
  });

  it('--json prints both bodies, under settings and status', async () => {
    const { api: client } = loopApi();
    const { io, stdout } = testIo({ api: client });
    expect(await admin.run(['loop', 'status', '--json'], io)).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ settings: onSettings(), status: loopStatus() });
  });

  it('exits 2 for an extra argument and calls nothing', async () => {
    const { api: client, calls } = loopApi();
    expect(await admin.run(['loop', 'status', 'now'], testIo({ api: client }).io)).toBe(2);
    expect(await admin.run(['loop'], testIo({ api: client }).io)).toBe(2);
    expect(await admin.run(['loop', 'nope'], testIo({ api: client }).io)).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('onebrain admin loop off', () => {
  it('switches the loop off and prints the saved settings on one line', async () => {
    const { api: client, calls } = loopApi();
    const t = testIo({ api: client });
    expect(await admin.run(['loop', 'off'], t.io)).toBe(0);
    expect(puts(calls)).toEqual([{ enabled: false }]);
    expect(t.stdout()).toBe('off  direct  fake  cap 500 cents\n');
    const j = testIo({ api: client });
    expect(await admin.run(['loop', 'off', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.stdout())).toMatchObject({ enabled: false, endpoint: 'fake' });
  });

  it('exits 2 for an extra argument and calls nothing', async () => {
    const { api: client, calls } = loopApi();
    expect(await admin.run(['loop', 'off', 'now'], testIo({ api: client }).io)).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('onebrain admin loop set', () => {
  it("sends only what its flags change, and default for the server's chain", async () => {
    const cases: [string[], Record<string, unknown>][] = [
      [['--endpoint', 'luna'], { endpoint: 'luna' }],
      [['--endpoint', 'default'], { endpoint: null }],
      [['--mode', 'batch', '--cap', '0'], { mode: 'batch', monthlyCapCents: 0 }],
      [['--cap', '10000000'], { monthlyCapCents: 10_000_000 }],
      [['--clear-key'], { key: null }],
    ];
    for (const [flags, body] of cases) {
      const { api: client, calls } = loopApi();
      expect(
        await admin.run(['loop', 'set', ...flags], testIo({ api: client }).io),
        flags.join(' '),
      ).toBe(0);
      expect(puts(calls)).toEqual([body]);
    }
  });

  it('prints the saved settings on one line, or the body with --json', async () => {
    const { api: client } = loopApi(onSettings({ hasKey: true }));
    const t = testIo({ api: client });
    expect(await admin.run(['loop', 'set', '--mode', 'batch'], t.io)).toBe(0);
    expect(t.stdout()).toBe('on  batch  fake  cap 500 cents  own key\n');
    const j = testIo({ api: client });
    expect(await admin.run(['loop', 'set', '--cap', '800', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.stdout())).toMatchObject({ monthlyCapCents: 800, mode: 'direct' });
  });

  it('reads the key from stdin with --key-stdin and never prints it', async () => {
    const { api: client, calls } = loopApi(onSettings({ endpoint: 'luna' }));
    const t = testIo({ api: client, stdin: `${KEY}\n` });
    expect(await admin.run(['loop', 'set', '--key-stdin'], t.io)).toBe(0);
    expect(t.stdout()).toBe('on  direct  luna  cap 500 cents  own key\n');
    const j = testIo({ api: client, stdin: KEY });
    expect(await admin.run(['loop', 'set', '--key-stdin', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.stdout())).toMatchObject({ hasKey: true });
    expect(puts(calls)).toEqual([{ key: KEY }, { key: KEY }]);
    expect(t.stdout() + t.stderr() + j.stdout() + j.stderr()).not.toContain(KEY);
  });

  it('takes no key as an argument, and does not echo one given that way', async () => {
    const { api: client, calls } = loopApi();
    const { io, stderr } = testIo({ api: client });
    expect(await main(['admin', 'loop', 'set', `--key=${KEY}`], io, [admin])).toBe(2);
    expect(await main(['admin', 'loop', 'set', '--key', KEY], io, [admin])).toBe(2);
    expect(stderr()).toContain("Unknown option '--key'");
    expect(stderr()).not.toContain(KEY);
    expect(calls).toEqual([]);
  });

  it('exits 2 for no change, a bad value or flags that do not go together, and calls nothing', async () => {
    const NONE = 'set needs at least one of --endpoint, --mode, --cap, --key-stdin or --clear-key.';
    const CAP = '--cap is a whole number of cents, from 0 to 10000000.';
    const cases: [string[], string][] = [
      [[], NONE],
      [['--json'], NONE],
      [['--cap', '5.5'], CAP],
      [['--cap=-1'], CAP],
      [['--cap', '1e3'], CAP],
      [['--cap', '10000001'], CAP],
      [['--mode', 'fast'], '--mode must be one of: batch, direct.'],
      [
        ['--endpoint', 'Not-A-Name'],
        "--endpoint is a name from the server's list (onebrain admin loop status shows them), or default.",
      ],
      [['--key-stdin'], '--key-stdin: give the key on stdin.'],
      [['--key-stdin', '--clear-key'], 'Give --key-stdin or --clear-key, not both.'],
      [
        ['--endpoint', 'default', '--key-stdin'],
        'A key is for one endpoint: name it with --endpoint <name>, not default.',
      ],
    ];
    for (const [flags, message] of cases) {
      const { api: client, calls } = loopApi();
      const { io, stderr } = testIo({ api: client, stdin: '' });
      expect(await admin.run(['loop', 'set', ...flags], io), flags.join(' ')).toBe(2);
      expect(stderr()).toBe(`error: ${message}\n`);
      expect(calls).toEqual([]);
    }
    const last = loopApi();
    const long = testIo({ api: last.api, stdin: 'k'.repeat(501) });
    expect(await admin.run(['loop', 'set', '--key-stdin'], long.io)).toBe(2);
    expect(long.stderr()).toBe('error: --key-stdin: the key is longer than 500 characters.\n');
    expect(
      await admin.run(['loop', 'set', 'now', '--mode', 'batch'], testIo({ api: last.api }).io),
    ).toBe(2);
    expect(last.calls).toEqual([]);
  });

  it('on: default means the chain, and the cap check is the same as set', async () => {
    const { api: client, calls } = loopApi(settings());
    expect(
      await admin.run(
        ['loop', 'on', '--endpoint', 'default', '--cap', '500'],
        testIo({ api: client }).io,
      ),
    ).toBe(0);
    expect(puts(calls)).toEqual([{ enabled: true, endpoint: null, monthlyCapCents: 500 }]);
    for (const cap of ['1e3', '0x10', '10000001']) {
      const t = testIo({ api: client });
      expect(await admin.run(['loop', 'on', '--cap', cap], t.io), cap).toBe(2);
      expect(t.stderr()).toBe('error: --cap is a whole number of cents, from 0 to 10000000.\n');
    }
    expect(puts(calls)).toHaveLength(1);
  });
});

describe('onebrain admin loop run', () => {
  it('starts the first pass, and says where to see what it did', async () => {
    const { api: client, calls } = loopApi();
    const { io, stdout, stderr } = testIo({ api: client });
    expect(await admin.run(['loop', 'run'], io)).toBe(0);
    expect(paths(calls)).toEqual([`POST ${RUN_ROUTE}`]);
    expect(calls[0]?.body).toEqual({});
    expect(stdout()).toBe('started\n');
    expect(stderr()).toBe(
      'The first pass is running in the worker. onebrain admin loop status shows what it did on its "last run" line.\n',
    );
  });

  it('queues the sources since a date with --sources-since', async () => {
    const { api: client, calls } = loopApi();
    const { io, stdout, stderr } = testIo({ api: client });
    expect(await admin.run(['loop', 'run', '--sources-since', '2026-11-01', '--json'], io)).toBe(0);
    expect(calls[0]?.body).toEqual({ sourcesSince: '2026-11-01' });
    expect(JSON.parse(stdout())).toEqual({ started: true });
    expect(stderr()).toBe(
      'The sources captured since 2026-11-01 are being queued in the worker. onebrain admin loop status shows what it did on its "last run" line.\n',
    );
  });

  it('exits 2 for a date that is not a real YYYY-MM-DD, and calls nothing', async () => {
    for (const date of [
      '2026-13-01',
      '2026-02-30',
      '2026-02-29',
      '2026-11-1',
      '01/11/2026',
      'yesterday',
      '',
    ]) {
      const { api: client, calls } = loopApi();
      const { io, stderr } = testIo({ api: client });
      expect(await admin.run(['loop', 'run', '--sources-since', date], io), date).toBe(2);
      expect(stderr()).toBe(
        'error: --sources-since takes a date as YYYY-MM-DD, such as 2026-11-01.\n',
      );
      expect(calls).toEqual([]);
    }
  });
});

describe('plain words for 400, 403 and 409', () => {
  const answer = (status: number, code: string, message: string) => () => ({
    status,
    body: { error: { code, message } },
  });

  it('403: says who may manage the loop, for every action, and prints no data', async () => {
    const denied = answer(403, 'forbidden', 'Only a person can do this, not an agent');
    const { api: client } = fakeApi({
      [`GET ${ROUTE}`]: denied,
      [`PUT ${ROUTE}`]: denied,
      [`GET ${STATUS_ROUTE}`]: denied,
      [`POST ${RUN_ROUTE}`]: denied,
    });
    for (const args of [
      ['status'],
      ['status', '--json'],
      ['on', '--cap', '500'],
      ['off'],
      ['set', '--mode', 'batch'],
      ['run'],
    ]) {
      const { io, stdout, stderr } = testIo({ api: client });
      expect(await main(['admin', 'loop', ...args], io, [admin]), args.join(' ')).toBe(1);
      expect(stderr()).toBe(ADMIN_ONLY);
      expect(stdout()).toBe('');
    }
  });

  it("400: the API's sentence and what to type next", async () => {
    const cases: [string[], string, string, string][] = [
      [
        ['on', '--cap', '500'],
        `PUT ${ROUTE}`,
        'Set a monthly cap to switch the loop on',
        'Set a monthly cap to switch the loop on. Add --cap <cents>.',
      ],
      [
        ['set', '--endpoint', 'gone'],
        `PUT ${ROUTE}`,
        "That endpoint is not on this server's list",
        "That endpoint is not on this server's list. onebrain admin loop status lists the endpoints this server has.",
      ],
      [
        ['on', '--cap', '500'],
        `PUT ${ROUTE}`,
        'No model endpoint on this server has a key',
        'No model endpoint on this server has a key. Name an endpoint and give its key: --endpoint <name> --key-stdin.',
      ],
      [
        ['set', '--key-stdin'],
        `PUT ${ROUTE}`,
        'A key needs an endpoint: name the endpoint it is for',
        'A key needs an endpoint: name the endpoint it is for. Add --endpoint <name>.',
      ],
      [
        ['run'],
        `POST ${RUN_ROUTE}`,
        'The loop is off for this workspace',
        'The loop is off for this workspace. Switch it on first: onebrain admin loop on --cap <cents>.',
      ],
      [
        ['set', '--cap', '500'],
        `PUT ${ROUTE}`,
        'Something this CLI does not know.',
        'Something this CLI does not know.',
      ],
    ];
    for (const [args, route, message, said] of cases) {
      const { api: client } = fakeApi({ [route]: answer(400, 'invalid_request', message) });
      const { io, stderr } = testIo({ api: client, stdin: KEY });
      expect(await main(['admin', 'loop', ...args], io, [admin]), message).toBe(1);
      expect(stderr()).toBe(`error: ${said}\n`);
    }
  });

  it('409: the agent name the loop needs, and how to free it, from on and from set', async () => {
    const { api: client } = fakeApi({
      [`PUT ${ROUTE}`]: answer(
        409,
        'conflict',
        'An agent named one-brain already exists in this workspace',
      ),
    });
    for (const args of [
      ['on', '--cap', '500'],
      ['set', '--mode', 'batch'],
    ]) {
      const { io, stderr } = testIo({ api: client });
      expect(await main(['admin', 'loop', ...args], io, [admin]), args.join(' ')).toBe(1);
      expect(stderr()).toBe(
        'error: An agent named one-brain already exists in this workspace. The loop needs that name for its own agent: delete the other one (onebrain admin agents delete one-brain), then run this command again.\n',
      );
    }
  });

  it('passes every other answer on as the API said it', async () => {
    const { api: client } = fakeApi({
      [`GET ${ROUTE}`]: answer(423, 'key_revoked', 'The workspace key is revoked'),
    });
    const { io, stderr } = testIo({ api: client });
    expect(await main(['admin', 'loop', 'status'], io, [admin])).toBe(1);
    expect(stderr()).toBe('error: key_revoked: The workspace key is revoked\n');
  });
});
