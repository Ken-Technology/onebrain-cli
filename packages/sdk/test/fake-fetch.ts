/** A fetch for tests: it answers from routes and records every request it gets. */
export type Sent = {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  form: FormData | null;
};
export type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that answers from `routes` ("METHOD url without the query" -> answer) and records each request. */
export function fakeFetch(routes: Record<string, (sent: Sent) => Answer | Promise<Answer>>) {
  const sent: Sent[] = [];
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    const isForm = (request.headers.get('content-type') ?? '').startsWith('multipart/form-data');
    const one: Sent = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: isForm ? '' : await request.text(),
      form: isForm ? await request.formData() : null,
    };
    sent.push(one);
    const route = routes[`${request.method} ${url.origin}${url.pathname}`];
    const answer = route ? await route(one) : { status: 404, body: notFound };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

export const notFound = { error: { code: 'not_found', message: 'Not found' } };
/** The JSON body a request sent. */
export const json = (sent: Sent | undefined) => JSON.parse(sent?.body ?? 'null');
