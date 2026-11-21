/**
 * A One Brain API in a fetch, for the tests here, in Node and in workerd alike: no Node built-ins.
 * It answers the routes this package calls, per key where it matters, and records every request.
 */

export type FakeSkill = { name: string; version: number; files: Record<string, string> };
export type Posted = {
  ref: string | null;
  folder: string | null;
  visibility: string | null;
  text: string;
};
export type Request_ = { method: string; path: string; key: string | null; body: unknown };
type Answer = { status: number; body: unknown };

export const URL_ = 'https://brain.test';
export const WORKSPACE = 'acme';

export function fakeBrain(
  setup: {
    /** The skills each key may use, by key. */
    skills?: Record<string, FakeSkill[]>;
    /** The search results for any query. */
    hits?: unknown[];
    /** Steps in before a capture is stored: a refusal or an outage. */
    sources?: (posted: Posted) => Answer | null;
    /** Steps in before the skills are listed. */
    listing?: () => Answer | null;
  } = {},
) {
  const requests: Request_[] = [];
  const posted: Posted[] = [];
  const memories: { text: string; folder: string | null; visibility: string | null }[] = [];
  const skills = setup.skills ?? {};

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const isForm = (request.headers.get('content-type') ?? '').startsWith('multipart/form-data');
    const form = isForm ? await request.formData() : null;
    const text = isForm ? '' : await request.text();
    const body = text === '' ? null : JSON.parse(text);
    requests.push({ method: request.method, path: url.pathname, key, body });
    const answer = await route(request.method, url.pathname, key, body, form);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  async function route(
    method: string,
    path: string,
    key: string | null,
    body: unknown,
    form: FormData | null,
  ): Promise<Answer> {
    if (key === null || key === 'ob_bad') return error(401, 'unauthorized', 'Sign in first');
    if (method === 'GET' && path === '/v1/me') {
      return ok({ currentWorkspace: { slug: WORKSPACE }, workspaces: [{ slug: WORKSPACE }] });
    }
    const base = `/v1/workspaces/${WORKSPACE}`;
    const mine = skills[key] ?? [];
    if (method === 'GET' && path === `${base}/skills`) {
      const early = setup.listing?.();
      if (early) return early;
      return ok({ data: mine.map((one) => summary(one)) });
    }
    const skill = path.match(new RegExp(`^${base}/skills/([^/]+)$`));
    if (method === 'GET' && skill) {
      const one = mine.find((candidate) => candidate.name === decodeURIComponent(skill[1] ?? ''));
      if (!one) return error(404, 'not_found', 'No such skill');
      return ok({
        ...summary(one),
        files: Object.entries(one.files).map(([file, text]) => ({ path: file, body: text })),
      });
    }
    if (method === 'POST' && path === `${base}/search`) {
      return ok({ data: setup.hits ?? [], vector: true, workspace: WORKSPACE });
    }
    if (method === 'POST' && path === `${base}/memories`) {
      const input = body as { text: string; folder?: string; visibility?: string };
      if (!input.folder && key.startsWith('ob_agent')) {
        return error(
          400,
          'invalid_request',
          'A workspace agent has no private memories: name a folder',
        );
      }
      memories.push({
        text: input.text,
        folder: input.folder ?? null,
        visibility: input.visibility ?? null,
      });
      return { status: 201, body: memory(input.text, input.folder ?? null) };
    }
    if (method === 'POST' && path === `${base}/sources` && form) {
      const content = form.get('content') as File;
      const one: Posted = {
        ref: form.get('externalRef') as string | null,
        folder: form.get('folder') as string | null,
        visibility: form.get('visibility') as string | null,
        text: await content.text(),
      };
      const early = setup.sources?.(one);
      if (early) return early;
      posted.push(one);
      return {
        status: 201,
        body: {
          id: `s${posted.length}`,
          kind: 'session',
          folder: one.folder,
          visibility: one.folder ? 'workspace' : 'private',
          contentHash: `h${posted.length}`,
          duplicate: false,
          createdAt: '2026-11-21T00:00:00.000Z',
        },
      };
    }
    return error(404, 'not_found', 'Not found');
  }

  return { fetch: fetch as typeof globalThis.fetch, requests, posted, memories };
}

const ok = (body: unknown): Answer => ({ status: 200, body });
export const error = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

const summary = (one: FakeSkill) => ({
  name: one.name,
  path: `skills/${one.name}`,
  description: `The ${one.name} skill`,
  version: one.version,
  updatedAt: '2026-11-20T00:00:00.000Z',
});

const memory = (text: string, folder: string | null) => ({
  id: '00000000-0000-4000-8000-000000000001',
  text,
  folder,
  visibility: folder ? 'workspace' : 'private',
  status: 'unreviewed',
  validFrom: '2026-11-21T00:00:00.000Z',
  validTo: null,
  supersedesId: null,
  kind: null,
  source: null,
  author: { id: 'a', name: 'agent' },
  onBehalfOf: null,
  createdAt: '2026-11-21T00:00:00.000Z',
  evidence: [],
});

/** A SKILL.md with frontmatter. */
export const skillMd = (name: string, body = `# ${name}\nFollow these steps.`) =>
  `---\nname: ${name}\ndescription: Use when ${name} comes up.\n---\n${body}\n`;
