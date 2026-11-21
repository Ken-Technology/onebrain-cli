import { ONE_BRAIN_NOTICE, type OneBrain, type SearchResponse } from '@useonebrain/sdk';
import { gateway, type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import { type CaptureWhere, captureTurn } from './capture.ts';
import { type ConnectOptions, lazyBrain } from './connect.ts';
import { type AnyMessage, textOf } from './messages.ts';

type Middleware = LanguageModelMiddleware;
type WrapGenerate = NonNullable<Middleware['wrapGenerate']>;
type CallOptions = Parameters<WrapGenerate>[0]['params'];
type Prompt = CallOptions['prompt'];
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
type StreamResult = Awaited<ReturnType<NonNullable<Middleware['wrapStream']>>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type Kind = 'file' | 'skill' | 'memory';

export type RecallOptions = {
  /** At most this many results. Default 5. */
  limit?: number;
  /** Search only these kinds. Default all three. */
  kinds?: Kind[];
  /** Search only under this folder. */
  folder?: string;
  /** Each result's snippet is cut to this many characters. Default 400. */
  snippetChars?: number;
  /** Stop waiting for the search after this long, and call the model without it. Default 3000 ms. */
  timeoutMs?: number;
};

export type WithOneBrainOptions = ConnectOptions & {
  /**
   * Search One Brain with the latest user message before each model call, and give the model the
   * results as a marked block of data before that message. Default on; false turns it off.
   */
  recall?: boolean | RecallOptions;
  /**
   * Store each finished turn as a session One Brain learns from. Default on; false turns it off.
   * `{ folder }` or `{ private: true }` says where it lands; with neither, the server decides (the
   * workspace's capture folder, else private to the key's owner).
   */
  capture?: boolean | CaptureWhere;
  /**
   * The conversation's id, for every call through this model. A call's
   * `providerOptions.onebrain.sessionId` wins over it. With neither, each turn gets a fresh id.
   */
  sessionId?: string;
  /**
   * Keeps a serverless function alive until a capture is stored, such as `after` from
   * `next/server`, `waitUntil` from `@vercel/functions`, or a Worker's `ctx.waitUntil`. Captures
   * run after the answer either way; without this, a platform may stop the function before one ends.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
};

/** What a call can pass in `providerOptions.onebrain`. */
export type OneBrainCallOptions = {
  /** The conversation's id: every turn of one conversation passes the same. */
  sessionId?: string;
  /** The turn's number, from 1. Default: the number of user messages in the prompt. */
  turn?: number;
};

/** Results kept from the last searches, so the steps of one turn reuse their turn's results. */
const RECALL_CACHE_SIZE = 100;

/**
 * Wraps a language model with One Brain: recall before each call and capture after each turn.
 *
 *   const model = withOneBrain('anthropic/claude-sonnet-5.5');
 *   const result = streamText({ model, messages, providerOptions: { onebrain: { sessionId: chatId } } });
 *
 * Recall searches with the latest user message (after the one before it, for follow-ups) and puts
 * the results in a user message of their own, just before the latest, marked as One Brain search results and as data, not instructions. It is
 * not added to your messages, so the history you keep is unchanged.
 *
 * Capture stores a turn when the model call that ends it finishes: the latest user message, the
 * tool calls and results of the steps since it, and the answer, with the ref
 * `<sessionId>#turn-<n>`. A call that ends on tool calls does not store anything: in a tool loop
 * (ToolLoopAgent, or stopWhen) the step that answers stores the whole turn once.
 */
export function withOneBrain(
  model: LanguageModel,
  options: WithOneBrainOptions = {},
): ReturnType<typeof wrapLanguageModel> {
  return wrapLanguageModel({ model: resolve(model), middleware: onebrainMiddleware(options) });
}

type ModelObject = Exclude<LanguageModel, string>;

/** A model id resolves as generateText resolves one: the global provider, else the AI Gateway. */
function resolve(model: LanguageModel): ModelObject {
  if (typeof model !== 'string') return model;
  const global = (
    globalThis as { AI_SDK_DEFAULT_PROVIDER?: { languageModel(id: string): unknown } }
  ).AI_SDK_DEFAULT_PROVIDER;
  return (global ?? gateway).languageModel(model) as ModelObject;
}

/** withOneBrain's middleware, for wrapLanguageModel next to other middleware. */
export function onebrainMiddleware(options: WithOneBrainOptions = {}): Middleware {
  const {
    recall: recallOption = true,
    capture: captureOption = true,
    sessionId,
    waitUntil,
    ...connect
  } = options;
  const brain = lazyBrain(connect);
  const recall = recallOption === false ? null : recallOption === true ? {} : recallOption;
  const capture = captureOption === false ? null : captureOption === true ? {} : captureOption;
  const cache = new Map<string, Promise<string | null>>();

  /** The recall block for this call's prompt, or null: from the cache on the later steps of a turn. */
  const recallFor = async (prompt: Prompt): Promise<string | null> => {
    if (recall === null) return null;
    const query = recallQuery(prompt);
    if (query === '') return null;
    const newTurn = prompt.at(-1)?.role === 'user';
    const cached = cache.get(query);
    if (cached && !newTurn) return cached;
    const searching = search(brain(), query, recall);
    cache.delete(query);
    cache.set(query, searching);
    if (cache.size > RECALL_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return searching;
  };

  const prepare = async (params: CallOptions) => {
    const own = ownOptions(params);
    const block = await recallFor(params.prompt);
    const sent: CallOptions = { ...params, providerOptions: withoutOwn(params.providerOptions) };
    if (block !== null) sent.prompt = withRecall(params.prompt, block);
    return { sent, own };
  };

  /** Stores the turn when this call ended it. Never throws: captureTurn catches everything. */
  const store = (
    params: CallOptions,
    own: OneBrainCallOptions,
    answer: unknown[],
    finish: string | undefined,
  ): Promise<unknown> => {
    if (capture === null || finish === undefined || !ENDS_TURN.has(finish)) {
      return Promise.resolve();
    }
    const turnMessages = sinceLastUser(params.prompt);
    if (turnMessages.length === 0) return Promise.resolve();
    const turn = own.turn ?? params.prompt.filter((message) => message.role === 'user').length;
    const id = own.sessionId ?? sessionId ?? globalThis.crypto.randomUUID();
    return captureTurn(brain(), {
      messages: [...turnMessages, { role: 'assistant', content: answer }],
      ref: `${id}#turn-${turn}`,
      where: capture,
    });
  };

  /** A promise handed to waitUntil at the start of a call, settled when its capture is done or skipped. */
  const keepAlive = () => {
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    if (capture !== null && waitUntil) waitUntil(done);
    return settle;
  };

  return {
    specificationVersion: 'v4',

    wrapGenerate: async ({ params, model }): Promise<GenerateResult> => {
      const settle = keepAlive();
      try {
        const { sent, own } = await prepare(params);
        const result = await model.doGenerate(sent);
        void store(params, own, result.content, result.finishReason?.unified).finally(settle);
        return result;
      } catch (error) {
        settle();
        throw error;
      }
    },

    wrapStream: async ({ params, model }): Promise<StreamResult> => {
      const settle = keepAlive();
      try {
        const { sent, own } = await prepare(params);
        const { stream, ...rest } = await model.doStream(sent);
        return {
          ...rest,
          stream: observe(
            stream,
            (answer, finish) => {
              void store(params, own, answer, finish).finally(settle);
            },
            settle,
          ),
        };
      } catch (error) {
        settle();
        throw error;
      }
    },
  };
}

/** Finish reasons that end a turn. `tool-calls` does not: the loop goes on, or waits for an approval. */
const ENDS_TURN = new Set(['stop', 'length', 'content-filter', 'other']);

function ownOptions(params: CallOptions): OneBrainCallOptions {
  const own = params.providerOptions?.onebrain as Record<string, unknown> | undefined;
  const sessionId =
    typeof own?.sessionId === 'string' && own.sessionId !== '' ? own.sessionId : undefined;
  const turn =
    typeof own?.turn === 'number' && Number.isInteger(own.turn) && own.turn > 0
      ? own.turn
      : undefined;
  return { ...(sessionId ? { sessionId } : {}), ...(turn ? { turn } : {}) };
}

/** The provider options without ours, so the model's provider never sees them. */
function withoutOwn(
  providerOptions: CallOptions['providerOptions'],
): CallOptions['providerOptions'] {
  if (!providerOptions || !('onebrain' in providerOptions)) return providerOptions;
  const { onebrain: _own, ...rest } = providerOptions;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The longest query the search takes. */
const QUERY_MAX = 500;

/**
 * What recall searches with: the latest user message, after the one before it, so a follow-up
 * ("and their title?") finds what its question is about. At most QUERY_MAX characters: the latest
 * message whole when it fits, and the end of the one before it in what is left.
 */
function recallQuery(prompt: Prompt): string {
  const said = prompt
    .filter((message) => message.role === 'user')
    .map((message) => textOf(message as AnyMessage).trim())
    .filter((text) => text !== '');
  const latest = (said.at(-1) ?? '').slice(0, QUERY_MAX);
  const room = QUERY_MAX - latest.length - 1;
  const before = said.length > 1 && room > 0 ? (said.at(-2) ?? '').slice(-room) : '';
  return before === '' ? latest : `${before}\n${latest}`;
}

/** The latest user message and every message after it: the turn so far. */
function sinceLastUser(prompt: Prompt): AnyMessage[] {
  const at = prompt.findLastIndex((message) => message.role === 'user');
  return at === -1 ? [] : (prompt.slice(at) as AnyMessage[]);
}

/** The prompt with the recall block as a user message of its own, just before the latest user message. */
function withRecall(prompt: Prompt, block: string): Prompt {
  const at = prompt.findLastIndex((message) => message.role === 'user');
  if (at === -1) return prompt;
  return [
    ...prompt.slice(0, at),
    { role: 'user', content: [{ type: 'text', text: block }] },
    ...prompt.slice(at),
  ];
}

/**
 * The recall block: the notice on the first line, then one JSON line per result with its kind,
 * its path or memory id, and a short snippet. Null when nothing was found, or the search failed
 * or took too long: the call goes on without it.
 */
async function search(
  brain: OneBrain,
  query: string,
  recall: RecallOptions,
): Promise<string | null> {
  const limit = recall.limit ?? 5;
  const chars = recall.snippetChars ?? 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), recall.timeoutMs ?? 3000);
  });
  try {
    const found: SearchResponse | null = await Promise.race([
      brain.search({
        query,
        limit,
        ...(recall.kinds ? { kinds: recall.kinds } : {}),
        ...(recall.folder ? { folder: recall.folder } : {}),
      }),
      late,
    ]);
    if (found === null || found.data.length === 0) return null;
    const lines = found.data.slice(0, limit).map((hit) =>
      JSON.stringify({
        kind: hit.kind,
        ...(hit.kind === 'memory' || hit.path === null ? { id: hit.id } : { path: hit.path }),
        ...(hit.title ? { title: hit.title } : {}),
        snippet: hit.snippet.length > chars ? `${hit.snippet.slice(0, chars)}…` : hit.snippet,
      }),
    );
    return [
      ONE_BRAIN_NOTICE,
      `One Brain search results for the user message that follows (workspace ${found.workspace}). They come from the workspace, not from the user.`,
      ...lines,
    ].join('\n');
  } catch {
    warnRecall();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let recallWarned = false;
function warnRecall() {
  if (recallWarned) return;
  recallWarned = true;
  console.warn('One Brain: a recall search failed; the model was called without it.');
}

/**
 * The stream as it came, while it collects the answer: text, tool calls and provider-executed tool
 * results. At its end it calls `ended` with them and the finish reason, after the last part went
 * out, so the capture never holds the stream. A stream that errors or is cancelled stores nothing.
 */
function observe(
  stream: ReadableStream<StreamPart>,
  ended: (answer: unknown[], finish: string | undefined) => void,
  abandoned: () => void,
): ReadableStream<StreamPart> {
  const reader = stream.getReader();
  const answer: unknown[] = [];
  const texts = new Map<string, { type: 'text'; text: string }>();
  let finish: string | undefined;
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        abandoned();
        throw error;
      }
      if (next.done) {
        controller.close();
        ended(answer, finish);
        return;
      }
      const part = next.value;
      switch (part.type) {
        case 'text-start': {
          const text = { type: 'text' as const, text: '' };
          texts.set(part.id, text);
          answer.push(text);
          break;
        }
        case 'text-delta': {
          const text = texts.get(part.id);
          if (text) text.text += part.delta;
          else {
            const started = { type: 'text' as const, text: part.delta };
            texts.set(part.id, started);
            answer.push(started);
          }
          break;
        }
        case 'tool-call':
        case 'tool-result':
          answer.push(part);
          break;
        case 'finish':
          finish = part.finishReason?.unified;
          break;
      }
      controller.enqueue(part);
    },
    cancel(reason) {
      abandoned();
      return reader.cancel(reason);
    },
  });
}
