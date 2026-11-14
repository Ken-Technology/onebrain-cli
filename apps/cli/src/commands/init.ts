import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ClientName, clients, type McpServer } from '../agents/index.ts';
import { apiUrl, CliError, type Command, type Io } from '../client.ts';
import { configDir } from '../config.ts';
import { syncLines, syncSkills } from '../skills/sync.ts';

const USAGE =
  'Usage: onebrain init [--client claude-code|codex|cursor|gemini]... [--share-captures | --no-share-captures] [--skip-hook] [--skip-skills]';

// The hook's last word: --private (the default) keeps captures the person's own, whatever the
// workspace's capture folder; --share-captures lets them follow it. A hook with neither (written
// before this choice existed) keeps them private too.
const SHARE = '--share-captures';
const NO_SHARE = '--no-share-captures';
const PRIVATE = '--private';
const PRIVATE_LINE = 'Session captures stay private to you.';
const SHARED_LINE = "Session captures go to the workspace's capture folder when one is set.";

const CLI = fileURLToPath(new URL('../index.ts', import.meta.url));
const NAMES = Object.keys(clients) as ClientName[];
const isClient = (name: string): name is ClientName => NAMES.includes(name as ClientName);
const tilde = (home: string, path: string) =>
  path.startsWith(home) ? `~${path.slice(home.length)}` : path;

/**
 * Called by a client's session-end hook (`init hook <client> [--private | --share-captures]`):
 * starts `capture` in the background and exits 0 whatever happens. The capture is --private
 * unless the hook says --share-captures.
 */
export async function handleHook(
  args: string[],
  io: Io,
  startCapture: (args: string[]) => void = spawnCapture(io),
): Promise<number> {
  try {
    const [name = '', ...flags] = args;
    if (!isClient(name)) return 0;
    const input = await io.readStdin();
    const session = input === null ? null : clients[name].readHook(input);
    if (session) {
      startCapture([
        'capture',
        session.transcriptPath,
        '--ref',
        `${name}:${session.sessionId}`,
        ...(flags.includes(SHARE) ? [] : [PRIVATE]),
      ]);
    }
  } catch {}
  return 0;
}

const spawnCapture = (io: Io) => (args: string[]) => {
  mkdirSync(configDir(io.home), { recursive: true });
  const log = openSync(join(configDir(io.home), 'capture.log'), 'a');
  spawn(process.execPath, [CLI, ...args], { detached: true, stdio: ['ignore', log, log] }).unref();
};

export default {
  name: 'init',
  describe: `Set up your AI clients: the One Brain MCP server, your skills and a session-end hook that captures each session, private to you unless you pass ${SHARE}. A key limited to a path prefix, or a workspace agent's key, cannot hold private captures, so it needs ${SHARE} and a workspace capture folder it may write.\n\n${USAGE}`,
  run: async (args, io) => {
    if (args[0] === 'hook') return handleHook(args.slice(1), io);
    const { values } = parseArgs({
      args,
      allowNegative: true,
      options: {
        client: { type: 'string', multiple: true },
        'share-captures': { type: 'boolean' },
        'skip-hook': { type: 'boolean' },
        'skip-skills': { type: 'boolean' },
      },
    });
    const given = values.client ?? [];
    const bad = given.find((name) => !isClient(name));
    if (bad) throw new CliError(`Unknown client ${bad}. ${USAGE}`, 2);
    const chosen =
      given.length > 0 ? (given as ClientName[]) : NAMES.filter((n) => clients[n].detect(io.home));
    if (chosen.length === 0) {
      io.stderr('No supported AI client found. Pass --client <name> to set one up anyway.\n');
    }

    const server: McpServer = {
      name: 'onebrain',
      url: `${apiUrl(io.env, io.home)}/mcp`,
      keyEnv: io.env.ONEBRAIN_API_KEY ? 'ONEBRAIN_API_KEY' : null,
    };
    const names = [...new Set(chosen)];
    // Shared only when the person says so on this machine: the flag, else a hook that already does.
    const kept =
      values['share-captures'] === undefined &&
      names.some((name) => clients[name].installedHook(io.home)?.endsWith(` ${SHARE}`));
    const share = values['share-captures'] ?? kept;
    let hooked = false;
    let failed = false;
    for (const name of names) {
      const client = clients[name];
      try {
        const parts = [`MCP server in ${tilde(io.home, client.registerMcp(io.home, server))}`];
        if (!values['skip-hook']) {
          const command = `"${process.execPath}" "${CLI}" init hook ${name} ${share ? SHARE : PRIVATE}`;
          const file = client.installHook(io.home, command);
          if (file) hooked = true;
          parts.push(
            file
              ? `session-end hook in ${tilde(io.home, file)}${client.hookNote ? ` (${client.hookNote})` : ''}`
              : `no session-end hook (${client.label} has no such event)`,
          );
        }
        io.stdout(`${client.label}: ${parts.join(', ')}\n`);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        io.stderr(`${client.label}: ${error.message}\n`);
        failed = true;
      }
    }
    if (hooked) {
      const note = kept ? ` Kept from before; ${NO_SHARE} turns it off.` : '';
      io.stdout(`${share ? SHARED_LINE : PRIVATE_LINE}${note}\n`);
    }

    if (!values['skip-skills']) {
      const result = await syncSkills(io);
      io.stdout(`${syncLines(result).join('\n')}\n`);
      if (result.failed.length > 0) failed = true;
    }
    return failed ? 1 : 0;
  },
} satisfies Command;
