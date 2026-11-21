/** A fake One Brain for the package's tests: a fetch that answers from routes and records each request. */
export type Sent = {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  body: unknown;
  form: FormData | null;
  signal: AbortSignal;
};
export type Answer = { status?: number; body?: unknown };
type Route = (sent: Sent) => Answer | Promise<Answer>;

export const URL_ = 'https://brain.test';

export function fakeOneBrain(routes: Record<string, Route> = {}) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const isForm = (request.headers.get('content-type') ?? '').startsWith('multipart/form-data');
    const text = isForm ? '' : await request.text();
    const one: Sent = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      authorization: request.headers.get('authorization'),
      body: text === '' ? null : JSON.parse(text),
      form: isForm ? await request.formData() : null,
      signal: request.signal,
    };
    sent.push(one);
    const route = routes[`${request.method} ${url.pathname}`];
    const answer = route
      ? await route(one)
      : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

/** The text and fields of a captured session a fake POST sources got. */
export async function posted(one: Sent) {
  const form = one.form as FormData;
  return {
    text: await (form.get('content') as File).text(),
    ref: form.get('externalRef'),
    folder: form.get('folder'),
    visibility: form.get('visibility'),
  };
}

/** A source as POST sources answers. */
export const source = (folder: string | null = 'agents/eve') => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'session',
  folder,
  visibility: folder === null ? 'private' : 'workspace',
  contentHash: 'h',
  duplicate: false,
  createdAt: '2026-11-21T00:00:00.000Z',
});

/** A search result as POST search answers. */
export const hit = (
  n: number,
  kind: 'file' | 'skill' | 'memory' = 'file',
  snippet = `Snippet ${n}`,
) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  kind,
  path: kind === 'memory' ? null : `notes/file-${n}.md`,
  snippet,
  status: 'accepted',
  source: null,
  score: 1 / n,
  title: null,
});

/** eve's session context, as a handler gets it. */
export const session = (id = 'wrun_S1', sequence = 1, principalId = 'u1') => ({
  id,
  auth: {
    current: { principalId, principalType: 'user', issuer: 'https://idp.test', attributes: {} },
    initiator: null,
  },
  turn: { id: `turn_${sequence}`, sequence },
});

/** A person's message, as eve's history holds it. */
export const said = (turn: string, text: string) => ({
  role: 'user',
  kind: 'user',
  metadata: { 'eve.turn': turn },
  content: text,
});
