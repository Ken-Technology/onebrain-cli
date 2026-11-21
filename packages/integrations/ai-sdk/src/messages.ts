import type { Message, MessagePart } from '@useonebrain/sdk';

/**
 * A message as the AI SDK has it: a ModelMessage (generateText's `messages`, `responseMessages`),
 * or a message of the prompt a language model receives (what middleware sees). Both are
 * `{ role, content: string | parts }`, with parts typed `text`, `file`, `image`, `tool-call`,
 * `tool-result`, `reasoning`, `tool-approval-request`, ...
 */
export type AnyMessage = { role: string; content: unknown };

type Part = { type: string; [key: string]: unknown };
const isPart = (value: unknown): value is Part =>
  typeof value === 'object' && value !== null && typeof (value as Part).type === 'string';

/**
 * The messages as `@useonebrain/sdk` captures them. Kept: text, tool calls (name and input),
 * tool results, and files and images as their type and name only. Left out: system messages,
 * reasoning, tool approvals, sources and provider-specific parts.
 */
export function toOneBrainMessages(messages: readonly AnyMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    if (typeof message.content === 'string') {
      if (message.content.trim() !== '') out.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const parts = message.content.filter(isPart).flatMap(keptPart);
    if (parts.length > 0) out.push({ role, content: parts });
  }
  return out;
}

function keptPart(part: Part): MessagePart[] {
  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' && part.text !== ''
        ? [{ type: 'text', text: part.text }]
        : [];
    case 'tool-call':
      return [{ type: 'tool-call', toolName: part.toolName, input: part.input }];
    case 'tool-result':
      // A model's own tool results (provider-executed) carry `result`; the prompt's carry `output`.
      return [{ type: 'tool-result', toolName: part.toolName, output: part.output ?? part.result }];
    case 'file':
    case 'image':
      // Never the data: the SDK writes a note of the type and the name or media type.
      return [{ type: part.type, filename: part.filename, mediaType: part.mediaType }];
    default:
      return [];
  }
}

/** The text of a message: its text parts, joined by line ends. */
export function textOf(message: AnyMessage | undefined): string {
  if (message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(isPart)
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n');
}
