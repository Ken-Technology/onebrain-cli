import { ONE_BRAIN_NOTICE } from '@useonebrain/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onebrain, onebrainConnection, onebrainSkills, TOOL_NAMES } from '../src/index.ts';
import { fakeOneBrain, hit, session, URL_ } from './fake.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Tool = {
  description: string;
  approval?: unknown;
  inputSchema: { parse: (input: unknown) => unknown };
  execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
};

const MEMORY = {
  id: '00000000-0000-4000-8000-000000000201',
  text: 'Acme renews in April.',
  folder: null,
  status: 'accepted',
};

async function toolsOf(options: Parameters<typeof onebrain>[0] = {}) {
  const fake = fakeOneBrain({
    'POST /v1/workspaces/acme/search': () => ({
      body: { data: [hit(1)], vector: false, workspace: 'acme' },
    }),
    'POST /v1/workspaces/acme/memories': () => ({ body: MEMORY }),
    'GET /v1/workspaces/acme/tree': (one) => ({
      body: {
        node: one.query.get('path') ? { path: one.query.get('path') } : null,
        children: [{ path: 'clients/acme', kind: 'folder' }],
      },
    }),
    'GET /v1/workspaces/acme/skills': () => ({ body: { data: [{ name: 'release' }] } }),
    'POST /v1/workspaces/acme/memories/00000000-0000-4000-8000-000000000201/forget': () => ({
      body: { memory: { ...MEMORY, status: 'retired' }, replacement: { ...MEMORY, id: 'r' } },
    }),
  });
  const provider = onebrain({
    url: URL_,
    apiKey: 'ob_test',
    workspace: 'acme',
    fetch: fake.fetch,
    ...options,
  });
  const tools = (await provider.tools?.({} as never)) as Record<string, Tool> | undefined;
  return { tools: tools ?? {}, sent: fake.sent };
}

const ctx = { session: session('wrun_S1', 2), abortSignal: new AbortController().signal };

describe('tools', () => {
  it('gives the six tools, with write and forget waiting for approval', async () => {
    const { tools } = await toolsOf();
    expect(Object.keys(tools)).toEqual([...TOOL_NAMES]);
    const gated = Object.entries(tools)
      .filter(([, tool]) => tool.approval !== undefined)
      .map(([name]) => name);
    expect(gated).toEqual(['write', 'forget']);
  });

  it('takes include and approval, and no tools with tools: false', async () => {
    const { tools } = await toolsOf({ tools: { include: ['search', 'write'], approval: [] } });
    expect(Object.keys(tools)).toEqual(['search', 'write']);
    expect(tools.write?.approval).toBeUndefined();
    const none = onebrain({ url: URL_, apiKey: 'ob_test', tools: false });
    expect(none.tools).toBeUndefined();
  });

  it('frames every result with the workspace and ONE_BRAIN_NOTICE', async () => {
    const { tools, sent } = await toolsOf();
    const search = await tools.search?.execute({ query: 'renewal' }, ctx);
    expect(search).toEqual({
      workspace: 'acme',
      notice: ONE_BRAIN_NOTICE,
      vector: false,
      data: [hit(1)],
    });
    const listed = await tools.list?.execute({ path: 'clients' }, ctx);
    expect(listed).toMatchObject({ notice: ONE_BRAIN_NOTICE, folder: 'clients' });
    const skills = await tools.list?.execute({ skills: true }, ctx);
    expect(skills).toMatchObject({ notice: ONE_BRAIN_NOTICE, data: [{ name: 'release' }] });
    const forgot = await tools.forget?.execute({ id: MEMORY.id, reason: 'moved' }, ctx);
    expect(forgot?.data).toHaveLength(2);
    expect(forgot?.notice).toBe(ONE_BRAIN_NOTICE);
    expect(sent.every((one) => one.authorization === 'Bearer ob_test')).toBe(true);
  });

  it('marks a remembered memory as from this eve turn', async () => {
    const { tools, sent } = await toolsOf();
    const result = await tools.remember?.execute({ text: 'Acme renews in April.' }, ctx);
    expect(result).toMatchObject({ notice: ONE_BRAIN_NOTICE, data: [MEMORY] });
    expect(sent.at(-1)?.body).toEqual({
      text: 'Acme renews in April.',
      source: { kind: 'agent_save', ref: 'eve:wrun_S1#turn-3' },
    });
  });

  it('checks inputs like the MCP tools do', async () => {
    const { tools } = await toolsOf();
    expect(() => tools.search?.inputSchema.parse({ query: '  ' })).toThrow();
    expect(() => tools.forget?.inputSchema.parse({ id: 'not-a-uuid', reason: 'x' })).toThrow();
    expect(tools.read?.inputSchema.parse({ path: 'clients/acme/overview.md' })).toEqual({
      path: 'clients/acme/overview.md',
    });
  });
});

describe('onebrainConnection', () => {
  it("is One Brain's MCP server with the six tools, the key as a Bearer token and approval on writes", async () => {
    vi.stubEnv('ONEBRAIN_API_KEY', 'ob_env');
    const connection = onebrainConnection({ url: 'https://brain.test/' }) as unknown as {
      url: string;
      tools: { allow: string[] };
      auth: { getToken: () => Promise<{ token: string }> };
      approval: (input: { toolName: string }) => string;
    };
    expect(connection.url).toBe('https://brain.test/mcp');
    expect(connection.tools.allow).toEqual([...TOOL_NAMES]);
    await expect(connection.auth.getToken()).resolves.toEqual({ token: 'ob_env' });
    expect(connection.approval({ toolName: 'onebrain__write' })).toBe('user-approval');
    expect(connection.approval({ toolName: 'onebrain__forget' })).toBe('user-approval');
    expect(connection.approval({ toolName: 'onebrain__search' })).toBe('not-applicable');
  });

  it('takes a key function, include, approval and eve auth', async () => {
    const auth = { getToken: async () => ({ token: 'x' }) };
    const connection = onebrainConnection({
      apiKey: async () => 'ob_fn',
      include: ['search', 'read'],
      approval: ['read'],
    }) as unknown as {
      url: string;
      tools: { allow: string[] };
      auth: { getToken: () => Promise<{ token: string }> };
      approval: (input: { toolName: string }) => string;
    };
    expect(connection.tools.allow).toEqual(['search', 'read']);
    await expect(connection.auth.getToken()).resolves.toEqual({ token: 'ob_fn' });
    expect(connection.approval({ toolName: 'brain__read' })).toBe('user-approval');
    const signed = onebrainConnection({ auth }) as unknown as { auth: { getToken: unknown } };
    expect(signed.auth.getToken).toBe(auth.getToken);
  });

  it('says clearly when there is no key', async () => {
    vi.stubEnv('ONEBRAIN_API_KEY', '');
    const connection = onebrainConnection() as unknown as {
      auth: { getToken: () => Promise<unknown> };
    };
    await expect(connection.auth.getToken()).rejects.toThrow('Set ONEBRAIN_API_KEY');
  });
});

describe('onebrainSkills', () => {
  const release = {
    name: 'release',
    path: 'skills/release',
    description: 'How we ship.',
    version: 3,
    files: [
      {
        path: 'SKILL.md',
        body: '---\nname: release\ndescription: How we ship.\n---\n\n# Release\nStep one.',
      },
      { path: 'checklist.md', body: '- tests' },
    ],
  };

  /** Runs a dynamic skill as eve would at session start. */
  async function resolve(dynamic: unknown, principalId = 'u1') {
    const key = Object.getOwnPropertySymbols(dynamic).find(
      (one) => one.description === 'eve.dynamic',
    );
    const run = (dynamic as Record<symbol, (ctx: unknown) => Promise<unknown>>)[key as symbol];
    const memo = new Map<string, unknown>();
    return run?.({
      session: session('wrun_S1', 0, principalId),
      memo: async (parts: unknown[], fn: () => Promise<unknown>) => {
        const id = JSON.stringify(parts);
        if (!memo.has(id)) memo.set(id, await fn());
        return memo.get(id);
      },
    });
  }

  it("gives the caller's One Brain skills as eve skills, marked and with their files", async () => {
    const fake = fakeOneBrain({
      'GET /v1/workspaces/acme/skills': () => ({
        body: { data: [{ name: 'release' }, { name: 'bad.name' }, { name: 'gone' }] },
      }),
      'GET /v1/workspaces/acme/skills/release': () => ({ body: release }),
      'GET /v1/workspaces/acme/skills/bad.name': () => ({ body: { ...release, name: 'bad.name' } }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const skills = await resolve(
      onebrainSkills({
        url: URL_,
        apiKey: 'ob_test',
        workspace: 'acme',
        fetch: fake.fetch,
        prefix: 'team-',
      }),
    );
    expect(skills).toEqual({
      'team-release': {
        description: 'How we ship.',
        content: '<!-- onebrain-skill: release version 3 -->\n# Release\nStep one.',
        files: { 'checklist.md': '- tests' },
      },
    });
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('Skipped One Brain skill "bad.name": not a name eve accepts'),
      expect.stringContaining('Skipped One Brain skill "gone": not_found (HTTP 404)'),
    ]);
  });

  it('runs without skills when One Brain cannot be reached, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = fakeOneBrain({
      'GET /v1/workspaces/acme/skills': () => ({
        status: 401,
        body: { error: { code: 'unauthorized', message: 'Bad key' } },
      }),
    });
    const skills = await resolve(
      onebrainSkills({ url: URL_, apiKey: 'ob_test', workspace: 'acme', fetch: fake.fetch }),
    );
    expect(skills).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toContain('unauthorized (HTTP 401)');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('ob_test');
  });
});
