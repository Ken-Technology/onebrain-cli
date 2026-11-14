import { join } from 'node:path';
import {
  findNestedHook,
  hasFolder,
  parseHookInput,
  replaceBlock,
  updateJson,
  upsertNestedHook,
} from './files.ts';
import type { AgentClient } from './index.ts';

// MCP: ~/.codex/config.toml, [mcp_servers.<name>] with url and bearer_token_env_var.
// Hook: ~/.codex/hooks.json, hooks.SessionEnd. Codex asks the person to trust a new hook with /hooks.
// (learn.chatgpt.com/docs/extend/mcp and learn.chatgpt.com/docs/hooks, formerly developers.openai.com/codex)
export const codex: AgentClient = {
  name: 'codex',
  label: 'Codex',
  detect: (home) => hasFolder(home, '.codex'),
  hookNote: 'run /hooks in Codex once to trust the hook',
  registerMcp(home, server) {
    const file = join(home, '.codex', 'config.toml');
    const lines = [`[mcp_servers.${server.name}]`, `url = ${JSON.stringify(server.url)}`];
    if (server.keyEnv) lines.push(`bearer_token_env_var = ${JSON.stringify(server.keyEnv)}`);
    replaceBlock(
      file,
      lines.join('\n'),
      new RegExp(`^\\s*\\[mcp_servers\\.${server.name}[\\].]`, 'm'),
    );
    return file;
  },
  installHook(home, command) {
    const file = join(home, '.codex', 'hooks.json');
    updateJson(file, (doc) => upsertNestedHook(doc, 'SessionEnd', command, ' init hook codex'));
    return file;
  },
  installedHook: (home) =>
    findNestedHook(join(home, '.codex', 'hooks.json'), 'SessionEnd', ' init hook codex'),
  readHook: parseHookInput,
};
