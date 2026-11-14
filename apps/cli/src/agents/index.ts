import { claudeCode } from './claude-code.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { gemini } from './gemini.ts';

export type ClientName = 'claude-code' | 'codex' | 'cursor' | 'gemini';

/** keyEnv: the env var holding the agent key; null means the client signs the person in. */
export type McpServer = { name: 'onebrain'; url: string; keyEnv: string | null };

export type AgentClient = {
  name: ClientName;
  label: string;
  detect(home: string): boolean;
  /** Returns the file it changed. Throws a CliError for a file it cannot safely edit. */
  registerMcp(home: string, server: McpServer): string;
  /** Returns the file it changed, or null when the client has no session-end hook. */
  installHook(home: string, command: string): string | null;
  /** The command of the session-end hook init installed before, or null. */
  installedHook(home: string): string | null;
  readHook(input: string): { transcriptPath: string; sessionId: string } | null;
  /** Something the person still has to do before the hook runs. */
  hookNote?: string;
};

export const clients: Record<ClientName, AgentClient> = {
  'claude-code': claudeCode,
  codex,
  cursor,
  gemini,
};
