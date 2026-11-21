import { type Message, type MessagePart, ONE_BRAIN_NOTICE } from '@useonebrain/sdk';

/**
 * A message of eve's history as a memory handler gets it: the AI SDK's model message, and on user
 * messages eve's `kind` ("user" for what a person sent; "context.instruction", "context.compaction",
 * "memory.load" and the like for what eve itself put there) and `metadata["eve.turn"]`, the turn
 * the message started.
 */
export type HistoryMessage = {
  readonly role: string;
  readonly content: unknown;
  readonly kind?: unknown;
  readonly metadata?: unknown;
};

/** The turn eve passes a handler: its id, its new input messages and its number in the session. */
export type HistoryTurn = {
  readonly id: string;
  readonly input: readonly HistoryMessage[];
  readonly sequence: number;
};

/** A user message a person sent, not one eve wrote (instructions, a compaction summary, a recall). */
export function isPersonMessage(message: HistoryMessage): boolean {
  return message.role === 'user' && (message.kind === undefined || message.kind === 'user');
}

/** The turn a user message started, from eve's `metadata["eve.turn"]`. */
export function turnOf(message: HistoryMessage): string | undefined {
  if (message.role !== 'user' || typeof message.metadata !== 'object' || message.metadata === null)
    return undefined;
  const turn = (message.metadata as Record<string, unknown>)['eve.turn'];
  return typeof turn === 'string' ? turn : undefined;
}

/** The text of a message's text parts, joined by line ends. */
export function textOf(message: HistoryMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

/**
 * The first line of every skill onebrainSkills builds from One Brain. Capture recognizes a loaded
 * skill by it and keeps only the notice in its place, as One Brain's other answers carry: the
 * learning loop leaves those out, so a skill is not learned back from a session that read it.
 */
export const SKILL_MARKER = '<!-- onebrain-skill:';

/** What eve puts on a tool result it shortened while compacting: a copy of one it had in full. */
const CAPPED_RESULT = '[Truncated by eve: tool result reduced during context compaction.';
/** What eve puts in the user's message it cut to fit while compacting: a copy too. */
const CUT_MESSAGE = 'characters from the middle of this message were cut during context compaction';
/** Parts that are bookkeeping, not conversation: approvals, eve's own parts. */
const BOOKKEEPING = new Set(['tool-approval-request', 'tool-approval-response', 'custom']);

const isCappedResult = (part: Record<string, unknown>): boolean => {
  if (part.type !== 'tool-result') return false;
  const output = part.output as { type?: unknown; value?: unknown } | undefined;
  if (typeof output?.value === 'string') return output.value.startsWith(CAPPED_RESULT);
  if (output?.type === 'content' && Array.isArray(output.value)) {
    const [first] = output.value as { type?: unknown; text?: unknown }[];
    return typeof first?.text === 'string' && first.text.startsWith(CAPPED_RESULT);
  }
  return false;
};

/**
 * The messages of the turn `turn` in eve's history: from the first user message that started it
 * (eve marks it with the turn's id) to the end, as messages @useonebrain/sdk's capture takes.
 * Left out: what eve wrote itself (instructions, compaction summaries, continuations), system
 * messages, approval bookkeeping, and copies eve made while compacting (a shortened tool result,
 * a cut user message), which were captured in full before the compaction.
 */
export function turnMessages(
  messages: readonly HistoryMessage[],
  turn: HistoryTurn,
): Message[] | null {
  let start = messages.findIndex((message) => turnOf(message) === turn.id);
  if (start < 0) {
    // An eve that does not mark turns: the turn's input as eve passed it, found from the end.
    const first = turn.input[0];
    const wanted = first === undefined ? undefined : JSON.stringify(first.content);
    start =
      wanted === undefined
        ? -1
        : messages.findLastIndex(
            (one) => one.role === 'user' && JSON.stringify(one.content) === wanted,
          );
  }
  if (start < 0) return null;
  const out: Message[] = [];
  for (const message of messages.slice(start)) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      if (!isPersonMessage(message)) continue;
      if (textOf(message).includes(CUT_MESSAGE)) continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool')
      continue;
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const parts = (message.content as Record<string, unknown>[])
      .filter(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          typeof part.type === 'string' &&
          !BOOKKEEPING.has(part.type) &&
          !isCappedResult(part),
      )
      .map((part) =>
        part.type === 'tool-result' && JSON.stringify(part.output ?? null).includes(SKILL_MARKER)
          ? { ...part, output: { type: 'text', value: `${ONE_BRAIN_NOTICE} (a One Brain skill)` } }
          : part,
      ) as MessagePart[];
    if (parts.length > 0) out.push({ role: message.role, content: parts });
  }
  return out;
}

/** The latest thing the person said in the turn: the text of its last person message. */
export function latestUserText(turn: HistoryTurn): string {
  for (let index = turn.input.length - 1; index >= 0; index -= 1) {
    const message = turn.input[index];
    if (message !== undefined && isPersonMessage(message)) {
      const text = textOf(message).trim();
      if (text !== '') return text;
    }
  }
  return '';
}
