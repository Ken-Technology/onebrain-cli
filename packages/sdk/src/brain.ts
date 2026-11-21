import createClient from 'openapi-fetch';
import { OneBrainError, unwrap } from './errors.ts';
import type { components, operations, paths } from './schema.ts';
import { type Message, transcriptMessages } from './transcript.ts';
import { type Part, uploadSession } from './upload.ts';

type Schemas = components['schemas'];
type Json<O extends keyof operations, S extends number> = operations[O]['responses'] extends {
  [K in S]: { content: { 'application/json': infer T } };
}
  ? T
  : never;

export type SearchInput = Schemas['SearchBody'];
export type SearchResponse = Json<'search', 200>;
/** Exactly one of path and id, as the MCP tool takes them. */
export type ReadInput = { path?: string; id?: string };
export type ListInput = { path?: string; skills?: boolean };
export type TreeResponse = Json<'listTree', 200>;
export type SkillsResponse = Json<'listSkills', 200>;
export type RememberInput = {
  text: string;
  /** Shares the memory with whoever may read the folder; with none, or one under me/, it is private. */
  folder?: string;
  private?: boolean;
  source?: Schemas['SourceRef'];
};
export type WriteInput = {
  path: string;
  body: string;
  /** The version the edit is based on; 0 creates. Default: the file's current version, or 0. */
  baseVersion?: number;
  title?: string;
  why?: string;
};
/** The file at its new version, or the pending improvement a write in a review folder becomes. */
export type WriteResponse = Json<'putFile', 200> | Json<'putFile', 202>;
export type ForgetInput = { id: string; reason: string; correction?: string };
export type ForgetResponse = Json<'forget', 200>;
export type SkillFile = Schemas['SkillDetail']['files'][number];
export type CaptureInput = {
  /** The messages to store. Send only the ones not captured yet: see capture(). */
  messages: readonly Message[];
  /** A label for the session, such as `<session id>#turn-<n>`. Stored as the source's externalRef. */
  ref?: string;
  /** Who captured it, such as `eve`. With a ref, the ref is stored as `<client>:<ref>`, as the CLI's hooks name theirs. */
  client?: string;
  /** The folder to store it in. Not with `private`. */
  folder?: string;
  /** Keep it private to the person the caller acts for. A workspace agent has no private sources. */
  private?: boolean;
  /** When the conversation happened. Default: now. */
  occurredAt?: Date | string;
};

export type OneBrainOptions = {
  /** The API's base URL. Default: env ONEBRAIN_URL, else https://api.useonebrain.com. */
  url?: string;
  /**
   * A workspace agent key (`ob_...`) or a person's OAuth access token, sent as a Bearer token. A
   * function is called before every request, so it can hand out a fresh token. Default: env
   * ONEBRAIN_API_KEY.
   */
  apiKey?: string | (() => string | Promise<string>);
  /** The workspace slug. Default: env ONEBRAIN_WORKSPACE, else the caller's own from GET /v1/me. */
  workspace?: string;
  /** The fetch to send requests with. Default: the global fetch at the time of the request. */
  fetch?: typeof globalThis.fetch;
};

export const DEFAULT_URL = 'https://api.useonebrain.com';

/**
 * An environment variable, or undefined. Never throws: there is no `process` in a Cloudflare
 * Worker without nodejs_compat, and reading the environment can be refused elsewhere.
 */
function env(name: string): string | undefined {
  try {
    const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process;
    const value = process?.env?.[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A path as the API keeps it: no spaces or slashes at either end. */
const trimPath = (path: string) => path.replace(/^[\s/]+|[\s/]+$/g, '');

/**
 * A One Brain client: the workspace's files, skills and memories, and session capture. It runs
 * wherever fetch does: Node 22 and later, Vercel Functions, Cloudflare Workers.
 *
 * Each method resolves with the body its REST route answers, typed from the API's OpenAPI spec,
 * and throws a OneBrainError when the API refuses. `api` is the typed client underneath, already
 * signed in, for every other route.
 */
export function createOneBrain(options: OneBrainOptions = {}) {
  const url = (options.url ?? env('ONEBRAIN_URL') ?? DEFAULT_URL).replace(/\/+$/, '');
  const apiKey = options.apiKey ?? env('ONEBRAIN_API_KEY');
  const fetchWith = options.fetch;
  const api = createClient<paths>({
    baseUrl: url,
    // Looked up per request, so a fetch swapped in later (a test's, an instrumented one) is used.
    fetch: (request: Request) => (fetchWith ?? globalThis.fetch)(request),
  });
  api.use({
    onRequest: async ({ request }) => {
      const token = typeof apiKey === 'function' ? await apiKey() : apiKey;
      if (!token) {
        throw new OneBrainError(
          'no_api_key',
          'No One Brain key: pass apiKey to createOneBrain or set ONEBRAIN_API_KEY.',
        );
      }
      request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
  });

  const named = options.workspace ?? env('ONEBRAIN_WORKSPACE');
  let resolving: Promise<string> | null = null;
  /**
   * The workspace slug: the one named, else the caller's own from GET /v1/me, asked once. An agent
   * key is bound to one workspace; a person gets their current one, or their only one.
   */
  const workspace = (): Promise<string> => {
    if (named) return Promise.resolve(named);
    resolving ??= (async () => {
      const me = unwrap(await api.GET('/v1/me'));
      const slug =
        me.currentWorkspace?.slug ??
        (me.workspaces.length === 1 ? me.workspaces[0]?.slug : undefined);
      if (!slug) {
        throw new OneBrainError(
          'no_workspace',
          'No workspace to use: pass workspace to createOneBrain or set ONEBRAIN_WORKSPACE.',
        );
      }
      return slug;
    })().catch((error: unknown) => {
      resolving = null; // asked again on the next call
      throw error;
    });
    return resolving;
  };
  const at = async () => ({ params: { path: { workspace: await workspace() } } });

  const getFile = async (path: string) =>
    unwrap(
      await api.GET('/v1/workspaces/{workspace}/files', {
        params: { path: { workspace: await workspace() }, query: { path } },
      }),
    );
  const getSkill = async (name: string) =>
    unwrap(
      await api.GET('/v1/workspaces/{workspace}/skills/{name}', {
        params: { path: { workspace: await workspace(), name } },
      }),
    );

  /**
   * Reads a file or a skill folder by path, or a memory by id: the MCP tool `read`. A path that is
   * no file but a skill's folder answers the skill with its files.
   */
  async function read(input: { id: string }): Promise<Schemas['Memory']>;
  async function read(input: { path: string }): Promise<Schemas['File'] | Schemas['SkillDetail']>;
  async function read(
    input: ReadInput,
  ): Promise<Schemas['Memory'] | Schemas['File'] | Schemas['SkillDetail']>;
  async function read(
    input: ReadInput,
  ): Promise<Schemas['Memory'] | Schemas['File'] | Schemas['SkillDetail']> {
    if ((input.path === undefined) === (input.id === undefined)) {
      throw new OneBrainError('invalid_request', 'Pass either path or id');
    }
    if (input.id !== undefined) {
      return unwrap(
        await api.GET('/v1/workspaces/{workspace}/memories/{id}', {
          params: { path: { workspace: await workspace(), id: input.id } },
        }),
      );
    }
    const path = input.path as string;
    try {
      return await getFile(path);
    } catch (error) {
      if (
        !(error instanceof OneBrainError) ||
        !['not_found', 'invalid_request'].includes(error.code)
      ) {
        throw error;
      }
      // A skill folder is not a file: the skill named like its last segment, when that is its folder.
      const wanted = trimPath(path);
      const name = wanted.split('/').at(-1) ?? '';
      const skill = name === '' ? null : await getSkill(name).catch(() => null);
      if (skill !== null && skill.path === wanted) return skill;
      throw error;
    }
  }

  /** Lists a folder's children (the root when path is empty), or with skills the skills you may use: the MCP tool `list`. */
  async function list(input?: { path?: string; skills?: false }): Promise<TreeResponse>;
  async function list(input: { skills: true }): Promise<SkillsResponse>;
  async function list(input?: ListInput): Promise<TreeResponse | SkillsResponse>;
  async function list(input: ListInput = {}): Promise<TreeResponse | SkillsResponse> {
    if (input.skills) return skills.list();
    return unwrap(
      await api.GET('/v1/workspaces/{workspace}/tree', {
        params: { path: { workspace: await workspace() }, query: { path: input.path ?? '' } },
      }),
    );
  }

  const skills = {
    /** The skills the caller may use, without their files. */
    list: async (): Promise<SkillsResponse> =>
      unwrap(await api.GET('/v1/workspaces/{workspace}/skills', await at())),
    /** A skill with every file of it. */
    get: (name: string): Promise<Schemas['SkillDetail']> => getSkill(name),
    /** One file of a skill, by its path in the skill folder (`SKILL.md`, `scripts/run.py`). */
    file: async (name: string, filePath: string): Promise<SkillFile> => {
      const skill = await getSkill(name);
      const wanted = trimPath(filePath);
      const file = skill.files.find((one) => one.path === wanted);
      if (!file) {
        throw new OneBrainError('not_found', `Skill ${skill.name} has no file ${wanted}`, {
          status: 404,
        });
      }
      return file;
    },
  };

  return {
    /** The typed client underneath, signed in with the key, for every other route. */
    api,
    /** The workspace slug this client works in. */
    workspace,

    /** Searches the files, skills and memories the caller may read: the MCP tool `search`. */
    search: async (input: SearchInput): Promise<SearchResponse> =>
      unwrap(await api.POST('/v1/workspaces/{workspace}/search', { ...(await at()), body: input })),

    read,
    list,
    skills,

    /**
     * Saves something worth keeping as a memory: the MCP tool `remember`. A folder shares it; with
     * no folder, or one under me/, it is private. The same text in the same place answers the
     * memory that exists.
     */
    remember: async (input: RememberInput): Promise<Schemas['Memory']> =>
      unwrap(
        await api.POST('/v1/workspaces/{workspace}/memories', {
          ...(await at()),
          body: {
            text: input.text,
            ...(input.folder === undefined ? {} : { folder: input.folder }),
            ...(input.private ? { visibility: 'private' as const } : {}),
            ...(input.source === undefined ? {} : { source: input.source }),
          },
        }),
      ),

    /**
     * Creates or changes a file or a skill's file: the MCP tool `write`. Without baseVersion it is
     * based on the current version. In a review folder an agent's write becomes an improvement a
     * person accepts: the answer is then `{ improvement }`.
     */
    write: async (input: WriteInput): Promise<WriteResponse> => {
      let baseVersion = input.baseVersion;
      if (baseVersion === undefined) {
        baseVersion = await getFile(input.path).then(
          (file) => file.version,
          (error: unknown) => {
            if (error instanceof OneBrainError && error.code === 'not_found') return 0;
            throw error;
          },
        );
      }
      return unwrap(
        await api.PUT('/v1/workspaces/{workspace}/files', {
          ...(await at()),
          body: {
            path: input.path,
            body: input.body,
            baseVersion,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.why === undefined ? {} : { why: input.why }),
          },
        }),
      );
    },

    /** Retires a memory that is wrong or out of date, with a reason and an optional correction: the MCP tool `forget`. */
    forget: async (input: ForgetInput): Promise<ForgetResponse> =>
      unwrap(
        await api.POST('/v1/workspaces/{workspace}/memories/{id}/forget', {
          params: { path: { workspace: await workspace(), id: input.id } },
          body: {
            reason: input.reason,
            ...(input.correction === undefined ? {} : { correction: input.correction }),
          },
        }),
      ),

    /**
     * Stores a conversation as a session source, the way `onebrain capture` stores a transcript:
     * toTranscript writes it as the plain transcript the learning loop reads. With no folder and
     * no `private`, the server decides where it lands: the workspace's capture folder, else
     * private to the person the caller acts for (a workspace agent has no private sources).
     *
     * Sources are told apart by their content only; the ref is a label. So send only the messages
     * not captured yet, each time with a ref of its own, such as `<session id>#turn-<n>`: uploading
     * the whole conversation every turn stores every turn again, inside a longer source.
     *
     * A conversation over the largest source the server stores is sent in parts, cut between
     * messages, with refs `<ref>#part-<n>`. Resolves with the stored sources, one per part. The
     * same content stored before in the same place is a success too (`duplicate: true`). Throws a
     * OneBrainError when the server refuses it, or any part of it once the rest are sent.
     */
    capture: async (input: CaptureInput): Promise<Schemas['Source'][]> => {
      if (input.private && input.folder !== undefined) {
        throw new OneBrainError('invalid_request', 'Name a folder or ask for private, not both');
      }
      const lines = transcriptMessages(input.messages);
      if (lines.length === 0) {
        throw new OneBrainError('invalid_request', 'The conversation has no message to capture');
      }
      const encoder = new TextEncoder();
      const encoded = lines.map((line) => encoder.encode(line));
      const bytes = new Uint8Array(encoded.reduce((sum, one) => sum + one.length, 0));
      const ends: number[] = [];
      for (const one of encoded) {
        const start = ends.at(-1) ?? 0;
        bytes.set(one, start);
        ends.push(start + one.length);
      }
      const ref =
        input.ref === undefined
          ? undefined
          : input.client === undefined
            ? input.ref
            : `${input.client}:${input.ref}`;
      const when = new Date(input.occurredAt ?? Date.now());
      if (Number.isNaN(when.getTime())) {
        throw new OneBrainError('invalid_request', 'occurredAt is not a date');
      }
      const occurredAt = when.toISOString();
      const params = await at();
      const post = (content: Uint8Array, part?: Part) => {
        const form = new FormData();
        form.append('kind', 'session');
        if (input.folder !== undefined) form.append('folder', input.folder);
        if (input.private) form.append('visibility', 'private');
        if (ref !== undefined) form.append('externalRef', part ? `${ref}#part-${part.n}` : ref);
        form.append('occurredAt', occurredAt);
        const name = part ? `session part ${part.n} of ${part.of}.txt` : 'session.txt';
        // A copy: a Blob of a view into a larger buffer would not type as a BlobPart everywhere.
        form.append('content', new Blob([content.slice()], { type: 'text/plain' }), name);
        return api.POST('/v1/workspaces/{workspace}/sources', {
          ...params,
          body: form as never,
          bodySerializer: (body: unknown) => body as FormData,
        });
      };
      const outcome = await uploadSession({ bytes, post, ends });
      if ('whole' in outcome) return [unwrap(outcome.whole)];
      const first = outcome.refused[0]?.error;
      if (first) throw first;
      if (outcome.rateLimited) throw outcome.rateLimited.error;
      return outcome.stored;
    },
  };
}

export type OneBrain = ReturnType<typeof createOneBrain>;
