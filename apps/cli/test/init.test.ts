import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clients, type McpServer } from '../src/agents/index.ts';
import init, { handleHook } from '../src/commands/init.ts';
import { fakeApi, testIo } from './helpers.ts';

const server: McpServer = {
  name: 'onebrain',
  url: 'http://localhost:8787/mcp',
  keyEnv: 'ONEBRAIN_API_KEY',
};
const command = (name: string) =>
  `"/usr/bin/node" "/opt/onebrain/apps/cli/src/index.ts" init hook ${name}`;
const json = (home: string, path: string) => JSON.parse(readFileSync(join(home, path), 'utf8'));
const text = (home: string, path: string) => readFileSync(join(home, path), 'utf8');
const emptySkills = () =>
  fakeApi({ 'GET /v1/workspaces/kenso/skills': () => ({ body: { data: [] } }) }).api;

describe('Claude Code', () => {
  it('adds the server and the hook once and keeps every other setting', () => {
    const { home } = testIo();
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ theme: 'dark', mcpServers: { other: { type: 'stdio', command: 'x' } } }),
    );
    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.claude/settings.json'),
      JSON.stringify({
        hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
      }),
    );
    for (let i = 0; i < 2; i++) {
      clients['claude-code'].registerMcp(home, server);
      clients['claude-code'].installHook(home, command('claude-code'));
    }
    const config = json(home, '.claude.json');
    expect(config.theme).toBe('dark');
    expect(Object.keys(config.mcpServers)).toEqual(['other', 'onebrain']);
    expect(config.mcpServers.onebrain).toEqual({
      type: 'http',
      url: 'http://localhost:8787/mcp',
      headers: { Authorization: `Bearer \${ONEBRAIN_API_KEY}` },
    });
    expect(JSON.stringify(config.mcpServers.onebrain)).not.toMatch(/ob_[A-Za-z0-9]/);
    const settings = text(home, '.claude/settings.json');
    expect(settings.match(/init hook claude-code/g)).toHaveLength(1);
    expect(settings).toContain('echo bye');
    expect(existsSync(join(home, '.claude.json.onebrain-backup'))).toBe(true);
  });

  it('writes no header when the client signs in itself', () => {
    const { home } = testIo();
    clients['claude-code'].registerMcp(home, { ...server, keyEnv: null });
    expect(json(home, '.claude.json').mcpServers.onebrain).toEqual({
      type: 'http',
      url: 'http://localhost:8787/mcp',
    });
  });

  it('reads the transcript path and session id from its hook input', () => {
    expect(
      clients['claude-code'].readHook(
        JSON.stringify({
          session_id: 's1',
          transcript_path: '/t/s1.jsonl',
          hook_event_name: 'SessionEnd',
        }),
      ),
    ).toEqual({ transcriptPath: '/t/s1.jsonl', sessionId: 's1' });
    expect(clients['claude-code'].readHook('not json')).toBeNull();
  });
});

describe('Codex', () => {
  it('replaces its managed TOML block and keeps the rest of the file', () => {
    const { home } = testIo();
    mkdirSync(join(home, '.codex'));
    const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    writeFileSync(join(home, '.codex/config.toml'), original);
    clients.codex.registerMcp(home, server);
    clients.codex.registerMcp(home, { ...server, url: 'https://brain.test/mcp' });
    const toml = text(home, '.codex/config.toml');
    expect(toml.startsWith(original)).toBe(true);
    expect(toml.match(/\[mcp_servers\.onebrain\]/g)).toHaveLength(1);
    expect(toml).toContain('url = "https://brain.test/mcp"');
    expect(toml).toContain('bearer_token_env_var = "ONEBRAIN_API_KEY"');
    expect(existsSync(join(home, '.codex/config.toml.onebrain-backup'))).toBe(true);
  });

  it('leaves a hand-written onebrain table alone', () => {
    const { home } = testIo();
    mkdirSync(join(home, '.codex'));
    const mine = '[mcp_servers.onebrain]\nurl = "https://mine.test/mcp"\n';
    writeFileSync(join(home, '.codex/config.toml'), mine);
    expect(() => clients.codex.registerMcp(home, server)).toThrow(/already/);
    expect(text(home, '.codex/config.toml')).toBe(mine);
  });

  it('adds the SessionEnd hook to hooks.json once', () => {
    const { home } = testIo();
    for (let i = 0; i < 2; i++) clients.codex.installHook(home, command('codex'));
    const hooks = json(home, '.codex/hooks.json').hooks.SessionEnd;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hooks[0]).toEqual({ type: 'command', command: command('codex') });
  });
});

describe('Cursor', () => {
  it('adds the server with an env reference and a sessionEnd hook', () => {
    const { home } = testIo();
    mkdirSync(join(home, '.cursor'));
    writeFileSync(
      join(home, '.cursor/hooks.json'),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: 'x' }] } }),
    );
    for (let i = 0; i < 2; i++) {
      clients.cursor.registerMcp(home, server);
      clients.cursor.installHook(home, command('cursor'));
    }
    expect(json(home, '.cursor/mcp.json').mcpServers.onebrain).toEqual({
      url: 'http://localhost:8787/mcp',
      headers: { Authorization: `Bearer \${env:ONEBRAIN_API_KEY}` },
    });
    const hooks = json(home, '.cursor/hooks.json');
    expect(hooks.hooks.stop).toEqual([{ command: 'x' }]);
    expect(hooks.hooks.sessionEnd).toEqual([{ command: command('cursor') }]);
  });

  it('needs a transcript path in its hook input', () => {
    const ok = JSON.stringify({
      conversation_id: 'c1',
      session_id: 'c1',
      transcript_path: '/t/c.jsonl',
    });
    expect(clients.cursor.readHook(ok)).toEqual({ transcriptPath: '/t/c.jsonl', sessionId: 'c1' });
    expect(
      clients.cursor.readHook(JSON.stringify({ session_id: 'c1', transcript_path: null })),
    ).toBeNull();
  });
});

describe('Gemini CLI', () => {
  it('adds httpUrl, an env reference and a SessionEnd hook to settings.json', () => {
    const { home } = testIo();
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini/settings.json'), JSON.stringify({ theme: 'x' }));
    for (let i = 0; i < 2; i++) {
      clients.gemini.registerMcp(home, server);
      clients.gemini.installHook(home, command('gemini'));
    }
    const settings = json(home, '.gemini/settings.json');
    expect(settings.theme).toBe('x');
    expect(settings.mcpServers.onebrain).toEqual({
      httpUrl: 'http://localhost:8787/mcp',
      headers: { Authorization: 'Bearer $ONEBRAIN_API_KEY' },
    });
    expect(settings.hooks.SessionEnd).toHaveLength(1);
  });
});

describe('init hook', () => {
  it('starts a capture of the transcript the hook names, and exits 0 even on bad input', async () => {
    const started: string[][] = [];
    const input = JSON.stringify({
      session_id: 's1',
      transcript_path: '/t/s1.jsonl',
      hook_event_name: 'SessionEnd',
    });
    const hook = (args: string[], stdin: string | null) =>
      handleHook(args, testIo({ stdin }).io, (capture) => started.push(capture));
    expect(await hook(['claude-code', '--private'], input)).toBe(0);
    expect(started).toEqual([['capture', '/t/s1.jsonl', '--ref', 'claude-code:s1', '--private']]);
    expect(await hook(['claude-code', '--private'], 'oops')).toBe(0);
    expect(await hook(['nope', '--private'], input)).toBe(0);
    expect(await hook(['claude-code', '--private'], null)).toBe(0);
    expect(started).toHaveLength(1);
  });

  it('captures privately unless the hook says --share-captures, a hook from before the choice too', async () => {
    const started: string[][] = [];
    const input = JSON.stringify({ session_id: 's1', transcript_path: '/t/s1.jsonl' });
    for (const args of [['codex', '--share-captures'], ['codex']]) {
      await handleHook(args, testIo({ stdin: input }).io, (capture) => started.push(capture));
    }
    expect(started).toEqual([
      ['capture', '/t/s1.jsonl', '--ref', 'codex:s1'],
      ['capture', '/t/s1.jsonl', '--ref', 'codex:s1', '--private'],
    ]);
  });

  it('exits 0 when starting the capture throws', async () => {
    const input = JSON.stringify({ session_id: 's1', transcript_path: '/t/s1.jsonl' });
    const boom = () => {
      throw new Error('no spawn');
    };
    expect(await handleHook(['claude-code', '--private'], testIo({ stdin: input }).io, boom)).toBe(
      0,
    );
  });
});

describe('init and session captures', () => {
  const PRIVATE_LINE = 'Session captures stay private to you.';
  const SHARED_LINE = "Session captures go to the workspace's capture folder when one is set.";
  const hookOf = (home: string) =>
    json(home, '.claude/settings.json').hooks.SessionEnd[0].hooks[0].command as string;
  const run = async (home: string | null, args: string[]) => {
    const t = testIo({ api: emptySkills(), ...(home ? { home } : {}) });
    mkdirSync(join(t.home, '.claude'), { recursive: true });
    expect(await init.run(['--skip-skills', ...args], t.io)).toBe(0);
    return { home: t.home, out: t.stdout(), hook: hookOf(t.home) };
  };

  it('writes the hook with --private by default, says so, and keeps it on a second run', async () => {
    const first = await run(null, []);
    expect(first.hook).toMatch(/ init hook claude-code --private$/);
    expect(first.out).toContain(`${PRIVATE_LINE}\n`);
    const again = await run(first.home, []);
    expect(again.hook).toBe(first.hook);
    expect(again.out).toContain(`${PRIVATE_LINE}\n`);
    expect(again.out).not.toContain('Kept from before');
  });

  it('writes it without --private with --share-captures, keeps that without the flag, and --no-share-captures turns it off', async () => {
    const shared = await run(null, ['--share-captures']);
    expect(shared.hook).toMatch(/ init hook claude-code --share-captures$/);
    expect(shared.hook).not.toContain('--private');
    expect(shared.out).toContain(`${SHARED_LINE}\n`);
    const again = await run(shared.home, []);
    expect(again.hook).toBe(shared.hook);
    expect(again.out).toContain(
      `${SHARED_LINE} Kept from before; --no-share-captures turns it off.\n`,
    );
    const settings = text(shared.home, '.claude/settings.json');
    expect(settings.match(/init hook claude-code/g)).toHaveLength(1);
    const off = await run(shared.home, ['--no-share-captures']);
    expect(off.hook).toMatch(/ init hook claude-code --private$/);
    expect(off.out).toContain(`${PRIVATE_LINE}\n`);
  });

  it('turns a hook written before the choice into a private one', async () => {
    const { home } = testIo();
    clients['claude-code'].installHook(home, command('claude-code'));
    const { hook, out } = await run(home, []);
    expect(hook).toMatch(/ init hook claude-code --private$/);
    expect(out).toContain(PRIVATE_LINE);
  });

  it('reads the hook each client installed', () => {
    const { home } = testIo();
    for (const name of ['claude-code', 'codex', 'cursor', 'gemini'] as const) {
      expect(clients[name].installedHook(home)).toBeNull();
      clients[name].installHook(home, `${command(name)} --share-captures`);
      expect(clients[name].installedHook(home)).toBe(`${command(name)} --share-captures`);
    }
  });
});

describe('init', () => {
  it('sets up only the clients it finds, then syncs skills', async () => {
    const t = testIo({ api: emptySkills(), env: { ONEBRAIN_API_KEY: 'ob_x' } });
    mkdirSync(join(t.home, '.claude'));
    expect(await init.run([], t.io)).toBe(0);
    expect(t.stdout()).toContain(
      'Claude Code: MCP server in ~/.claude.json, session-end hook in ~/.claude/settings.json',
    );
    expect(t.stdout()).not.toContain('Codex');
    expect(existsSync(join(t.home, '.codex'))).toBe(false);
    expect(t.stdout()).toContain('Synced 0 skills');
    expect(json(t.home, '.claude/settings.json').hooks.SessionEnd[0].hooks[0].command).toMatch(
      /^".+" ".+index\.ts" init hook claude-code --private$/,
    );
  });

  it('says so and still syncs when no client is found', async () => {
    const t = testIo({ api: emptySkills() });
    expect(await init.run([], t.io)).toBe(0);
    expect(t.stderr()).toContain('No supported AI client found. Pass --client <name>');
    expect(t.stdout()).toContain('Synced 0 skills');
  });

  it('honours --client, --skip-hook and --skip-skills', async () => {
    const t = testIo({ api: emptySkills() });
    expect(await init.run(['--client', 'gemini', '--skip-hook', '--skip-skills'], t.io)).toBe(0);
    expect(t.stdout()).toBe('Gemini CLI: MCP server in ~/.gemini/settings.json\n');
    expect(json(t.home, '.gemini/settings.json').hooks).toBeUndefined();
  });

  it('refuses a client name it does not know', async () => {
    const t = testIo({ api: emptySkills() });
    await expect(init.run(['--client', 'vim'], t.io)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('reports a config file it cannot parse, carries on, and leaves it alone', async () => {
    const t = testIo({ api: emptySkills() });
    mkdirSync(join(t.home, '.cursor'));
    writeFileSync(join(t.home, '.cursor/mcp.json'), '{ not json');
    expect(await init.run(['--client', 'cursor', '--client', 'gemini'], t.io)).toBe(1);
    expect(text(t.home, '.cursor/mcp.json')).toBe('{ not json');
    expect(t.stderr()).toContain('not valid JSON');
    expect(t.stdout()).toContain('Gemini CLI:');
  });
});
