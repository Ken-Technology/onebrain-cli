import { ONE_BRAIN_NOTICE, type OneBrain } from '@useonebrain/sdk';
import { defineTool, type ToolContext } from 'eve/tools';
import { always } from 'eve/tools/approval';
import { z } from 'zod';
import type { ClientFactory } from './client.ts';

/** The names of One Brain's tools, the same six its MCP server has. */
export const TOOL_NAMES = ['search', 'read', 'list', 'remember', 'write', 'forget'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Which tools the slot gives the model, and which of them ask a person first. */
export type ToolsOptions = {
  /** The tools to give the model. Default: all six. */
  include?: readonly ToolName[];
  /** The tools that wait for a person's approval. Default: write and forget. Pass [] for none. */
  approval?: readonly ToolName[];
};

export const DEFAULT_APPROVAL: readonly ToolName[] = ['write', 'forget'];

const path = z.string().min(1).max(1024);
/** A folder in the workspace, as a model must pass it. */
const folder = path.describe(
  "A folder path in the workspace: the folder that holds the file it is about (for clients/acme.md, clients). Not the workspace's name.",
);

/** A tool result as One Brain's MCP tools give theirs: the workspace, the notice, then the items. */
async function framed(brain: OneBrain, data: unknown[], extra: Record<string, unknown> = {}) {
  return { workspace: await brain.workspace(), notice: ONE_BRAIN_NOTICE, ...extra, data };
}

/**
 * The six tools, bound to how a call reaches One Brain. eve names them `<slot>__<name>`. Each
 * result carries ONE_BRAIN_NOTICE, so the learning loop does not learn One Brain's own answers back
 * from a captured session.
 */
export function oneBrainTools(input: { client: ClientFactory; options: ToolsOptions }) {
  const { client, options } = input;
  const include = new Set(options.include ?? TOOL_NAMES);
  const approve = new Set(options.approval ?? DEFAULT_APPROVAL);
  const brain = (ctx: ToolContext) => client(ctx, ctx.abortSignal);
  const gate = (name: ToolName) => (approve.has(name) ? { approval: always() } : {});

  const all = {
    search: defineTool({
      description:
        "Search the files, skills and memories you may read in your team's One Brain. Use it before non-trivial work.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500),
        kinds: z.array(z.enum(['file', 'skill', 'memory'])).optional(),
        folder: folder.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      ...gate('search'),
      async execute(args, ctx) {
        const one = await brain(ctx);
        const found = await one.search(args);
        return framed(one, found.data, { vector: found.vector });
      },
    }),
    read: defineTool({
      description:
        'Read a One Brain file or skill folder by path, or a memory by id. Pass exactly one of path and id.',
      inputSchema: z.object({
        path: path
          .describe('A file or skill folder path, such as clients/acme/overview.md.')
          .optional(),
        id: z.string().uuid().describe("A memory's id.").optional(),
      }),
      ...gate('read'),
      async execute(args, ctx) {
        const one = await brain(ctx);
        return framed(one, [await one.read(args)]);
      },
    }),
    list: defineTool({
      description:
        "List a One Brain folder's children (the root when path is empty), or with skills: true the skills you may use.",
      inputSchema: z.object({
        path: z
          .string()
          .max(1024)
          .describe("A folder path, such as clients. Empty or left out: the workspace's top.")
          .optional(),
        skills: z.boolean().optional(),
      }),
      ...gate('list'),
      async execute(args, ctx) {
        const one = await brain(ctx);
        if (args.skills) return framed(one, (await one.list({ skills: true })).data);
        const tree = await one.list(args.path === undefined ? {} : { path: args.path });
        return framed(one, tree.children, { folder: tree.node?.path ?? '' });
      },
    }),
    remember: defineTool({
      description:
        "Save something worth keeping as a One Brain memory, one fact in a sentence that reads on its own. Pass the folder it belongs to, such as the folder of the file it is about: whoever may read the folder sees it. With no folder, or one under me/, it is private to the key's owner, and a workspace agent's key has none, so it needs a folder. Duplicates are merged. Never save secrets.",
      inputSchema: z.object({
        text: z.string().min(1).max(20_000),
        folder: folder.optional(),
        private: z.boolean().optional(),
      }),
      ...gate('remember'),
      async execute(args, ctx) {
        const one = await brain(ctx);
        return framed(one, [
          await one.remember({
            ...args,
            // An agent's save, labelled with the turn as captures are: eve:<session id>#turn-<n>.
            source: {
              kind: 'agent_save',
              ref: `eve:${ctx.session.id}#turn-${ctx.session.turn.sequence + 1}`,
            },
          }),
        ]);
      },
    }),
    write: defineTool({
      description:
        'Create or change a One Brain file or skill file. baseVersion defaults to the current version. In a review folder the write becomes an improvement a person accepts.',
      inputSchema: z.object({
        path,
        body: z.string().max(8_000_000),
        baseVersion: z.number().int().min(0).optional(),
        title: z.string().max(200).optional(),
        why: z.string().max(2000).optional(),
      }),
      ...gate('write'),
      async execute(args, ctx) {
        const one = await brain(ctx);
        return framed(one, [await one.write(args)]);
      },
    }),
    forget: defineTool({
      description:
        'Retire a One Brain memory that is wrong or out of date, with a reason. Pass a correction to replace it.',
      inputSchema: z.object({
        id: z.string().uuid(),
        reason: z.string().min(1).max(2000),
        correction: z.string().min(1).max(20_000).optional(),
      }),
      ...gate('forget'),
      async execute(args, ctx) {
        const one = await brain(ctx);
        const forgot = await one.forget(args);
        return framed(one, [forgot.memory, ...(forgot.replacement ? [forgot.replacement] : [])]);
      },
    }),
  };
  return Object.fromEntries(
    TOOL_NAMES.filter((name) => include.has(name)).map((name) => [name, all[name]]),
  );
}
