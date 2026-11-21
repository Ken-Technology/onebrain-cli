import { type components, type Message, OneBrainError, toTranscript } from '@useonebrain/sdk';

type Source = components['schemas']['Source'];

import { defineState, type StateHandle } from 'eve/context';
import {
  type ClientFactory,
  type ConnectionOptions,
  describeError,
  holderOf,
  type OneBrainCallContext,
} from './client.ts';
import { type HistoryMessage, type HistoryTurn, turnMessages } from './messages.ts';

/** Where captured turns go. With neither, the server decides: the workspace's capture folder, else private to the key's owner. */
export type CaptureOptions = {
  /** The folder to store each turn in. The key must be allowed to write there. */
  folder?: string;
  /** Keep each turn private to the person the key acts for. A workspace agent key has no private sources. */
  private?: boolean;
};

/** The part of eve's memory operation context capture reads. */
export type CaptureContext = OneBrainCallContext & {
  readonly abortSignal?: AbortSignal;
  readonly messages: readonly HistoryMessage[];
  readonly operationId: string;
  readonly turn: HistoryTurn | null;
  readonly memory: { readonly slot: string };
};

const PREFIX = '[@useonebrain/eve]';
const DONE_MAX = 1_000;

/** What this session captured of its current turn before a compaction rewrote it. */
type TurnState = {
  /** The eve turn id the rest is about; anything else is a new turn. */
  turn: string | null;
  /** Hashes of the turn's messages already captured, as the transcript writes them. */
  seen: string[];
  /** How many captures the turn has had before a compaction. */
  parts: number;
};
const fresh = (): TurnState => ({ turn: null, seen: [], parts: 0 });

/** A 53-bit hash of a string (cyrb53), as hex: telling messages apart, not keeping them secret. */
export function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** The tool call ids in a message's parts, in order: what tells two equal calls or results apart. */
function callIds(message: Message): string {
  if (!Array.isArray(message.content)) return '';
  return (message.content as readonly { toolCallId?: unknown }[])
    .map((part) => (typeof part.toolCallId === 'string' ? part.toolCallId : ''))
    .filter((id) => id !== '')
    .join(',');
}

/**
 * The session's capture state for a slot: eve's durable session state where there is an eve
 * context (it survives the steps and restarts of a turn), else a map in this process.
 */
function stateStore() {
  const handles = new Map<string, StateHandle<TurnState>>();
  const local = new Map<string, TurnState>();
  const handle = (slot: string) => {
    let one = handles.get(slot);
    if (one === undefined) {
      one = defineState<TurnState>(`onebrain.capture.${slot}`, fresh);
      handles.set(slot, one);
    }
    return one;
  };
  return {
    get(sessionId: string, slot: string): TurnState {
      try {
        return handle(slot).get();
      } catch {
        return local.get(`${sessionId}\u0000${slot}`) ?? fresh();
      }
    },
    set(sessionId: string, slot: string, value: TurnState): void {
      try {
        handle(slot).update(() => value);
      } catch {
        local.set(`${sessionId}\u0000${slot}`, value);
        if (local.size > DONE_MAX) local.delete(local.keys().next().value ?? '');
      }
    },
  };
}

/**
 * Whether a refusal means capture cannot work as set up (a missing capture folder, a folder the key
 * may not write, a key that cannot hold private sources), rather than a passing failure.
 */
function isLasting(error: unknown): boolean {
  if (!(error instanceof OneBrainError)) return false;
  if (error.code === 'no_api_key' || error.code === 'no_workspace') return true;
  return error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status);
}

/** What to do about a refusal, for the warning. */
function advice(error: unknown, options: CaptureOptions): string {
  const code = error instanceof OneBrainError ? error.code : '';
  if (code === 'no_api_key') return 'Set ONEBRAIN_API_KEY, or pass apiKey.';
  if (options.folder !== undefined) {
    return `Check that the key may write folder "${options.folder}", or pass capture: false to turn capture off.`;
  }
  return 'A workspace agent key needs a capture folder: set one in the workspace settings or pass capture: { folder }, or pass capture: false to turn capture off.';
}

/**
 * Capture for a memory slot. Each completed turn is stored as one session source with the ref
 * `eve:<session id>#turn-<n>` (n counts from 1), holding that turn's messages only, so each piece
 * of text reaches One Brain once.
 *
 * A compaction during a turn rewrites what the turn said so far, so before it runs, the turn's
 * messages so far are stored as `eve:<session id>#turn-<n>#compaction-<k>`, and their hashes kept
 * in the session's state. The turn's capture then leaves those out: eve keeps some of them word
 * for word after the compaction (always the user's message), and the rest are gone from history.
 *
 * Nothing here throws: a failure is logged without content, and a refusal that means capture
 * cannot work as set up (no capture folder for a workspace key, a folder the key may not write)
 * warns once with what to do and stops capture, for the process with a fixed key, for that caller
 * with an apiKey function.
 */
export function captureHandlers(input: {
  options: CaptureOptions;
  connection: Pick<ConnectionOptions, 'apiKey'>;
  client: ClientFactory;
}) {
  const { options, connection, client } = input;
  const states = stateStore();
  const stopped = new Set<string>();
  const done = new Set<string>();
  const warned = new Set<string>();
  let announced = false;

  const warnOnce = (key: string, line: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`${PREFIX} ${line}`);
  };

  async function capture(ctx: CaptureContext, phase: 'completed' | 'compaction'): Promise<void> {
    const turn = ctx.turn;
    if (turn === null) return; // between turns: every completed turn was captured when it ended
    const holder = holderOf(connection, ctx);
    if (stopped.has(holder) || done.has(ctx.operationId)) return;
    const sessionId = ctx.session.id;
    const slot = ctx.memory.slot;
    try {
      const messages = turnMessages(ctx.messages, turn);
      if (messages === null) {
        warnOnce('no-turn', 'Capture skipped a turn whose first message was not in the history.');
        return;
      }
      const before = states.get(sessionId, slot);
      const state = before.turn === turn.id ? before : fresh();
      const seen = new Set(state.seen);
      // Keyed by the transcript each message becomes, which eve's copies of a message after a
      // compaction still match, and by its tool call ids, so a call the model makes again with
      // the same result is a new message.
      const fresher = messages
        .map((message) => ({ message, text: toTranscript([message]) }))
        .filter(({ text }) => text !== '')
        .map(({ message, text }) => ({ message, key: hash(`${callIds(message)}\n${text}`) }))
        .filter(({ key }) => !seen.has(key));
      const kept: Message[] = fresher.map(({ message }) => message);
      const ref =
        phase === 'completed'
          ? `${sessionId}#turn-${turn.sequence + 1}`
          : `${sessionId}#turn-${turn.sequence + 1}#compaction-${state.parts + 1}`;
      let stored: Source[] = [];
      if (kept.length > 0) {
        const brain = await client(ctx, ctx.abortSignal);
        stored = await brain.capture({
          messages: kept,
          ref,
          client: 'eve',
          ...(options.folder === undefined ? {} : { folder: options.folder }),
          ...(options.private ? { private: true } : {}),
        });
      }
      states.set(
        sessionId,
        slot,
        phase === 'completed'
          ? fresh()
          : {
              turn: turn.id,
              seen: [...seen, ...fresher.map(({ key }) => key)],
              parts: state.parts + (kept.length > 0 ? 1 : 0),
            },
      );
      done.add(ctx.operationId);
      if (done.size > DONE_MAX) done.delete(done.values().next().value ?? '');
      const first = stored[0];
      if (!announced && first !== undefined) {
        announced = true;
        const where =
          first.folder ??
          (first.visibility === 'private' ? 'private to the key owner' : 'the workspace');
        console.info(
          `${PREFIX} Capture is on: each eve turn is stored in One Brain as a session (here: ${where}). Pass capture: false to turn it off.`,
        );
      }
    } catch (error) {
      if (ctx.abortSignal?.aborted) return;
      if (isLasting(error)) {
        stopped.add(holder);
        warnOnce(
          `stop:${holder}`,
          `One Brain refused a capture, so capture is off${holder === 'key' ? ' for this process' : ' for this caller'}: ${describeError(error)}. ${advice(error, options)}`,
        );
        return;
      }
      console.warn(`${PREFIX} A capture failed and was skipped: ${describeError(error)}`);
    }
  }

  return {
    'turn.completed': (ctx: CaptureContext) => capture(ctx, 'completed'),
    'compaction.requested': (ctx: CaptureContext) => capture(ctx, 'compaction'),
  };
}
