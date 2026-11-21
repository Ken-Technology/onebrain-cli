import { type components, type OneBrain, OneBrainError } from '@useonebrain/sdk';
import { type ConnectOptions, lazyBrain } from './connect.ts';
import { type AnyMessage, toOneBrainMessages } from './messages.ts';

type Source = components['schemas']['Source'];

/** Where a capture goes. With neither, the server decides: the workspace's capture folder, else private to the key's owner. */
export type CaptureWhere = {
  /** A folder the key may write. */
  folder?: string;
  /** Private to the person the key acts for. A workspace agent's key has no private sources. */
  private?: boolean;
};

/** The label prefix of every capture this package stores: a ref `s1#turn-2` is stored as `ai-sdk:s1#turn-2`. */
export const CLIENT = 'ai-sdk';

const ANNOUNCE =
  'One Brain: capturing each finished turn as a session (the user message, the answer and its tool calls in short). Pass capture: false to turn it off.';

// Per process, as the warnings promise: one line when capture first runs, one warning when the
// server refuses a capture (which also stops capturing), one when a capture fails for another reason.
const state = { announced: false, stopped: false, warned: false };

/** For tests: forget what this process announced, warned and stopped. */
export function resetCaptureState(): void {
  state.announced = false;
  state.stopped = false;
  state.warned = false;
}

/**
 * Stores one turn as a session source. Never throws and never rejects: a refusal by the server
 * (400, 401, 403, 404 or 422, or no key or workspace) warns once and stops capture for this
 * process; any other failure warns once and is tried again on the next turn. Resolves with the sources stored, or [] when
 * nothing was stored.
 */
export async function captureTurn(
  brain: OneBrain,
  input: { messages: readonly AnyMessage[]; ref: string; where?: CaptureWhere },
): Promise<Source[]> {
  if (state.stopped) return [];
  const messages = toOneBrainMessages(input.messages);
  if (messages.length === 0) return [];
  if (!state.announced) {
    state.announced = true;
    console.info(ANNOUNCE);
  }
  try {
    return await brain.capture({
      messages,
      ref: input.ref,
      client: CLIENT,
      ...(input.where?.folder === undefined ? {} : { folder: input.where.folder }),
      ...(input.where?.private ? { private: true } : {}),
    });
  } catch (error) {
    report(error);
    return [];
  }
}

/** Codes that mean the request can never succeed as sent, so capture stops. */
const REFUSED = new Set([400, 401, 403, 404, 422]);

function report(error: unknown): void {
  if (!(error instanceof OneBrainError)) {
    if (state.warned) return;
    state.warned = true;
    // The error's name only: a network error's message can carry the URL, and the URL a key.
    console.warn(
      `One Brain: a session capture failed (${(error as Error)?.name ?? 'error'}). Capture tries again on the next turn.`,
    );
    return;
  }
  const refused =
    REFUSED.has(error.status) || error.code === 'no_api_key' || error.code === 'no_workspace';
  if (!refused) {
    if (state.warned) return;
    state.warned = true;
    console.warn(
      `One Brain: a session capture failed (${error.code}${error.status ? `, ${error.status}` : ''}). Capture tries again on the next turn.`,
    );
    return;
  }
  state.stopped = true;
  // OneBrainError messages are the API's own or the SDK's: never a key, a token or content.
  console.warn(
    `One Brain refused a session capture (${error.code}${error.status ? `, ${error.status}` : ''}): ${sentence(error.message)} ${advice(error)} Capture is off until this process restarts.`,
  );
}

/** A message that ends like a sentence, so the advice after it reads apart. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

function advice(error: OneBrainError): string {
  if (error.code === 'no_api_key' || error.status === 401) {
    return 'Check the key: ONEBRAIN_API_KEY, or the apiKey option.';
  }
  if (error.code === 'no_workspace' || error.status === 404) {
    return 'Check ONEBRAIN_URL and ONEBRAIN_WORKSPACE.';
  }
  if (error.status === 403) {
    return 'The key may not store sessions there: pass capture: { folder } with a folder it may write, or capture: false.';
  }
  return "A workspace agent's key has no private sessions: set a capture folder in the workspace's settings, or pass capture: { folder }, or capture: false.";
}

export type CaptureSessionOptions = ConnectOptions &
  CaptureWhere & {
    /** This turn's messages only: the user message and what the model answered (`responseMessages`). */
    messages: readonly AnyMessage[];
    /** The conversation's id, the same on every turn. */
    sessionId: string;
    /** The turn's number in the conversation, from 1. */
    turn: number;
  };

/**
 * Stores one finished turn as a session source with the ref `<sessionId>#turn-<turn>` (stored as
 * `ai-sdk:<sessionId>#turn-<turn>`), for code that captures in `onEnd` instead of using
 * withOneBrain. Pass only this turn's messages: One Brain tells sessions apart by their content,
 * so sending the whole conversation each turn stores every earlier turn again.
 *
 * Never throws: a refusal warns once and turns capture off for the process (see captureTurn).
 */
export async function captureSession(options: CaptureSessionOptions): Promise<Source[]> {
  const { messages, sessionId, turn, folder, private: own, ...connect } = options;
  return captureTurn(lazyBrain(connect)(), {
    messages,
    ref: `${sessionId}#turn-${turn}`,
    where: { ...(folder === undefined ? {} : { folder }), ...(own ? { private: true } : {}) },
  });
}
