import { ONE_BRAIN_NOTICE } from '@useonebrain/sdk';
import { generateText, isStepCount, streamText, ToolLoopAgent } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCaptureState } from '../src/capture.ts';
import { onebrainTools, withOneBrain } from '../src/index.ts';
import { answer, callTools, fakeBrain, hit, keeper, mockModel, streamOf } from './support.ts';

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetCaptureState();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type PromptMessage = { role: string; content: unknown };
const promptOf = (model: ReturnType<typeof mockModel>, call = 0) =>
  (model.doGenerateCalls[call] ?? model.doStreamCalls[call])?.prompt as PromptMessage[];

describe('recall', () => {
  it('searches with the latest user message after the one before it, and puts the results before it, marked as data', async () => {
    const memoryId = crypto.randomUUID();
    const brain = fakeBrain({
      'POST /search': () => ({
        body: {
          workspace: 'acme',
          vector: true,
          data: [
            hit({ snippet: `Renewal is in March.${'x'.repeat(500)}` }),
            hit({ kind: 'memory', id: memoryId, path: null, snippet: 'Acme moved it to April.' }),
          ],
        },
      }),
    });
    const model = mockModel({ generate: [answer('April.')] });
    await generateText({
      model: withOneBrain(model, { ...brain.options, capture: false }),
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'When does Acme renew?' },
      ],
      providerOptions: { onebrain: { sessionId: 's1' }, other: { kept: true } },
    });

    expect(brain.sent[0]).toMatchObject({
      method: 'POST',
      path: '/search',
      body: { query: 'Hi\nWhen does Acme renew?', limit: 5 },
    });
    const prompt = promptOf(model);
    expect(prompt.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'user']);
    const block = ((prompt[2]?.content ?? []) as { text: string }[])[0]?.text ?? '';
    const lines = block.split('\n');
    expect(lines[0]).toBe(ONE_BRAIN_NOTICE);
    expect(lines[1]).toContain('One Brain search results');
    expect(JSON.parse(lines[2] ?? '')).toEqual({
      kind: 'file',
      path: 'clients/acme/overview.md',
      snippet: `Renewal is in March.${'x'.repeat(380)}…`,
    });
    expect(JSON.parse(lines[3] ?? '')).toEqual({
      kind: 'memory',
      id: memoryId,
      snippet: 'Acme moved it to April.',
    });
    expect(prompt[3]).toMatchObject({ content: [{ type: 'text', text: 'When does Acme renew?' }] });
    // Our provider options stay with us; the model's provider gets the rest.
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({ other: { kept: true } });
  });

  it('adds nothing when nothing is found, or when the search fails or is slow', async () => {
    const failing = fakeBrain({ 'POST /search': () => ({ status: 500, body: {} }) });
    const slow = fakeBrain({
      'POST /search': () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ body: { workspace: 'acme', vector: true, data: [hit({})] } }),
            300,
          ),
        ),
    });
    for (const [brain, extra] of [
      [fakeBrain(), {}],
      [failing, {}],
      [slow, { recall: { timeoutMs: 50 } }],
    ] as const) {
      const model = mockModel({ generate: [answer('Fine.')] });
      const result = await generateText({
        model: withOneBrain(model, { ...brain.options, capture: false, ...extra }),
        prompt: 'When does Acme renew?',
      });
      expect(result.text).toBe('Fine.');
      expect(promptOf(model).map((message) => message.role)).toEqual(['user']);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the query to 500 characters: the latest message whole, the end of the one before', async () => {
    const brain = fakeBrain();
    const model = mockModel({ generate: [answer('A.'), answer('B.')] });
    const wrapped = withOneBrain(model, { ...brain.options, capture: false });
    const latest = `And their title? ${'y'.repeat(380)}`;
    await generateText({
      model: wrapped,
      messages: [
        { role: 'user', content: `${'x'.repeat(300)} Who is the champion at Northwind?` },
        { role: 'assistant', content: 'Dana Ortiz.' },
        { role: 'user', content: latest },
      ],
    });
    await generateText({ model: wrapped, prompt: 'z'.repeat(600) });
    const [first, second] = brain.sent.map((one) => (one.body as { query: string }).query);
    expect(first).toHaveLength(500);
    expect(first?.endsWith(`Who is the champion at Northwind?\n${latest}`)).toBe(true);
    expect(second).toBe('z'.repeat(500));
  });

  it('is off with recall: false', async () => {
    const brain = fakeBrain();
    const model = mockModel({ generate: [answer('Fine.')] });
    await generateText({
      model: withOneBrain(model, { ...brain.options, recall: false, capture: false }),
      prompt: 'When does Acme renew?',
    });
    expect(brain.sent).toEqual([]);
  });
});

describe('capture', () => {
  it('stores the turn after generateText with the ref <sessionId>#turn-<n>, and says so once', async () => {
    const brain = fakeBrain();
    const kept = keeper();
    const model = withOneBrain(mockModel({ generate: [answer('In April.'), answer('Done.')] }), {
      ...brain.options,
      recall: false,
      waitUntil: kept.waitUntil,
    });
    const first = [{ role: 'user' as const, content: 'When does Acme renew?' }];
    const one = await generateText({
      model,
      messages: first,
      providerOptions: { onebrain: { sessionId: 'chat-1' } },
    });
    const second = [
      ...first,
      ...one.responseMessages,
      { role: 'user' as const, content: 'Put it in the brief.' },
    ];
    await generateText({
      model,
      messages: second,
      providerOptions: { onebrain: { sessionId: 'chat-1' } },
    });
    await kept.all();

    expect(await brain.stored()).toEqual([
      { ref: 'ai-sdk:chat-1#turn-1', text: 'user: When does Acme renew?\nassistant: In April.\n' },
      { ref: 'ai-sdk:chat-1#turn-2', text: 'user: Put it in the brief.\nassistant: Done.\n' },
    ]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('capture: false');
  });

  it('takes the session id from the options, else a fresh one per turn, and a turn from providerOptions', async () => {
    const brain = fakeBrain();
    const kept = keeper();
    const fixed = withOneBrain(mockModel({ generate: [answer('A.'), answer('B.')] }), {
      ...brain.options,
      recall: false,
      sessionId: 'fixed',
      waitUntil: kept.waitUntil,
    });
    await generateText({ model: fixed, prompt: 'One' });
    await generateText({ model: fixed, prompt: 'Two', providerOptions: { onebrain: { turn: 7 } } });
    const fresh = withOneBrain(mockModel({ generate: [answer('C.')] }), {
      ...brain.options,
      recall: false,
      waitUntil: kept.waitUntil,
    });
    await generateText({ model: fresh, prompt: 'Three' });
    await kept.all();
    const refs = (await brain.stored()).map((one) => one.ref);
    expect(refs.slice(0, 2)).toEqual(['ai-sdk:fixed#turn-1', 'ai-sdk:fixed#turn-7']);
    expect(refs[2]).toMatch(/^ai-sdk:[0-9a-f-]{36}#turn-1$/);
  });

  it('stores nothing with capture: false', async () => {
    const brain = fakeBrain();
    await generateText({
      model: withOneBrain(mockModel({ generate: [answer('A.')] }), {
        ...brain.options,
        capture: false,
      }),
      prompt: 'One',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(brain.captures()).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('sends a folder or private when asked', async () => {
    const brain = fakeBrain();
    const kept = keeper();
    for (const capture of [{ folder: 'agents/sessions' }, { private: true }]) {
      await generateText({
        model: withOneBrain(mockModel({ generate: [answer('A.')] }), {
          ...brain.options,
          recall: false,
          capture,
          waitUntil: kept.waitUntil,
        }),
        prompt: 'One',
      });
    }
    await kept.all();
    const [folder, own] = brain.captures();
    expect(folder?.form?.get('folder')).toBe('agents/sessions');
    expect(folder?.form?.get('visibility')).toBeNull();
    expect(own?.form?.get('visibility')).toBe('private');
    expect(own?.form?.get('folder')).toBeNull();
  });

  it('captures a streamed answer once the stream has ended, and does not hold the stream for it', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const brain = fakeBrain({
      'POST /sources': async () => {
        await held; // One Brain is slow: the stream must end anyway.
        return { status: 201, body: { id: crypto.randomUUID(), duplicate: false } };
      },
    });
    const kept = keeper();
    const result = streamText({
      model: withOneBrain(mockModel({ stream: [streamOf('In ', 'April', '.')] }), {
        ...brain.options,
        recall: false,
        waitUntil: kept.waitUntil,
      }),
      prompt: 'When does Acme renew?',
      providerOptions: { onebrain: { sessionId: 'stream-1' } },
    });
    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks.join('')).toBe('In April.');
    expect(await result.text).toBe('In April.');
    // The upload started after the end, and is still waiting on the server.
    await vi.waitFor(() => expect(brain.captures()).toHaveLength(1));
    release();
    await kept.all();
    expect(await brain.stored()).toEqual([
      {
        ref: 'ai-sdk:stream-1#turn-1',
        text: 'user: When does Acme renew?\nassistant: In April.\n',
      },
    ]);
  });

  it("stores nothing when the model's stream is cancelled before its end, and lets waitUntil go", async () => {
    // streamText reads the model's stream to its end even when its own reader stops, so this
    // cancels the model's stream itself, as an abort does.
    const brain = fakeBrain();
    const kept = keeper();
    const model = withOneBrain(mockModel({ stream: [streamOf('a', 'b', 'c')] }), {
      ...brain.options,
      recall: false,
      waitUntil: kept.waitUntil,
    });
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Go' }] }],
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await kept.all(); // settles: a cancelled stream does not keep the function alive
    expect(brain.captures()).toEqual([]);
  });

  it('in a tool loop, stores the whole turn once, at the step that answers, and searches once', async () => {
    const memoryId = crypto.randomUUID();
    const brain = fakeBrain({
      'POST /search': (sent) => ({
        body: {
          workspace: 'acme',
          vector: true,
          data: [hit({ snippet: `found for ${(sent.body as { query: string }).query}` })],
        },
      }),
      'POST /memories': () => ({
        status: 201,
        body: { id: memoryId, text: 'Acme renews in April.', folder: 'clients/acme' },
      }),
    });
    const kept = keeper();
    const model = mockModel({
      generate: [
        callTools(
          { toolName: 'search', input: { query: 'Acme renewal' } },
          {
            toolName: 'remember',
            input: { text: 'Acme renews in April.', folder: 'clients/acme' },
          },
        ),
        answer('Acme renews in April; I saved that.'),
      ],
    });
    const agent = new ToolLoopAgent({
      model: withOneBrain(model, {
        ...brain.options,
        sessionId: 'agent-1',
        waitUntil: kept.waitUntil,
      }),
      tools: onebrainTools(brain.options),
      stopWhen: isStepCount(5),
    });
    const result = await agent.generate({ prompt: 'When does Acme renew? Remember it.' });
    await kept.all();

    expect(result.text).toBe('Acme renews in April; I saved that.');
    // Recall searched once for the turn and gave both steps the same block; the tool searched too.
    const searches = brain.sent.filter((one) => one.path === '/search').map((one) => one.body);
    expect(searches).toEqual([
      { query: 'When does Acme renew? Remember it.', limit: 5 },
      { query: 'Acme renewal' },
    ]);
    expect(promptOf(model, 1)[0]).toEqual(promptOf(model, 0)[0]);
    const stored = await brain.stored();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.ref).toBe('ai-sdk:agent-1#turn-1');
    const lines = stored[0]?.text.split('\n') ?? [];
    expect(lines[0]).toBe('user: When does Acme renew? Remember it.');
    expect(lines[1]).toBe('assistant: [tool search] {"query":"Acme renewal"}');
    expect(lines[2]).toBe(
      'assistant: [tool remember] {"text":"Acme renews in April.","folder":"clients/acme"}',
    );
    // One Brain's own answers go in with their notice, so the learning loop leaves them out.
    expect(lines[3]).toMatch(/^tool: \{"type":"json"|^tool: \{"workspace":"acme","notice"/);
    expect(lines[3]).toContain(ONE_BRAIN_NOTICE);
    expect(lines.at(-2)).toBe('assistant: Acme renews in April; I saved that.');
  });

  it('stores nothing when the call ends on tool calls (the loop stopped, or waits for an approval)', async () => {
    const brain = fakeBrain();
    const kept = keeper();
    await generateText({
      model: withOneBrain(
        mockModel({ generate: [callTools({ toolName: 'search', input: { query: 'x' } })] }),
        { ...brain.options, recall: false, waitUntil: kept.waitUntil },
      ),
      tools: onebrainTools(brain.options),
      prompt: 'Look it up',
    });
    await kept.all();
    expect(brain.captures()).toEqual([]);
  });

  it('warns once and stops for the process when One Brain refuses a capture, and never throws', async () => {
    const brain = fakeBrain({
      'POST /sources': () => ({
        status: 400,
        body: {
          error: { code: 'invalid_request', message: 'A workspace agent has no private files' },
        },
      }),
    });
    const kept = keeper();
    const model = withOneBrain(mockModel({ generate: [answer('A.'), answer('B.')] }), {
      ...brain.options,
      recall: false,
      waitUntil: kept.waitUntil,
    });
    expect((await generateText({ model, prompt: 'One' })).text).toBe('A.');
    await kept.all();
    expect((await generateText({ model, prompt: 'Two' })).text).toBe('B.');
    await kept.all();
    expect(brain.captures()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0]?.[0]);
    expect(said).toContain('invalid_request, 400');
    expect(said).toContain('capture folder');
    expect(said).not.toContain('ob_test');
  });

  it('warns once for a failure that may pass, and keeps trying', async () => {
    const brain = fakeBrain({ 'POST /sources': () => ({ status: 503, body: {} }) });
    const kept = keeper();
    const model = withOneBrain(mockModel({ generate: [answer('A.'), answer('B.')] }), {
      ...brain.options,
      recall: false,
      waitUntil: kept.waitUntil,
    });
    await generateText({ model, prompt: 'One' });
    await kept.all();
    await generateText({ model, prompt: 'Two' });
    await kept.all();
    expect(brain.captures()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
