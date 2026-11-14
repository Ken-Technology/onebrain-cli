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

// MCP: ~/.gemini/settings.json, mcpServers.<name> = { httpUrl, headers }; settings strings expand $VAR / ${VAR}.
// Hook: the same file, hooks.SessionEnd (github.com/google-gemini/gemini-cli, docs/hooks and docs/tools/mcp-server.md).
export const gemini: AgentClient = {
  name: 'gemini',
  label: 'Gemini CLI',
  detect: (home) => hasFolder(home, '.gemini'),
  registerMcp(home, server) {
    const file = join(home, '.gemini', 'settings.json');
    updateJson(file, (doc) => {
      child(doc, 'mcpServers')[server.name] = {
        httpUrl: server.url,
        ...(server.keyEnv ? { headers: { Authorization: `Bearer $${server.keyEnv}` } } : {}),
      };
    });
    return file;
  },
  installHook(home, command) {
    const file = join(home, '.gemini', 'settings.json');
    updateJson(file, (doc) => upsertNestedHook(doc, 'SessionEnd', command, ' init hook gemini'));
    return file;
  },
  installedHook: (home) =>
    findNestedHook(join(home, '.gemini', 'settings.json'), 'SessionEnd', ' init hook gemini'),
  readHook: parseHookInput,
};
