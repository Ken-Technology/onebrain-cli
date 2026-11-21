import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

/** A request the fake One Brain got. */
export type Sent = { method: string; path: string; body: unknown; form: FormData | null };
export type Answer = { status?: number; body?: unknown };

/**
 * A fake One Brain API: answers `"METHOD /path"` routes (workspace acme) and records each request.
 * A session upload (POST sources) answers a stored source unless a route says otherwise.
 */
export function fakeBrain(routes: Record<string, (sent: Sent) => Answer | Promise<Answer>> = {}) {
  const sent: Sent[] = [];
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    const isForm = (request.headers.get('content-type') ?? '').startsWith('multipart/form-data');
    const text = isForm ? '' : await request.text();
    const one: Sent = {
      method: request.method,
      path: url.pathname.replace('/v1/workspaces/acme', ''),
      body: text ? JSON.parse(text) : null,
      form: isForm ? await request.formData() : null,
    };
    sent.push(one);
    const route = routes[`${one.method} ${one.path}`] ?? DEFAULTS[`${one.method} ${one.path}`];
    const answer = route
      ? await route(one)
      : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const captures = () => sent.filter((one) => one.method === 'POST' && one.path === '/sources');
  return {
    options: {
      url: 'https://brain.test',
      apiKey: 'ob_test',
      workspace: 'acme',
      fetch: fetch as typeof globalThis.fetch,
    },
    sent,
    captures,
    /** What each capture stored: its ref and its transcript. */
    stored: async () =>
      Promise.all(
        captures().map(async (one) => ({
          ref: one.form?.get('externalRef'),
          text: await ((one.form?.get('content') ?? new Blob([])) as Blob).text(),
        })),
      ),
  };
}

const DEFAULTS: Record<string, (sent: Sent) => Answer> = {
  'POST /search': () => ({ body: { workspace: 'acme', vector: true, data: [] } }),
  'POST /sources': () => ({
    status: 201,
    body: {
      id: crypto.randomUUID(),
      kind: 'session',
      folder: null,
      visibility: 'workspace',
      contentHash: 'h',
      duplicate: false,
      createdAt: new Date().toISOString(),
    },
  }),
};

export const hit = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  kind: 'file',
  path: 'clients/acme/overview.md',
  snippet: 'Renewal is in March.',
  status: 'accepted',
  source: null,
  score: 1,
  ...over,
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A generate result: text, or tool calls (finishing with tool-calls). */
export function answer(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  };
}
export function callTools(...calls: { toolName: string; input: unknown }[]) {
  return {
    content: calls.map((call, i) => ({
      type: 'tool-call' as const,
      toolCallId: `call-${i}-${call.toolName}`,
      toolName: call.toolName,
      input: JSON.stringify(call.input),
    })),
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage,
    warnings: [],
  };
}

/** A stream result of text deltas, ending with stop. */
export function streamOf(...deltas: string[]) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' },
      ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
      { type: 'text-end' as const, id: 't1' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
    ]),
  };
}

/** A mock model answering the given results in turn. */
export function mockModel(results: { generate?: unknown[]; stream?: unknown[] }) {
  let g = 0;
  let s = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => results.generate?.[g++] as never,
    doStream: async () => results.stream?.[s++] as never,
  });
}

/** waitUntil that keeps every promise, and a way to wait for them all. */
export function keeper() {
  const kept: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => void kept.push(promise),
    all: () => Promise.all(kept),
  };
}
