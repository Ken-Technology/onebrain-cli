import { join } from 'node:path';
import {
  child,
  findNestedHook,
  hasFolder,
  parseHookInput,
  updateJson,
  upsertNestedHook,
} from './files.ts';
import type { AgentClient } from './index.ts';

// MCP: ~/.claude.json, top-level mcpServers; ${VAR} expands in headers (code.claude.com/docs/en/mcp).
// Hook: ~/.claude/settings.json, hooks.SessionEnd (code.claude.com/docs/en/hooks).
export const claudeCode: AgentClient = {
  name: 'claude-code',
  label: 'Claude Code',
  detect: (home) => hasFolder(home, '.claude'),
  registerMcp(home, server) {
    const file = join(home, '.claude.json');
    updateJson(file, (doc) => {
      child(doc, 'mcpServers')[server.name] = {
        type: 'http',
        url: server.url,
        ...(server.keyEnv ? { headers: { Authorization: `Bearer \${${server.keyEnv}}` } } : {}),
      };
    });
    return file;
  },
  installHook(home, command) {
    const file = join(home, '.claude', 'settings.json');
    updateJson(file, (doc) =>
      upsertNestedHook(doc, 'SessionEnd', command, ' init hook claude-code'),
    );
    return file;
  },
  installedHook: (home) =>
    findNestedHook(join(home, '.claude', 'settings.json'), 'SessionEnd', ' init hook claude-code'),
  readHook: parseHookInput,
};
