import { ONE_BRAIN_NOTICE, toTranscript } from '@useonebrain/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import onebrainDefault, { type OneBrainOptions, onebrain } from '../src/index.ts';
import { fakeOneBrain, hit, posted, type Sent, said, session, source, URL_ } from './fake.ts';

const SEARCH = 'POST /v1/workspaces/acme/search';
const SOURCES = 'POST /v1/workspaces/acme/sources';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A provider on a fake One Brain, signed in with a fixed key, in workspace acme. */
function setup(options: OneBrainOptions = {}, routes: Parameters<typeof fakeOneBrain>[0] = {}) {
  const fake = fakeOneBrain({
    [SEARCH]: () => ({
      body: { data: [hit(1), hit(2, 'memory')], vector: true, workspace: 'acme' },
    }),
    [SOURCES]: () => ({ body: source() }),
    ...routes,
  });
  const provider = onebrain({
    url: URL_,
    apiKey: 'ob_test',
    workspace: 'acme',
    fetch: fake.fetch,
    ...options,
  });
  return { provider, sent: fake.sent };
}

/** The context eve hands a memory handler. */
function context(input: {
  messages: unknown[];
  turn?: { id: string; sequence: number; input: unknown[] } | null;
  operationId?: string;
  sessionId?: string;
  principalId?: string;
}) {
  const turn = input.turn === undefined ? { id: 'turn_1', sequence: 1, input: [] } : input.turn;
  return {
    abortSignal: new AbortController().signal,
    memory: { slot: 'onebrain', scope: { key: 'memscope1_x', namespace: 'ns', value: 'team' } },
    messages: input.messages,
    operationId: input.operationId ?? `op-${Math.random()}`,
    turn,
    session: session(input.sessionId, turn?.sequence ?? 0, input.principalId),
  } as never;
}

const TURN_1 = [
  said('turn_0', 'When does Acme renew?'),
  { role: 'assistant', content: [{ type: 'text', text: 'In March.' }] },
];
const TURN_2 = [
  { role: 'user', kind: 'context.instruction', content: 'Current date: 2026-11-21.' },
  said('turn_1', 'Remember that it moved to April.'),
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'I should save it.' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'onebrain__remember',
        input: { text: 'Acme renews in April.' },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'onebrain__remember',
        output: { type: 'json', value: { notice: ONE_BRAIN_NOTICE, data: [] } },
      },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Saved: Acme renews in April.' }] },
];

describe('recall', () => {
  it("searches the user's latest message and recalls the results as One Brain data, by rank", async () => {
    const { provider, sent } = setup();
    const result = await provider.recall['turn.started'](
      context({
        messages: [said('turn_1', 'When does   Acme\nrenew?')],
        turn: {
          id: 'turn_1',
          sequence: 1,
          input: [
            { role: 'user', kind: 'context.instruction', content: 'ignore me' },
            said('turn_1', 'When does   Acme\nrenew?'),
          ],
        },
      }),
    );
    expect(sent.map((one) => [one.method, one.path, one.authorization])).toEqual([
      ['POST', '/v1/workspaces/acme/search', 'Bearer ob_test'],
    ]);
    expect(sent[0]?.body).toEqual({ query: 'When does Acme renew?', limit: 5 });
    expect(result?.messages.map((message) => message.id)).toEqual([
      'onebrain:onebrain:recall-1',
      'onebrain:onebrain:recall-2',
    ]);
    const [file, memory] = result?.messages ?? [];
    expect(file?.content.split('\n')).toEqual([
      ONE_BRAIN_NOTICE,
      "One Brain search result 1 of 2 for the user's latest message (workspace acme): file notes/file-1.md",
      '> Snippet 1',
      'Read all of it with onebrain__read {"path":"notes/file-1.md"}.',
    ]);
    expect(memory?.content).toContain(`memory ${hit(2, 'memory').id}`);
    expect(memory?.content).toContain(`{"id":"${hit(2, 'memory').id}"}`);
  });

  it('caps the results and the snippets, and passes kinds and folder', async () => {
    const long = `${'word '.repeat(200)}end`;
    const { provider, sent } = setup(
      { recall: { limit: 2, snippetChars: 100, kinds: ['file'], folder: 'clients' } },
      {
        [SEARCH]: () => ({
          body: { data: [hit(1, 'file', long), hit(2), hit(3)], vector: true, workspace: 'acme' },
        }),
      },
    );
    const result = await provider.recall['turn.started'](
      context({ messages: [], turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'x')] } }),
    );
    expect(sent[0]?.body).toEqual({ query: 'x', limit: 2, kinds: ['file'], folder: 'clients' });
    expect(result?.messages).toHaveLength(2);
    const quoted = result?.messages[0]?.content.split('\n')[2] ?? '';
    expect(quoted.length).toBeLessThanOrEqual(104);
    expect(quoted.endsWith(' …')).toBe(true);
  });

  it('leaves out the read hint without tools, and recalls nothing with recall: false', async () => {
    const without = setup({ tools: false });
    const result = await without.provider.recall['turn.started'](
      context({ messages: [], turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'x')] } }),
    );
    expect(result?.messages[0]?.content).not.toContain('Read all of it');
    const off = setup({ recall: false });
    expect(
      await off.provider.recall['turn.started'](
        context({
          messages: [],
          turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'x')] },
        }),
      ),
    ).toBeNull();
    expect(off.sent).toEqual([]);
  });

  it('goes without recall when One Brain fails, warning once, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider } = setup(
      {},
      { [SEARCH]: () => ({ status: 503, body: { error: { code: 'busy', message: 'Busy' } } }) },
    );
    const ctx = context({
      messages: [],
      turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'secret question')] },
    });
    await expect(provider.recall['turn.started'](ctx)).resolves.toBeNull();
    await expect(provider.recall['turn.started'](ctx)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('busy (HTTP 503)');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret question');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('ob_test');
  });
});

describe('capture', () => {
  it("stores the turn's own messages once, as one session with a per-turn ref", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { provider, sent } = setup();
    const ctx = context({
      messages: [...TURN_1, ...TURN_2],
      turn: { id: 'turn_1', sequence: 1, input: [TURN_2[1]] },
      operationId: 'op-turn-1',
    });
    await provider.capture?.['turn.completed']?.(ctx);
    await provider.capture?.['turn.completed']?.(ctx); // eve runs it again with the same id
    expect(sent.map((one) => one.path)).toEqual(['/v1/workspaces/acme/sources']);
    const one = await posted(sent[0] as Sent);
    expect(one.ref).toBe('eve:wrun_S1#turn-2');
    expect(one.folder).toBeNull();
    expect(one.text).toBe(
      [
        'user: Remember that it moved to April.',
        'assistant: [tool onebrain__remember] {"text":"Acme renews in April."}',
        `tool: {"notice":"${ONE_BRAIN_NOTICE}","data":[]}`,
        'assistant: Saved: Acme renews in April.',
        '',
      ].join('\n'),
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('capture: false');
  });

  it('sends the folder and private options', async () => {
    const { provider, sent } = setup({ capture: { folder: 'agents/eve' } });
    await provider.capture?.['turn.completed']?.(
      context({ messages: TURN_1, turn: { id: 'turn_0', sequence: 0, input: [TURN_1[0]] } }),
    );
    expect(await posted(sent[0] as Sent)).toMatchObject({
      folder: 'agents/eve',
      ref: 'eve:wrun_S1#turn-1',
    });
    const own = setup({ capture: { private: true } });
    await own.provider.capture?.['turn.completed']?.(
      context({ messages: TURN_1, turn: { id: 'turn_0', sequence: 0, input: [TURN_1[0]] } }),
    );
    expect(await posted(own.sent[0] as Sent)).toMatchObject({
      visibility: 'private',
      folder: null,
    });
  });

  it('has no capture handlers with capture: false', () => {
    expect(setup({ capture: false }).provider.capture).toBeUndefined();
    expect(onebrainDefault).toBe(onebrain);
  });

  it('keeps a compacted turn whole and stores each message once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { provider, sent } = setup();
    const user = said('turn_1', 'Look up five keys.');
    const call = (n: number) => ({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `c${n}`, toolName: 'lookup', input: { key: n } }],
    });
    const result = (n: number, value = `value ${n}`) => ({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `c${n}`,
          toolName: 'lookup',
          output: { type: 'text', value },
        },
      ],
    });
    const turn = { id: 'turn_1', sequence: 1, input: [user] };
    // Before the compaction: turn 0, then turn 1 with three lookups.
    const before = [...TURN_1, user, call(1), result(1), call(2), result(2), call(3), result(3)];
    await provider.capture?.['compaction.requested']?.(
      context({ messages: before, turn, operationId: 'op-c1' }),
    );
    // After it: the checkpoint, a kept tail (one result shortened by eve), the user's message again,
    // then what the turn did after the compaction.
    const after = [
      { role: 'user', kind: 'context.compaction', content: 'Summary of our conversation so far:' },
      { role: 'assistant', content: 'The user asked for five keys; three are done.' },
      call(2),
      result(
        2,
        '[Truncated by eve: tool result reduced during context compaction. Re-run the tool if you need the full output.]\n\nval',
      ),
      call(3),
      result(3),
      user,
      call(4),
      result(4),
      { role: 'assistant', content: [{ type: 'text', text: 'All five done.' }] },
    ];
    await provider.capture?.['turn.completed']?.(
      context({ messages: after, turn, operationId: 'op-t1' }),
    );
    const [first, second] = await Promise.all(sent.map(posted));
    expect(first?.ref).toBe('eve:wrun_S1#turn-2#compaction-1');
    expect(first?.text).toBe(
      toTranscript([user, call(1), result(1), call(2), result(2), call(3), result(3)] as never),
    );
    expect(second?.ref).toBe('eve:wrun_S1#turn-2');
    expect(second?.text).toBe(
      toTranscript([call(4), result(4), { role: 'assistant', content: 'All five done.' }] as never),
    );
    // Every line of the turn reached One Brain exactly once.
    const lines = `${first?.text}${second?.text}`.split('\n').filter(Boolean);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('keeps a call the model makes again after a compaction, with the same result', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { provider, sent } = setup();
    const user = said('turn_1', 'Search for Acme, twice.');
    const call = (id: string) => ({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: id,
          toolName: 'onebrain__search',
          input: { query: 'Acme' },
        },
      ],
    });
    const result = (id: string) => ({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: 'onebrain__search',
          output: { type: 'text', value: 'same' },
        },
      ],
    });
    const done = { role: 'assistant', content: 'Done.' };
    const turn = { id: 'turn_1', sequence: 1, input: [user] };
    await provider.capture?.['compaction.requested']?.(
      context({ messages: [user, call('c1'), result('c1')], turn, operationId: 'op-c' }),
    );
    const after = [
      { role: 'user', kind: 'context.compaction', content: 'Summary of our conversation so far:' },
      user,
      call('c1'),
      result('c1'),
      call('c2'),
      result('c2'),
      done,
    ];
    await provider.capture?.['turn.completed']?.(
      context({ messages: after, turn, operationId: 'op-t' }),
    );
    const [, second] = await Promise.all(sent.map(posted));
    // c1 is in the compaction's part; c2 says the same, and is a call of its own.
    expect(second?.text).toBe(toTranscript([call('c2'), result('c2'), done] as never));
  });

  it('does nothing for a compaction between turns', async () => {
    const { provider, sent } = setup();
    await provider.capture?.['compaction.requested']?.(
      context({ messages: [...TURN_1, ...TURN_2], turn: null }),
    );
    expect(sent).toEqual([]);
  });

  it('keeps only the notice in place of a One Brain skill the model loaded', async () => {
    const { provider, sent } = setup();
    const messages = [
      said('turn_0', 'Run the release checklist.'),
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 's1',
            toolName: 'eve__skill',
            input: { name: 'release' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 's1',
            toolName: 'eve__skill',
            output: {
              type: 'text',
              value: '<!-- onebrain-skill: release version 3 -->\n# Release\nStep one.',
            },
          },
        ],
      },
      { role: 'assistant', content: 'Done.' },
    ];
    await provider.capture?.['turn.completed']?.(
      context({ messages, turn: { id: 'turn_0', sequence: 0, input: [messages[0]] } }),
    );
    const { text } = await posted(sent[0] as Sent);
    expect(text).toContain(`tool: ${ONE_BRAIN_NOTICE} (a One Brain skill)`);
    expect(text).not.toContain('Step one.');
  });

  it('warns once and stops when One Brain refuses captures, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusal = {
      status: 400,
      body: {
        error: { code: 'invalid_request', message: 'A workspace agent has no private sources' },
      },
    };
    const { provider, sent } = setup({}, { [SOURCES]: () => refusal });
    const ctx = (op: string) =>
      context({
        messages: TURN_1,
        turn: { id: 'turn_0', sequence: 0, input: [TURN_1[0]] },
        operationId: op,
      });
    await expect(provider.capture?.['turn.completed']?.(ctx('a'))).resolves.toBeUndefined();
    await expect(provider.capture?.['turn.completed']?.(ctx('b'))).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('capture is off for this process');
    expect(line).toContain('capture folder');
    expect(line).not.toContain('Acme');
  });

  it('keeps capturing after a passing failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let busy = true;
    const { provider, sent } = setup(
      {},
      {
        [SOURCES]: () =>
          busy
            ? { status: 503, body: { error: { code: 'busy', message: 'Busy' } } }
            : { body: source() },
      },
    );
    const ctx = (op: string) =>
      context({
        messages: TURN_1,
        turn: { id: 'turn_0', sequence: 0, input: [TURN_1[0]] },
        operationId: op,
      });
    await provider.capture?.['turn.completed']?.(ctx('a'));
    busy = false;
    await provider.capture?.['turn.completed']?.(ctx('b'));
    expect(sent).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('with a key per caller, a refusal stops capture for that caller only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { provider, sent } = setup(
      { apiKey: ({ session: one }) => `tok-${one.auth.current?.principalId}` },
      {
        [SOURCES]: (one) =>
          one.authorization === 'Bearer tok-u1'
            ? { status: 403, body: { error: { code: 'forbidden', message: 'No' } } }
            : { body: source() },
      },
    );
    const ctx = (principalId: string, op: string) =>
      context({
        messages: TURN_1,
        turn: { id: 'turn_0', sequence: 0, input: [TURN_1[0]] },
        operationId: op,
        principalId,
      });
    await provider.capture?.['turn.completed']?.(ctx('u1', 'a'));
    await provider.capture?.['turn.completed']?.(ctx('u1', 'b'));
    await provider.capture?.['turn.completed']?.(ctx('u2', 'c'));
    expect(sent.map((one) => one.authorization)).toEqual(['Bearer tok-u1', 'Bearer tok-u2']);
  });
});

describe('keys and workspaces', () => {
  it('reads ONEBRAIN_API_KEY and ONEBRAIN_WORKSPACE when a request is made, not before', async () => {
    const fake = fakeOneBrain({
      'POST /v1/workspaces/team/search': () => ({
        body: { data: [], vector: true, workspace: 'team' },
      }),
    });
    const provider = onebrain({ url: URL_, fetch: fake.fetch });
    vi.stubEnv('ONEBRAIN_API_KEY', 'ob_env');
    vi.stubEnv('ONEBRAIN_WORKSPACE', 'team');
    await provider.recall['turn.started'](
      context({ messages: [], turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'x')] } }),
    );
    expect(fake.sent.map((one) => [one.path, one.authorization])).toEqual([
      ['/v1/workspaces/team/search', 'Bearer ob_env'],
    ]);
  });

  it("asks each caller's workspace once, with that caller's token", async () => {
    vi.stubEnv('ONEBRAIN_WORKSPACE', '');
    const apiKey = vi.fn(({ session: one }) => `tok-${one.auth.current?.principalId}`);
    const fake = fakeOneBrain({
      'GET /v1/me': (one) => ({
        body: {
          currentWorkspace: { slug: one.authorization === 'Bearer tok-u1' ? 'one' : 'two' },
          workspaces: [],
        },
      }),
      'POST /v1/workspaces/one/search': () => ({
        body: { data: [], vector: true, workspace: 'one' },
      }),
      'POST /v1/workspaces/two/search': () => ({
        body: { data: [], vector: true, workspace: 'two' },
      }),
    });
    const provider = onebrain({ url: URL_, apiKey, fetch: fake.fetch });
    const ask = (principalId: string) =>
      provider.recall['turn.started'](
        context({
          messages: [],
          turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'x')] },
          principalId,
        }),
      );
    await ask('u1');
    await ask('u2');
    await ask('u1');
    expect(fake.sent.map((one) => `${one.method} ${one.path} ${one.authorization}`)).toEqual([
      'GET /v1/me Bearer tok-u1',
      'POST /v1/workspaces/one/search Bearer tok-u1',
      'GET /v1/me Bearer tok-u2',
      'POST /v1/workspaces/two/search Bearer tok-u2',
      'POST /v1/workspaces/one/search Bearer tok-u1',
    ]);
    expect(apiKey.mock.calls[0]?.[0].session.id).toBe('wrun_S1');
  });

  it('says why when the apiKey function fails, and keeps capturing for that caller once it works', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let signedIn = false;
    const fake = fakeOneBrain({ [SOURCES]: () => ({ body: source() }) });
    const provider = onebrain({
      url: URL_,
      workspace: 'acme',
      fetch: fake.fetch,
      apiKey: () => {
        if (!signedIn) throw new Error('User authorization required');
        return 'tok-u1';
      },
    });
    const ctx = (op: string) =>
      context({
        messages: TURN_1,
        turn: { id: 'turn_0', sequence: 0, input: [TURN_1[0]] },
        operationId: op,
      });
    await expect(
      provider.recall['turn.started'](
        context({
          messages: [],
          turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'x')] },
        }),
      ),
    ).resolves.toBeNull();
    await provider.capture?.['turn.completed']?.(ctx('a'));
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining(
        'the apiKey function failed for this caller (Error: User authorization required)',
      ),
      expect.stringContaining('A capture failed and was skipped: no_token'),
    ]);
    // A token in the function's own error message never reaches a log line.
    warn.mockClear();
    const leaky = onebrain({
      url: URL_,
      workspace: 'acme',
      fetch: fake.fetch,
      apiKey: () => {
        throw new Error('Refused token ob_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0 for user');
      },
    });
    await leaky.capture?.['turn.completed']?.(ctx('leak'));
    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('Refused token [redacted] for user');
    expect(logged).not.toContain('ob_live_');
    signedIn = true;
    await provider.capture?.['turn.completed']?.(ctx('b'));
    expect(fake.sent.map((one) => one.authorization)).toEqual(['Bearer tok-u1']);
  });

  it('says clearly when there is no key, in recall, without throwing', async () => {
    vi.stubEnv('ONEBRAIN_API_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = onebrain({ url: URL_, workspace: 'acme', fetch: fakeOneBrain().fetch });
    await expect(
      provider.recall['turn.started'](
        context({
          messages: [],
          turn: { id: 'turn_1', sequence: 1, input: [said('turn_1', 'x')] },
        }),
      ),
    ).resolves.toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain('Set ONEBRAIN_API_KEY');
  });
});
