import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOneBrainClient } from '@useonebrain/sdk';
import type { Io, OneBrainClient } from '../src/client.ts';

export type FakeCall = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  form: FormData | null;
  headers: Headers;
};
export type FakeReply = {
  status?: number;
  body?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
};
export type FakeRoutes = Record<string, (call: FakeCall) => FakeReply | Promise<FakeReply>>;

/** A fetch that answers from `routes` (key: 'GET /v1/me') and records every call. */
export function fakeFetch(routes: FakeRoutes, calls: FakeCall[] = []): typeof fetch {
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const type = request.headers.get('content-type') ?? '';
    let body: unknown = null;
    let form: FormData | null = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (type.includes('multipart/form-data')) form = await request.formData();
      else {
        const raw = await request.text();
        if (raw === '') body = null;
        else if (type.includes('json')) body = JSON.parse(raw);
        else body = raw;
      }
    }
    const call: FakeCall = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body,
      form,
      headers: request.headers,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) {
      return Response.json(
        { error: { code: 'no_fake_route', message: `${call.method} ${call.path}` } },
        { status: 500 },
      );
    }
    const reply = await handler(call);
    const status = reply.status ?? 200;
    if (reply.text !== undefined) {
      return new Response(reply.text, {
        status,
        headers: { 'content-type': reply.contentType ?? 'text/plain' },
      });
    }
    if (status === 204 || reply.body === undefined) {
      return new Response(null, { status, ...(reply.headers ? { headers: reply.headers } : {}) });
    }
    return Response.json(reply.body, {
      status,
      ...(reply.headers ? { headers: reply.headers } : {}),
    });
  };
  return fn as typeof fetch;
}

/**
 * An issuer that rotates refresh tokens strictly: only the newest one works, and an older one
 * coming back ends the sign-in for good. It counts the refreshes it was asked for.
 */
export function rotatingIssuer(options: { first?: string; delayMs?: number } = {}) {
  let origin = 'https://issuer.test';
  let current: string | null = options.first ?? 'rt-1';
  let n = 1;
  let refreshes = 0;
  const routes: FakeRoutes = {
    'GET /.well-known/openid-configuration': () => ({
      body: { token_endpoint: `${origin}/oauth/token` },
    }),
    'POST /oauth/token': async (call) => {
      refreshes++;
      const presented = new URLSearchParams(call.body as string).get('refresh_token');
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (current === null || presented !== current) {
        current = null;
        return { status: 400, body: { error: 'invalid_grant' } };
      }
      n++;
      current = `rt-${n}`;
      return { body: { access_token: `at-${n}`, refresh_token: current, expires_in: 3600 } };
    },
  };
  return {
    routes,
    refreshes: () => refreshes,
    /** The access token of the newest answer. Null before the first refresh and after a refusal. */
    accessToken: () => (n > 1 && current !== null ? `at-${n}` : null),
    /** Call with serveFake's address, so discovery names a token endpoint that exists. */
    serveAt: (url: string) => {
      origin = url;
    },
  };
}

/** The same routes over real HTTP on 127.0.0.1, for a test that starts other processes. */
export async function serveFake(
  routes: FakeRoutes,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const answer = fakeFetch(routes);
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const name of ['authorization', 'content-type']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const response = await answer(`http://127.0.0.1${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
      });
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      });
      res.end(await response.text());
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function fakeApi(routes: FakeRoutes): { api: OneBrainClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const api = createOneBrainClient({
    baseUrl: 'http://onebrain.test',
    token: 'test-token',
    fetch: fakeFetch(routes, calls),
  });
  return { api, calls };
}

export function testIo(
  options: {
    api?: OneBrainClient;
    workspace?: string;
    env?: Record<string, string | undefined>;
    home?: string;
    stdin?: string | null;
  } = {},
): { io: Io; stdout: () => string; stderr: () => string; home: string } {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'onebrain-home-'));
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    readStdin: async () => options.stdin ?? null,
    env: { HOME: home, ...options.env },
    home,
    cwd: home,
    client: async () => ({
      api: options.api ?? fakeApi({}).api,
      workspace: options.workspace ?? 'kenso',
    }),
  };
  return { io, stdout: () => out, stderr: () => err, home };
}
