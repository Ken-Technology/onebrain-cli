import { ONE_BRAIN_NOTICE, type SearchResponse } from '@useonebrain/sdk';

/** How recall searches One Brain before each turn. */
export type RecallOptions = {
  /** How many results to recall each turn. Default 5, at most 20. */
  limit?: number;
  /** Which kinds to search. Default: files, skills and memories. */
  kinds?: ('file' | 'skill' | 'memory')[];
  /** Search only this folder and the folders under it. */
  folder?: string;
  /** The longest snippet of a result, in characters. Default 500. */
  snippetChars?: number;
};

export const RECALL_DEFAULTS = { limit: 5, snippetChars: 500 } as const;
/** The API takes queries of up to 500 characters. */
const QUERY_MAX = 500;

/** The search query for a message: its text with runs of whitespace as one space, at most 500 characters. */
export function recallQuery(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= QUERY_MAX ? compact : compact.slice(0, QUERY_MAX).trimEnd();
}

type Result = SearchResponse['data'][number];

/** A snippet cut to `max` characters, at a word end when there is one near. */
function cut(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max);
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()} …`;
}

/** Where a result is: a file's or skill's path, or a memory's id. */
export function whereOf(result: Result): string {
  return result.kind === 'memory' || result.path === null
    ? `memory ${result.id}`
    : `${result.kind} ${result.path}`;
}

/**
 * One recalled result as the model reads it: the notice first, then where it is in One Brain,
 * then its snippet quoted line by line, so nothing in it reads as the agent's own instructions,
 * then how to read the whole of it when the slot has tools.
 */
export function recallMessage(input: {
  result: Result;
  workspace: string;
  rank: number;
  of: number;
  snippetChars: number;
  readTool: string | null;
}): string {
  const { result } = input;
  const title = result.title ? ` "${result.title.replace(/\s+/g, ' ')}"` : '';
  const status = result.status === 'unreviewed' ? ', not reviewed yet' : '';
  const lines = [
    ONE_BRAIN_NOTICE,
    `One Brain search result ${input.rank} of ${input.of} for the user's latest message (workspace ${input.workspace}): ${whereOf(result)}${title}${status}`,
    ...cut(result.snippet, input.snippetChars)
      .split('\n')
      .map((line) => `> ${line}`),
  ];
  if (input.readTool !== null) {
    const arg =
      result.kind === 'memory' || result.path === null ? { id: result.id } : { path: result.path };
    lines.push(`Read all of it with ${input.readTool} ${JSON.stringify(arg)}.`);
  }
  return lines.join('\n');
}

/**
 * The recall messages for a search: one per result, at most `limit`. Each has the id
 * `onebrain:<slot>:recall-<rank>`, so a turn's results replace the ones the turn before recalled
 * at the same rank: recall never holds more than `limit` messages in the model's context, however
 * long the session runs.
 */
export function recallMessages(input: {
  found: SearchResponse;
  slot: string;
  limit: number;
  snippetChars: number;
  readTool: string | null;
}): { id: string; content: string }[] {
  const results = input.found.data.slice(0, input.limit);
  return results.map((result, index) => ({
    id: `onebrain:${input.slot}:recall-${index + 1}`,
    content: recallMessage({
      result,
      workspace: input.found.workspace,
      rank: index + 1,
      of: results.length,
      snippetChars: input.snippetChars,
      readTool: input.readTool,
    }),
  }));
}
