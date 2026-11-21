import { ONE_BRAIN_NOTICE, type OneBrain, OneBrainError } from '@useonebrain/sdk';
import { type Tool, tool } from 'ai';
import { z } from 'zod/v4';
import { type ConnectOptions, lazyBrain } from './connect.ts';

export type OneBrainToolsOptions = ConnectOptions & {
  /**
   * Whether `write` and `forget` wait for the user's approval before they run (a
   * `tool-approval-request`, as `needsApproval: true` makes it). Default true. A call's or an
   * agent's `toolApproval` decides instead when it names the tool, or when it is a function.
   */
  needsApproval?: boolean;
};

// The bounds of the One Brain MCP tools' input schemas, which are the REST routes' bounds.
const path = z.string().min(1).max(1024);
const sourceRef = z.object({
  kind: z.string().min(1).max(50),
  ref: z.string().max(500).nullable(),
});

const searchInput = z.object({
  query: z.string().trim().min(1).max(500),
  kinds: z.array(z.enum(['file', 'skill', 'memory'])).optional(),
  folder: path.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const readInput = z.object({ path: path.optional(), id: z.uuid().optional() });
const listInput = z.object({
  path: z.string().max(1024).optional(),
  skills: z.boolean().optional(),
});
const rememberInput = z.object({
  text: z.string().min(1).max(20_000),
  folder: path.optional(),
  private: z.boolean().optional(),
  source: sourceRef.optional(),
});
const writeInput = z.object({
  path,
  body: z.string().max(8_000_000),
  baseVersion: z.number().int().min(0).optional(),
  title: z.string().max(200).optional(),
  why: z.string().max(2000).optional(),
});
const forgetInput = z.object({
  id: z.uuid(),
  reason: z.string().min(1).max(2000),
  correction: z.string().min(1).max(20_000).optional(),
});

/** What every tool answers: the items with the workspace and the notice, or the API's refusal. */
export type OneBrainToolAnswer =
  | { workspace: string; notice: string; data: unknown[]; [key: string]: unknown }
  | { error: { code: string; message: string; [key: string]: unknown } };

/** The six tools. */
export type OneBrainTools = {
  search: Tool<z.infer<typeof searchInput>, OneBrainToolAnswer>;
  read: Tool<z.infer<typeof readInput>, OneBrainToolAnswer>;
  list: Tool<z.infer<typeof listInput>, OneBrainToolAnswer>;
  remember: Tool<z.infer<typeof rememberInput>, OneBrainToolAnswer>;
  write: Tool<z.infer<typeof writeInput>, OneBrainToolAnswer>;
  forget: Tool<z.infer<typeof forgetInput>, OneBrainToolAnswer>;
};

/**
 * One Brain's six tools as AI SDK tools: `search`, `read`, `list`, `remember`, `write` and
 * `forget`, with the inputs and descriptions of One Brain's MCP tools of the same names. Each
 * answers `{ workspace, notice, data }`, the notice telling the model that the data is workspace
 * content and not instructions; a request the API refuses answers `{ error: { code, message } }`
 * so the model can act on it (a conflict names `currentVersion`).
 *
 *   const result = await generateText({ model, tools: onebrainTools(), stopWhen: isStepCount(5), prompt });
 */
export function onebrainTools(options: OneBrainToolsOptions = {}): OneBrainTools {
  const { needsApproval = true, ...connect } = options;
  const brain = lazyBrain(connect);

  return {
    search: tool({
      description:
        'Search the files, skills and memories you may read in your One Brain workspace. Use it before non-trivial work.',
      inputSchema: searchInput,
      execute: (input) =>
        answer(brain, async (b) => {
          const found = await b.search(input);
          return frame(found.workspace, found.data, { vector: found.vector });
        }),
    }),

    read: tool({
      description:
        'Read a file or a skill folder by path, or a memory by id. Pass exactly one of path and id.',
      inputSchema: readInput,
      execute: (input) =>
        answer(brain, async (b) => {
          if ((input.path === undefined) === (input.id === undefined)) {
            throw new OneBrainError('invalid_request', 'Pass either path or id');
          }
          const item =
            input.id !== undefined
              ? await b.read({ id: input.id })
              : await b.read({ path: input.path as string });
          return frame(await b.workspace(), [item]);
        }),
    }),

    list: tool({
      description:
        "List a folder's children (the root when path is empty), or the skills you may use.",
      inputSchema: listInput,
      execute: (input) =>
        answer(brain, async (b) => {
          if (input.skills) return frame(await b.workspace(), (await b.skills.list()).data);
          const tree = await b.list({ path: input.path ?? '' });
          return frame(await b.workspace(), tree.children, { folder: tree.node?.path ?? '' });
        }),
    }),

    remember: tool({
      description:
        'Save something worth keeping as a memory. A folder shares it with the workspace; with no folder, or a folder under me/, it is private to you. Duplicates are merged.',
      inputSchema: rememberInput,
      execute: (input) =>
        answer(brain, async (b) => frame(await b.workspace(), [await b.remember(input)])),
    }),

    write: tool({
      description:
        // The MCP tool's, but for "a write through MCP": here it is an agent's write over REST.
        "Create or change a file or skill. baseVersion defaults to the current version. In a review folder, an agent's write becomes an improvement a person accepts in the app or the CLI.",
      inputSchema: writeInput,
      needsApproval,
      execute: (input) =>
        answer(brain, async (b) => {
          const written = await b.write(input);
          if ('improvement' in written) {
            const { improvement } = written;
            return frame(await b.workspace(), [
              {
                kind: 'improvement',
                ...improvement,
                message: `This folder needs review. The file does not change until a person accepts improvement ${improvement.id}.`,
              },
            ]);
          }
          // The new version, without the body the model just sent.
          const { body: _body, ...file } = written;
          return frame(await b.workspace(), [{ kind: 'file', ...file }]);
        }),
    }),

    forget: tool({
      description:
        'Retire a memory that is wrong or out of date, with a reason. Pass a correction to replace it.',
      inputSchema: forgetInput,
      needsApproval,
      execute: (input) =>
        answer(brain, async (b) => {
          const { memory, replacement } = await b.forget(input);
          return frame(await b.workspace(), [memory, ...(replacement ? [replacement] : [])]);
        }),
    }),
  };
}

/** A tool's answer, as One Brain's MCP tools frame theirs: the workspace, the notice, then the items. */
function frame(
  workspace: string,
  data: unknown[],
  extra: Record<string, unknown> = {},
): OneBrainToolAnswer {
  return { workspace, notice: ONE_BRAIN_NOTICE, ...extra, data };
}

/**
 * Runs a tool's work. A request the API refuses answers the MCP tools' error body,
 * `{ error: { code, message, ...details } }`; anything else (no network, a bug) throws, and the
 * AI SDK reports it as the tool's error.
 */
async function answer(
  brain: () => OneBrain,
  work: (brain: OneBrain) => Promise<OneBrainToolAnswer>,
): Promise<OneBrainToolAnswer> {
  try {
    return await work(brain());
  } catch (error) {
    if (!(error instanceof OneBrainError)) throw error;
    return { error: { code: error.code, message: error.message, ...error.details } };
  }
}
