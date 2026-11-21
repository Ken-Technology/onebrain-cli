import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOneBrain, DEFAULT_URL, OneBrainError, type OneBrainOptions } from '../src/index.ts';
import { fakeFetch, json, notFound } from './fake-fetch.ts';

const URL_ = 'https://brain.test';
const W = `${URL_}/v1/workspaces/acme`;
const KEY = 'ob_abcdefabcdef_secretsecretsecret';
const at = '2026-11-21T00:00:00.000Z';
const ref = { id: 'p1', displayName: 'a-claude' };

const me = (slug: string | null, workspaces: string[] = slug ? [slug] : []) => ({
  principal: { id: 'p1', kind: 'agent', displayName: 'a-claude', email: null },
  actsFor: null,
  currentWorkspace: slug ? { id: 'w1', slug, name: slug } : null,
  workspaces: workspaces.map((one) => ({ id: one, slug: one, name: one, role: 'editor' })),
  organizations: [],
});
const file = (path: string, version: number, body = '# Hello') => ({
  id: 'f1',
  path,
  version,
  body,
  visibility: 'workspace',
  changeKind: 'edit',
  author: ref,
  onBehalfOf: null,
  updatedAt: at,
  original: null,
});
const memory = (text: string) => ({
  id: '3f1c2a9e-0000-4000-8000-000000000001',
  text,
  folder: 'clients/acme',
  visibility: 'workspace',
  status: 'unreviewed',
  validFrom: at,
  validTo: null,
  supersedesId: null,
  kind: null,
  source: null,
  author: ref,
  onBehalfOf: null,
  createdAt: at,
  evidence: [],
});
const skill = {
  name: 'onboarding',
  path: 'skills/onboarding',
  description: 'How we onboard a client',
  version: 2,
  updatedAt: at,
  files: [
    { path: 'SKILL.md', body: '---\nname: onboarding\n---\nSteps' },
    { path: 'scripts/check.py', body: 'print(1)' },
  ],
};

const brainWith = (routes: Parameters<typeof fakeFetch>[0], options: OneBrainOptions = {}) => {
  const fake = fakeFetch(routes);
  const brain = createOneBrain({
    url: URL_,
    apiKey: KEY,
    workspace: 'acme',
    fetch: fake.fetch,
    ...options,
  });
  return { brain, ...fake };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createOneBrain: sign-in, workspace and settings', () => {
  it('sends the key as a Bearer token on every request', async () => {
    const { brain, sent } = brainWith({
      [`POST ${W}/search`]: () => ({ body: { data: [], vector: true, workspace: 'acme' } }),
    });
    await brain.search({ query: 'renewal' });
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('calls a key function before every request, so a token can be fresh each time', async () => {
    let n = 0;
    const apiKey = vi.fn(async () => `token-${++n}`);
    const { brain, sent } = brainWith(
      { [`POST ${W}/search`]: () => ({ body: { data: [], vector: true, workspace: 'acme' } }) },
      { apiKey },
    );
    await brain.search({ query: 'a' });
    await brain.search({ query: 'b' });
    expect(sent.map((one) => one.headers.get('authorization'))).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  it('takes the URL, the key and the workspace from the environment, and trims the URL', async () => {
    vi.stubEnv('ONEBRAIN_URL', `${URL_}/`);
    vi.stubEnv('ONEBRAIN_API_KEY', KEY);
    vi.stubEnv('ONEBRAIN_WORKSPACE', 'acme');
    const fake = fakeFetch({
      [`POST ${W}/search`]: () => ({ body: { data: [], vector: true, workspace: 'acme' } }),
    });
    await createOneBrain({ fetch: fake.fetch }).search({ query: 'x' });
    expect(fake.sent[0]?.url).toBe(`${W}/search`);
    expect(fake.sent[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('defaults to the hosted API', async () => {
    vi.stubEnv('ONEBRAIN_URL', '');
    const fake = fakeFetch({});
    await createOneBrain({ apiKey: KEY, workspace: 'acme', fetch: fake.fetch })
      .search({ query: 'x' })
      .catch(() => null);
    expect(DEFAULT_URL).toBe('https://api.useonebrain.com');
    expect(fake.sent[0]?.url).toBe(`${DEFAULT_URL}/v1/workspaces/acme/search`);
  });

  it('works where there is no process at all, as in a Worker without nodejs_compat', async () => {
    vi.stubGlobal('process', undefined);
    const fake = fakeFetch({
      [`POST ${W}/search`]: () => ({ body: { data: [], vector: true, workspace: 'acme' } }),
    });
    const brain = createOneBrain({ url: URL_, apiKey: KEY, workspace: 'acme', fetch: fake.fetch });
    vi.unstubAllGlobals();
    await expect(brain.search({ query: 'x' })).resolves.toMatchObject({ workspace: 'acme' });
    vi.stubGlobal('process', undefined);
    const bare = createOneBrain({ fetch: fake.fetch });
    vi.unstubAllGlobals();
    await expect(bare.search({ query: 'x' })).rejects.toMatchObject({ code: 'no_api_key' });
  });

  it('refuses to send a request without a key, and sends nothing', async () => {
    vi.stubEnv('ONEBRAIN_API_KEY', '');
    const fake = fakeFetch({});
    const brain = createOneBrain({ url: URL_, workspace: 'acme', fetch: fake.fetch });
    const error = await brain.search({ query: 'x' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OneBrainError);
    expect(error).toMatchObject({ code: 'no_api_key', status: 0 });
    expect(fake.sent).toEqual([]);
  });

  it('uses the global fetch of the moment when none is given', async () => {
    const fake = fakeFetch({
      [`POST ${W}/search`]: () => ({ body: { data: [], vector: false, workspace: 'acme' } }),
    });
    const brain = createOneBrain({ url: URL_, apiKey: KEY, workspace: 'acme' });
    vi.stubGlobal('fetch', fake.fetch);
    await brain.search({ query: 'x' });
    expect(fake.sent).toHaveLength(1);
  });

  it('asks GET /v1/me for the workspace once, and only when none is named', async () => {
    vi.stubEnv('ONEBRAIN_WORKSPACE', '');
    const fake = fakeFetch({
      [`GET ${URL_}/v1/me`]: () => ({ body: me('acme') }),
      [`POST ${W}/search`]: () => ({ body: { data: [], vector: true, workspace: 'acme' } }),
      [`GET ${W}/skills`]: () => ({ body: { data: [] } }),
    });
    const brain = createOneBrain({ url: URL_, apiKey: KEY, fetch: fake.fetch });
    await Promise.all([
      brain.search({ query: 'a' }),
      brain.skills.list(),
      brain.search({ query: 'b' }),
    ]);
    expect(await brain.workspace()).toBe('acme');
    expect(fake.sent.filter((one) => one.url.endsWith('/v1/me'))).toHaveLength(1);
    expect(fake.sent).toHaveLength(4);
  });

  it("takes a person's only workspace when none is current, and says so when there is none to take", async () => {
    vi.stubEnv('ONEBRAIN_WORKSPACE', '');
    const only = fakeFetch({ [`GET ${URL_}/v1/me`]: () => ({ body: me(null, ['solo']) }) });
    await expect(
      createOneBrain({ url: URL_, apiKey: KEY, fetch: only.fetch }).workspace(),
    ).resolves.toBe('solo');
    const many = fakeFetch({ [`GET ${URL_}/v1/me`]: () => ({ body: me(null, ['a', 'b']) }) });
    await expect(
      createOneBrain({ url: URL_, apiKey: KEY, fetch: many.fetch }).workspace(),
    ).rejects.toMatchObject({
      code: 'no_workspace',
    });
  });

  it('asks for the workspace again after a failed attempt', async () => {
    vi.stubEnv('ONEBRAIN_WORKSPACE', '');
    let calls = 0;
    const fake = fakeFetch({
      [`GET ${URL_}/v1/me`]: () =>
        ++calls === 1
          ? {
              status: 503,
              body: { error: { code: 'busy', message: 'Busy' } },
              headers: { 'Retry-After': '1' },
            }
          : { body: me('acme') },
    });
    const brain = createOneBrain({ url: URL_, apiKey: KEY, fetch: fake.fetch });
    await expect(brain.workspace()).rejects.toMatchObject({
      code: 'busy',
      status: 503,
      retryAfter: 1,
    });
    await expect(brain.workspace()).resolves.toBe('acme');
    await expect(brain.workspace()).resolves.toBe('acme');
    expect(calls).toBe(2);
  });
});

describe('createOneBrain: the six tools and skills', () => {
  it('search posts the body to the search route and answers the API body', async () => {
    const body = {
      data: [
        {
          id: 'f1',
          kind: 'file',
          path: 'clients/acme/overview.md',
          snippet: 'Renewal',
          status: 'accepted',
          source: null,
          score: 1,
        },
      ],
      vector: true,
      workspace: 'acme',
    };
    const { brain, sent } = brainWith({ [`POST ${W}/search`]: () => ({ body }) });
    await expect(
      brain.search({ query: 'renewal', limit: 5, kinds: ['file'], folder: 'clients' }),
    ).resolves.toEqual(body);
    expect(sent[0]?.method).toBe('POST');
    expect(json(sent[0])).toEqual({
      query: 'renewal',
      limit: 5,
      kinds: ['file'],
      folder: 'clients',
    });
  });

  it('read by path answers the file, and by id the memory', async () => {
    const { brain, sent } = brainWith({
      [`GET ${W}/files`]: () => ({ body: file('clients/acme/overview.md', 3) }),
      [`GET ${W}/memories/abc`]: () => ({ body: memory('Acme renews in April') }),
    });
    await expect(brain.read({ path: 'clients/acme/overview.md' })).resolves.toMatchObject({
      version: 3,
      body: '# Hello',
    });
    expect(new URL(sent[0]?.url ?? '').searchParams.get('path')).toBe('clients/acme/overview.md');
    await expect(brain.read({ id: 'abc' })).resolves.toMatchObject({
      text: 'Acme renews in April',
    });
    await expect(brain.read({} as never)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(brain.read({ path: 'x', id: 'y' } as never)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('read of a skill folder answers the skill, as the MCP tool does, and a missing path its 404', async () => {
    const { brain, sent } = brainWith({
      [`GET ${W}/skills/onboarding`]: () => ({ body: skill }),
    });
    await expect(brain.read({ path: '/skills/onboarding/' })).resolves.toEqual(skill);
    expect(sent.map((one) => new URL(one.url).pathname)).toEqual([
      '/v1/workspaces/acme/files',
      '/v1/workspaces/acme/skills/onboarding',
    ]);
    // A skill of that name in another folder is not what was asked for.
    const error = await brain.read({ path: 'other/onboarding' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('list answers the tree at a path, the root by default, or the skills', async () => {
    const tree = { node: null, children: [], nextCursor: null };
    const { brain, sent } = brainWith({
      [`GET ${W}/tree`]: () => ({ body: tree }),
      [`GET ${W}/skills`]: () => ({ body: { data: [skill] } }),
    });
    await expect(brain.list()).resolves.toEqual(tree);
    await expect(brain.list({ path: 'clients' })).resolves.toEqual(tree);
    await expect(brain.list({ skills: true })).resolves.toEqual({ data: [skill] });
    expect(sent.map((one) => new URL(one.url).searchParams.get('path'))).toEqual([
      '',
      'clients',
      null,
    ]);
  });

  it('remember sends the text, folder and source, and private as visibility private', async () => {
    const { brain, sent } = brainWith({
      [`POST ${W}/memories`]: () => ({ status: 201, body: memory('Acme renews in April') }),
    });
    await expect(
      brain.remember({ text: 'Acme renews in April', folder: 'clients/acme' }),
    ).resolves.toMatchObject({
      text: 'Acme renews in April',
    });
    await brain.remember({
      text: 'Mine',
      private: true,
      source: { kind: 'session', ref: 'eve:s1' },
    });
    expect(json(sent[0])).toEqual({ text: 'Acme renews in April', folder: 'clients/acme' });
    expect(json(sent[1])).toEqual({
      text: 'Mine',
      visibility: 'private',
      source: { kind: 'session', ref: 'eve:s1' },
    });
  });

  it('write bases the edit on the current version, creates at 0, and answers an improvement as the API does', async () => {
    const improvement = { improvement: { id: 'i1', path: 'review/plan.md', status: 'pending' } };
    const { brain, sent } = brainWith({
      [`GET ${W}/files`]: (one) =>
        new URL(one.url).searchParams.get('path') === 'notes/a.md'
          ? { body: file('notes/a.md', 4) }
          : { status: 404, body: notFound },
      [`PUT ${W}/files`]: (one) =>
        json(one).path === 'review/plan.md'
          ? { status: 202, body: improvement }
          : { body: file(json(one).path, json(one).baseVersion + 1, json(one).body) },
    });
    await expect(
      brain.write({ path: 'notes/a.md', body: 'v5', title: 'Update', why: 'Because' }),
    ).resolves.toMatchObject({
      version: 5,
    });
    await expect(brain.write({ path: 'notes/new.md', body: 'v1' })).resolves.toMatchObject({
      version: 1,
    });
    await expect(
      brain.write({ path: 'review/plan.md', body: 'x', baseVersion: 2 }),
    ).resolves.toEqual(improvement);
    const puts = sent.filter((one) => one.method === 'PUT').map(json);
    expect(puts).toEqual([
      { path: 'notes/a.md', body: 'v5', baseVersion: 4, title: 'Update', why: 'Because' },
      { path: 'notes/new.md', body: 'v1', baseVersion: 0 },
      { path: 'review/plan.md', body: 'x', baseVersion: 2 },
    ]);
    expect(sent.filter((one) => one.method === 'GET')).toHaveLength(2); // none when baseVersion is given
  });

  it('write does not guess a version when reading the file failed for another reason', async () => {
    const { brain, sent } = brainWith({
      [`GET ${W}/files`]: () => ({
        status: 403,
        body: { error: { code: 'forbidden', message: 'No' } },
      }),
    });
    await expect(brain.write({ path: 'x.md', body: 'y' })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(sent.filter((one) => one.method === 'PUT')).toEqual([]);
  });

  it('forget posts the reason and the correction to the memory', async () => {
    const answer = { memory: memory('old'), replacement: memory('new') };
    const { brain, sent } = brainWith({
      [`POST ${W}/memories/m1/forget`]: () => ({ body: answer }),
    });
    await expect(
      brain.forget({ id: 'm1', reason: 'Moved to May', correction: 'Acme renews in May' }),
    ).resolves.toEqual(answer);
    expect(json(sent[0])).toEqual({ reason: 'Moved to May', correction: 'Acme renews in May' });
  });

  it('skills lists, gets, and reads one file of a skill', async () => {
    const { brain } = brainWith({
      [`GET ${W}/skills`]: () => ({ body: { data: [skill] } }),
      [`GET ${W}/skills/onboarding`]: () => ({ body: skill }),
    });
    await expect(brain.skills.list()).resolves.toEqual({ data: [skill] });
    await expect(brain.skills.get('onboarding')).resolves.toEqual(skill);
    await expect(brain.skills.file('onboarding', 'scripts/check.py')).resolves.toEqual({
      path: 'scripts/check.py',
      body: 'print(1)',
    });
    await expect(brain.skills.file('onboarding', 'nope.md')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(brain.skills.get('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('gives every other route through api, signed in', async () => {
    const { brain, sent } = brainWith({ [`GET ${URL_}/v1/me`]: () => ({ body: me('acme') }) });
    const { data } = await brain.api.GET('/v1/me');
    expect(data?.currentWorkspace?.slug).toBe('acme');
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });
});

describe('createOneBrain: errors', () => {
  it("carries the API's code, status, details and Retry-After, and never the key or the content", async () => {
    const { brain } = brainWith({
      [`POST ${W}/search`]: () => ({
        status: 429,
        body: {
          error: {
            code: 'too_many_requests',
            message: 'Slow down',
            kind: 'search',
            limit: 60,
            retryAfterSeconds: 42,
          },
        },
        headers: { 'Retry-After': '42' },
      }),
      [`PUT ${W}/files`]: () => ({
        status: 409,
        body: { error: { code: 'conflict', message: 'Stale baseVersion', currentVersion: 7 } },
      }),
      [`POST ${W}/memories`]: () => ({ status: 500, body: 'oops' }),
    });
    const limited = await brain
      .search({ query: 'top secret plan' })
      .catch((caught: unknown) => caught);
    expect(limited).toBeInstanceOf(OneBrainError);
    expect(limited).toMatchObject({
      name: 'OneBrainError',
      code: 'too_many_requests',
      status: 429,
      retryAfter: 42,
      message: 'Slow down',
      details: { kind: 'search', limit: 60, retryAfterSeconds: 42 },
    });
    const conflict = await brain
      .write({ path: 'a.md', body: 'secret body', baseVersion: 1 })
      .catch((caught: unknown) => caught);
    expect(conflict).toMatchObject({
      code: 'conflict',
      status: 409,
      details: { currentVersion: 7 },
    });
    expect((conflict as OneBrainError).retryAfter).toBeUndefined();
    const broken = await brain
      .remember({ text: 'secret memory' })
      .catch((caught: unknown) => caught);
    expect(broken).toMatchObject({ code: 'http_500', status: 500 });
    for (const error of [limited, conflict, broken] as OneBrainError[]) {
      const said = `${error.message} ${String(error)} ${JSON.stringify(error)}`;
      expect(said).not.toContain(KEY);
      expect(said).not.toMatch(/secret|top secret/);
    }
  });

  it('takes Retry-After from the body when the header is missing', async () => {
    const { brain } = brainWith({
      [`POST ${W}/search`]: () => ({
        status: 429,
        body: { error: { code: 'too_many_requests', message: 'Slow down', retryAfterSeconds: 9 } },
      }),
    });
    await expect(brain.search({ query: 'x' })).rejects.toMatchObject({ retryAfter: 9 });
  });
});
