import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from '../client.ts';

type Doc = Record<string, unknown>;

export const hasFolder = (home: string, folder: string): boolean => existsSync(join(home, folder));

const START = '# >>> onebrain (managed by onebrain init) >>>';
const END = '# <<< onebrain <<<';

/** Copies an existing file to `<file>.onebrain-backup` once, then writes `content`. */
function write(path: string, content: string): void {
  if (existsSync(path) && !existsSync(`${path}.onebrain-backup`)) {
    copyFileSync(path, `${path}.onebrain-backup`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Reads a JSON object (a missing file is `{}`), lets `change` edit it, writes it back only when it differs. */
export function updateJson(path: string, change: (doc: Doc) => void): void {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let doc: Doc = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      doc = parsed as Doc;
    } catch {
      throw new CliError(
        `${path} is not valid JSON; fix it or remove it, then run onebrain init again.`,
      );
    }
  }
  change(doc);
  const next = `${JSON.stringify(doc, null, 2)}\n`;
  if (next !== raw) write(path, next);
}

/** The object at `doc[key]`, created when missing. */
export function child(doc: Doc, key: string): Doc {
  const value = doc[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Doc;
  const created: Doc = {};
  doc[key] = created;
  return created;
}

/**
 * Puts `command` under `hooks.<event>` in the `{ hooks: [{ type: 'command', command }] }` shape that
 * Claude Code, Codex and Gemini CLI share. An entry already running `init hook <client>` is replaced
 * in place, so running init again adds nothing.
 */
export function upsertNestedHook(doc: Doc, event: string, command: string, marker: string): void {
  const hooks = child(doc, 'hooks');
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as Doc[]) : [];
  hooks[event] = groups;
  for (const group of groups) {
    const handlers = Array.isArray(group.hooks) ? (group.hooks as Doc[]) : [];
    for (const handler of handlers) {
      if (typeof handler.command === 'string' && handler.command.includes(marker)) {
        handler.command = command;
        return;
      }
    }
  }
  groups.push({ hooks: [{ type: 'command', command }] });
}

/** A JSON object file, or null when it is missing or not one. Never throws. */
export function readJson(path: string): Doc | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Doc) : null;
  } catch {
    return null;
  }
}

/** The command of the `hooks.<event>` entry upsertNestedHook wrote (the one holding `marker`), or null. */
export function findNestedHook(path: string, event: string, marker: string): string | null {
  const hooks = readJson(path)?.hooks as Doc | undefined;
  const groups = Array.isArray(hooks?.[event]) ? (hooks[event] as Doc[]) : [];
  for (const group of groups) {
    const handlers = Array.isArray(group.hooks) ? (group.hooks as Doc[]) : [];
    for (const handler of handlers) {
      if (typeof handler.command === 'string' && handler.command.includes(marker)) {
        return handler.command;
      }
    }
  }
  return null;
}

/** The session id and transcript path out of a hook's stdin JSON, or null when either is missing. */
export function parseHookInput(
  input: string,
): { transcriptPath: string; sessionId: string } | null {
  try {
    const data = JSON.parse(input) as Doc | null;
    const sessionId = data?.session_id ?? data?.conversation_id;
    const transcriptPath = data?.transcript_path;
    if (
      typeof sessionId === 'string' &&
      sessionId &&
      typeof transcriptPath === 'string' &&
      transcriptPath
    ) {
      return { transcriptPath, sessionId };
    }
  } catch {}
  return null;
}

/**
 * Replaces the managed block of a TOML file (or appends it at the end, where a table is always valid).
 * The rest of the file is never parsed. A `[mcp_servers.<name>]` table outside the block was written by hand.
 */
export function replaceBlock(path: string, block: string, handWrittenTable: RegExp): void {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = raw.indexOf(START);
  const end = raw.indexOf(END, start);
  const rest =
    start >= 0 && end > start
      ? raw.slice(0, start) + raw.slice(end + END.length).replace(/^\n/, '')
      : raw;
  if (handWrittenTable.test(rest)) {
    throw new CliError(
      `${path} already has a [mcp_servers.onebrain] table that onebrain did not write; left it alone.`,
    );
  }
  const body = rest.trimEnd();
  const next = `${body}${body.length > 0 ? '\n\n' : ''}${START}\n${block}\n${END}\n`;
  if (next !== raw) write(path, next);
}
