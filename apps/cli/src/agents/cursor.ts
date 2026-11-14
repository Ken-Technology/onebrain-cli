import { join } from 'node:path';
import { child, hasFolder, parseHookInput, readJson, updateJson } from './files.ts';
import type { AgentClient } from './index.ts';

// MCP: ~/.cursor/mcp.json, mcpServers.<name> = { url, headers }; ${env:VAR} in headers (cursor.com/docs/context/mcp).
// Hook: ~/.cursor/hooks.json, { version: 1, hooks: { sessionEnd: [{ command }] } } (cursor.com/docs/agent/hooks).
const MARKER = ' init hook cursor';
export const cursor: AgentClient = {
  name: 'cursor',
  label: 'Cursor',
  detect: (home) => hasFolder(home, '.cursor'),
  registerMcp(home, server) {
    const file = join(home, '.cursor', 'mcp.json');
    updateJson(file, (doc) => {
      child(doc, 'mcpServers')[server.name] = {
        url: server.url,
        ...(server.keyEnv ? { headers: { Authorization: `Bearer \${env:${server.keyEnv}}` } } : {}),
      };
    });
    return file;
  },
  installHook(home, command) {
    const file = join(home, '.cursor', 'hooks.json');
    updateJson(file, (doc) => {
      doc.version ??= 1;
      const hooks = child(doc, 'hooks');
      const entries = Array.isArray(hooks.sessionEnd)
        ? (hooks.sessionEnd as Record<string, unknown>[])
        : [];
      hooks.sessionEnd = entries;
      const own = entries.find(
        (entry) => typeof entry.command === 'string' && entry.command.includes(MARKER),
      );
      if (own) own.command = command;
      else entries.push({ command });
    });
    return file;
  },
  installedHook(home) {
    const hooks = readJson(join(home, '.cursor', 'hooks.json'))?.hooks as
      | Record<string, unknown>
      | undefined;
    const entries = Array.isArray(hooks?.sessionEnd)
      ? (hooks.sessionEnd as { command?: unknown }[])
      : [];
    const own = entries.find(
      (entry) => typeof entry.command === 'string' && entry.command.includes(MARKER),
    );
    return (own?.command as string | undefined) ?? null;
  },
  readHook: parseHookInput,
};
