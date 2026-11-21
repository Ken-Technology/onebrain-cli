import {
  type Message,
  type MessagePart,
  type OneBrain,
  OneBrainError,
  toTranscript,
} from '@useonebrain/sdk';
import { type ConnectOptions, identityOf, lazyBrain, storageOf } from './connect.ts';

export type CaptureOptions = ConnectOptions & {
  /** `false` turns capture off. Default on. */
  capture?: boolean;
  /**
   * The folder the sessions go in. Default: the server decides, the workspace's capture folder,
   * else private to the person the key acts for. A workspace agent key has no private sources, so
   * it needs a capture folder on the workspace, or this.
   */
  folder?: string;
  /** Keep the sessions private to the person the token acts for. Not with `folder`. */
  private?: boolean;
  /** The label in front of each ref: `<client>:<agent name>#turn-<n>`. Default `cloudflare`. */
  client?: string;
};

/** A part of an AI SDK UIMessage, as Think and AIChatAgent keep them. */
type UIPart = { readonly type: string };
/** An AI SDK UIMessage, as `this.messages` holds them in Think and AIChatAgent. */
type UIMessageLike = {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly UIPart[];
};

/**
 * The parts of a Think or AIChatAgent agent that captureTurn uses: pass `this`. It also keeps the
 * turn count in the Durable Object's storage, read from the agent's (protected) `ctx`.
 */
export type CapturingAgent = {
  readonly name: string;
  readonly messages: readonly UIMessageLike[];
};

/** What onChatResponse receives, in Think and in AIChatAgent. */
export type TurnResult = { readonly status: string };

/** Where the next capture starts: a message, and the first of its parts not captured yet. */
type Cursor = { id: string; parts: number };
type State = { turn: number; cursor?: Cursor };

const STATE_KEY = 'onebrain:capture';
/** Tool calls whose answer is a skill's own text: left out, as One Brain's own answers are. */
const SKILL_TOOLS = new Set(['activate_skill', 'read_skill_resource']);
const SETTLED = new Set(['output-available', 'output-error', 'output-denied']);
/** Answers that will not change on a retry: the server refused this capture. */
const REFUSED_STATUS = new Set([400, 401, 403, 404, 413, 422]);
const REFUSED_CODE = new Set(['no_api_key', 'no_workspace']);

/** Process-wide, as the other One Brain clients do: once refused, capture is off until a restart. */
let refused = false;
let announced = false;
let warnedRetry = false;
let warnedStorage = false;
/** Each agent's captures, one after another. */
const queues = new WeakMap<object, Promise<void>>();
/** Each agent's client, while its key stays the same: the workspace is looked up once. */
const clients = new WeakMap<object, { identity: string; brain: OneBrain }>();

/** For tests: forget a refusal and the one-time lines, as a restart does. Not exported by the package. */
export function resetCaptureState(): void {
  refused = false;
  announced = false;
  warnedRetry = false;
  warnedStorage = false;
}

/**
 * Captures the turn that just ended as a One Brain session, so the learning loop can propose
 * improvements from it. Call it from the hook where a turn has finished, in Think and in
 * AIChatAgent alike:
 *
 *   onChatResponse(result: ChatResponseResult) {
 *     this.ctx.waitUntil(captureTurn(this, result, { env: this.env }));
 *   }
 *
 * (Think's saveMessages() resolves after onChatResponse: waitUntil, not await, keeps a caller
 * waiting on it from waiting for the upload too.)
 *
 * Only the messages of this turn are sent (those after the last capture), with the ref
 * `<agent name>#turn-<n>`; the turn number is kept in the Durable Object's storage, so turns are
 * not sent again after a restart. A turn that ended in an error or was aborted is not sent: its
 * messages go with the next one that completes. A turn that finished while capture was off
 * (`capture: false`, or after a refusal) is never sent, also once capture is on again.
 *
 * It never throws and never slows the turn (onChatResponse runs after the answer is saved). When
 * One Brain refuses a capture (a workspace key and no capture folder: 400), it warns once and
 * stops capturing until the Worker restarts. A failure that may pass (rate limit, outage) keeps the
 * turn's messages for the next capture.
 */
export function captureTurn(
  agent: CapturingAgent,
  result: TurnResult,
  options: CaptureOptions = {},
): Promise<void> {
  if (result.status !== 'completed') return Promise.resolve();
  const next = (queues.get(agent) ?? Promise.resolve())
    .then(() => captureNow(agent, options))
    .catch(() => undefined);
  queues.set(agent, next);
  return next;
}

async function captureNow(agent: CapturingAgent, options: CaptureOptions): Promise<void> {
  if (options.capture === false || refused) {
    // Not sent, now or later: the turn is marked as passed, so turning capture on again (or a
    // restart after a refusal) sends only what comes next.
    const storage = storageOf(agent);
    const cursor = cursorOf(agent.messages);
    if (!storage || !cursor) return;
    const state = toState(await storage.get(STATE_KEY));
    await storage.put(STATE_KEY, { turn: state.turn, cursor });
    return;
  }
  const storage = storageOf(agent);
  if (!storage) {
    if (!warnedStorage) {
      warnedStorage = true;
      console.warn(
        '[onebrain] captureTurn needs the agent itself (this), with its Durable Object storage: nothing was captured.',
      );
    }
    return;
  }
  const state = toState(await storage.get(STATE_KEY));
  const messages = agent.messages;
  const { start, turn } = sinceCursor(messages, state.cursor);
  const cursor = cursorOf(messages);
  const save = (turnNumber: number, at: Cursor | undefined) =>
    storage.put(STATE_KEY, { turn: turnNumber, ...(at ? { cursor: at } : {}) });
  const content = turn.map(toMessage).filter((message) => message !== null);
  if (toTranscript(content).trim() === '') {
    await save(state.turn, cursor);
    return;
  }
  const n = state.turn + 1;
  const ref = `${agentName(agent)}#turn-${n}`;
  try {
    await (await clientOf(agent, options)).capture({
      messages: content,
      ref,
      client: options.client ?? 'cloudflare',
      ...(options.folder ? { folder: options.folder } : {}),
      ...(options.private ? { private: true } : {}),
    });
  } catch (error) {
    if (isRefusal(error)) {
      refused = true;
      console.warn(refusalWarning(error));
      await save(state.turn, cursor);
      return;
    }
    // Kept from where this capture started, so the next one sends these messages too.
    await save(state.turn, start);
    if (!warnedRetry) {
      warnedRetry = true;
      const code = error instanceof OneBrainError ? error.code : 'network';
      console.warn(
        `[onebrain] A capture did not reach One Brain (${code}). Its messages go with the next turn.`,
      );
    }
    return;
  }
  await save(n, cursor);
  if (!announced) {
    announced = true;
    console.log(
      `[onebrain] Capturing this agent's finished turns into One Brain (ref ${options.client ?? 'cloudflare'}:${ref}), so its learning loop can propose improvements. Pass capture: false to turn it off.`,
    );
  }
}

function toState(value: unknown): State {
  if (typeof value !== 'object' || value === null) return { turn: 0 };
  const { turn, cursor } = value as Partial<State>;
  const ok =
    typeof cursor === 'object' &&
    cursor !== null &&
    typeof cursor.id === 'string' &&
    typeof cursor.parts === 'number';
  return {
    turn: typeof turn === 'number' && Number.isFinite(turn) ? turn : 0,
    ...(ok ? { cursor: { id: cursor.id, parts: cursor.parts } } : {}),
  };
}

const agentName = (agent: CapturingAgent): string => {
  try {
    return agent.name || 'agent';
  } catch {
    return 'agent'; // an Agent's name is not set outside a request in some setups
  }
};

const isTool = (part: UIPart) => part.type.startsWith('tool-') || part.type === 'dynamic-tool';
const field = (part: UIPart, name: string): unknown => (part as Record<string, unknown>)[name];

/**
 * How many parts of a message are settled: up to its first tool call still waiting for input,
 * approval or output. A turn that continues after an approval answers that call in the same
 * message, so the next capture starts there.
 */
function settledParts(message: UIMessageLike): number {
  const waiting = message.parts.findIndex(
    (part) => isTool(part) && !SETTLED.has(String(field(part, 'state'))),
  );
  return waiting === -1 ? message.parts.length : waiting;
}

function cursorOf(messages: readonly UIMessageLike[]): Cursor | undefined {
  const last = messages.at(-1);
  return last ? { id: last.id, parts: settledParts(last) } : undefined;
}

/**
 * The messages not captured yet: from the cursor's part of its message on, and every message after
 * it. Without a cursor that is still in the conversation (the first capture, or a cleared one), the
 * turn from the last user message on, so earlier history is never sent. `start` is where that is.
 */
function sinceCursor(
  messages: readonly UIMessageLike[],
  cursor: Cursor | undefined,
): { start: Cursor | undefined; turn: UIMessageLike[] } {
  const at = cursor ? messages.findIndex((message) => message.id === cursor.id) : -1;
  if (at === -1 || !cursor) {
    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const turn = messages.slice(lastUser === -1 ? -1 : lastUser);
    return { start: turn[0] ? { id: turn[0].id, parts: 0 } : undefined, turn };
  }
  const marked = messages[at] as UIMessageLike;
  const rest = marked.parts.slice(cursor.parts);
  return {
    start: cursor,
    turn: [...(rest.length > 0 ? [{ ...marked, parts: rest }] : []), ...messages.slice(at + 1)],
  };
}

/**
 * An AI SDK UIMessage as the SDK's framework-neutral Message: text as it is, each tool part as a
 * call and, once settled, its result. A skill's text is left out of the tool results. Other parts
 * keep their type and file name or media type only, never their data.
 */
function toMessage(message: UIMessageLike): Message | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const content: MessagePart[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      const text = field(part, 'text');
      if (typeof text === 'string') content.push({ type: 'text', text });
    } else if (isTool(part)) {
      const toolName =
        part.type === 'dynamic-tool'
          ? String(field(part, 'toolName') ?? 'tool')
          : part.type.slice(5);
      content.push({ type: 'tool-call', toolName, input: field(part, 'input') ?? null });
      const state = field(part, 'state');
      if (state === 'output-available') {
        const output = SKILL_TOOLS.has(toolName)
          ? '[skill content left out]'
          : (field(part, 'output') ?? null);
        content.push({ type: 'tool-result', toolName, output });
      } else if (state === 'output-error') {
        content.push({
          type: 'tool-result',
          toolName,
          output: `Error: ${String(field(part, 'errorText') ?? 'the tool failed')}`,
        });
      } else if (state === 'output-denied') {
        content.push({ type: 'tool-result', toolName, output: 'The user denied this call.' });
      }
    } else if (part.type !== 'reasoning' && part.type !== 'step-start') {
      const label: Record<string, unknown> = {};
      for (const key of ['filename', 'mediaType', 'title']) {
        const value = field(part, key);
        if (typeof value === 'string') label[key === 'title' ? 'name' : key] = value;
      }
      content.push({ type: part.type, ...label });
    }
  }
  return content.length === 0 ? null : { role: message.role, content };
}

async function clientOf(agent: CapturingAgent, options: CaptureOptions): Promise<OneBrain> {
  const identity = await identityOf(options);
  const held = clients.get(agent);
  if (held?.identity === identity) return held.brain;
  const brain = lazyBrain(options)();
  clients.set(agent, { identity, brain });
  return brain;
}

function isRefusal(error: unknown): error is OneBrainError {
  return (
    error instanceof OneBrainError &&
    (REFUSED_STATUS.has(error.status) || REFUSED_CODE.has(error.code))
  );
}

function refusalWarning(error: OneBrainError): string {
  const fix =
    error.code === 'no_api_key'
      ? 'Set ONEBRAIN_API_KEY.'
      : error.status === 401
        ? 'Check ONEBRAIN_API_KEY: One Brain did not accept it.'
        : error.status === 403
          ? 'The key may not write there: pass a folder it may write, or give it access in One Brain.'
          : 'A workspace agent key needs a folder for its sessions: set the workspace capture folder in One Brain, or pass folder.';
  return `[onebrain] One Brain refused a capture (${error.code}, ${error.status}): ${error.message} ${fix} Capture is off until this Worker restarts; pass capture: false to turn it off.`;
}
