import { defineMemoryProvider, type MemoryProvider } from 'eve/memory';
import { type CaptureContext, type CaptureOptions, captureHandlers } from './capture.ts';
import { type ConnectionOptions, clientFactory, describeError } from './client.ts';
import { type HistoryTurn, latestUserText } from './messages.ts';
import { RECALL_DEFAULTS, type RecallOptions, recallMessages, recallQuery } from './recall.ts';
import { oneBrainTools, type ToolsOptions } from './tools.ts';

export type OneBrainOptions = ConnectionOptions & {
  /** Search One Brain with the user's latest message before each turn. On by default; false turns it off. */
  recall?: false | RecallOptions;
  /**
   * Store each completed turn in One Brain as a session, for its learning loop. On by default;
   * false turns it off.
   */
  capture?: false | CaptureOptions;
  /** The tools the slot gives the model. All six by default, with write and forget on approval; false gives none. */
  tools?: false | ToolsOptions;
};

const PREFIX = '[@useonebrain/eve]';
const RECALL_MAX = 20;

/**
 * One Brain as an eve memory provider: your team's brain behind a memory slot.
 *
 *   // agent/memory/onebrain.ts
 *   import onebrain from '@useonebrain/eve';
 *   import { defineMemory } from 'eve/memory';
 *
 *   export default defineMemory({
 *     description: "The team's One Brain: its files, skills and memories.",
 *     provider: onebrain(),
 *     scope: 'team',
 *   });
 *
 * - Recall: before each turn, the user's latest message is searched, and the top results (5 by
 *   default) go to the model as messages marked as One Brain data.
 * - Capture (on by default): after each turn, that turn's messages are stored as one session with
 *   the ref `eve:<session id>#turn-<n>`.
 * - Tools: search, read, list, remember, write and forget, named `<slot>__<tool>`; write and forget
 *   wait for a person's approval.
 *
 * What the slot may read and write is what the key may: One Brain enforces it, not eve's scope key.
 */
export function onebrain(options: OneBrainOptions = {}) {
  const client = clientFactory(options);
  const recall = options.recall === false ? null : (options.recall ?? {});
  const limit = Math.min(
    Math.max(1, Math.trunc(recall?.limit ?? RECALL_DEFAULTS.limit)),
    RECALL_MAX,
  );
  const snippetChars = Math.max(50, recall?.snippetChars ?? RECALL_DEFAULTS.snippetChars);
  const tools = options.tools === false ? null : (options.tools ?? {});
  const hasRead = tools !== null && (tools.include ?? ['read']).includes('read');
  const warned = new Set<string>();

  const capture =
    options.capture === false
      ? undefined
      : captureHandlers({
          options: options.capture ?? {},
          connection: options,
          client,
        });

  const provider: MemoryProvider = defineMemoryProvider({
    recall: {
      async 'turn.started'(ctx) {
        if (recall === null) return null;
        const query = recallQuery(latestUserText(ctx.turn as unknown as HistoryTurn));
        if (query === '') return null;
        try {
          const brain = await client(ctx, ctx.abortSignal);
          const found = await brain.search({
            query,
            limit,
            ...(recall.kinds === undefined ? {} : { kinds: recall.kinds }),
            ...(recall.folder === undefined ? {} : { folder: recall.folder }),
          });
          const messages = recallMessages({
            found,
            slot: ctx.memory.slot,
            limit,
            snippetChars,
            readTool: hasRead ? `${ctx.memory.slot}__read` : null,
          });
          return messages.length === 0 ? null : { messages };
        } catch (error) {
          if (ctx.abortSignal.aborted) return null;
          // A recall that fails leaves the turn without it: eve would fail the turn on a throw.
          const line = describeError(error);
          if (!warned.has(line)) {
            warned.add(line);
            console.warn(`${PREFIX} Recall failed, so this turn goes without it: ${line}`);
          }
          return null;
        }
      },
    },
    ...(capture === undefined
      ? {}
      : {
          capture: {
            'turn.completed': (ctx) => capture['turn.completed'](ctx as unknown as CaptureContext),
            'compaction.requested': (ctx) =>
              capture['compaction.requested'](ctx as unknown as CaptureContext),
          },
        }),
    ...(tools === null ? {} : { tools: async () => oneBrainTools({ client, options: tools }) }),
  });
  return provider;
}
