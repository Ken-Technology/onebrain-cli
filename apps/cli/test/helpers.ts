import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOneBrainClient } from '@onebrain/sdk';
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
