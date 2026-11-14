#!/usr/bin/env node
import { readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { ApiError, CliError, type Command, getClient, type Io } from './client.ts';

/** Lists the top-level .ts files of `dir` and imports each as a command. Folders are skipped. */
export async function loadCommands(
  dir: URL = new URL('./commands/', import.meta.url),
): Promise<Command[]> {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
  const commands: Command[] = [];
  for (const file of files) {
    const module = (await import(new URL(file, dir).href)) as { default?: Partial<Command> };
    const command = module.default;
    if (!command || typeof command.name !== 'string' || typeof command.run !== 'function') {
      throw new Error(`${file} does not export a command`);
    }
    commands.push(command as Command);
  }
  return commands;
}

/** Takes the global `--workspace <slug>` / `--workspace=<slug>` flag out of `argv`. */
export function splitGlobalFlags(argv: string[]): { args: string[]; workspace: string | null } {
  const args: string[] = [];
  let workspace: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--workspace') {
      workspace = argv[++i] ?? null;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
    } else {
      args.push(arg);
    }
  }
  return { args, workspace };
}

function usage(commands: Command[]): string {
  const width = Math.max(0, ...commands.map((c) => c.name.length));
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.describe.split('\n')[0]}`);
  return `Usage: onebrain <command> [args]\n\nCommands:\n${lines.join('\n')}\n\nGlobal flag: --workspace <slug>\n`;
}

export async function main(argv: string[], io: Io, commands: Command[]): Promise<number> {
  const { args } = splitGlobalFlags(argv);
  const [name, ...rest] = args;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    io.stdout(usage(commands));
    return 0;
  }
  const command = commands.find((c) => c.name === name);
  if (!command) {
    io.stderr(`error: unknown command ${name}\n`);
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(`${command.describe}\n`);
    return 0;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    if (error instanceof ApiError) {
      io.stderr(`error: ${error.code}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof CliError) {
      io.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`error: ${(error as Error).message}\n`);
      return 2;
    }
    if (error instanceof TypeError) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      io.stderr(
        `error: cannot reach the One Brain API (${cause?.code ?? cause?.message ?? error.message})\n`,
      );
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { args, workspace } = splitGlobalFlags(process.argv.slice(2));
  const io: Io = {
    stdout: (out) => void process.stdout.write(out),
    stderr: (out) => void process.stderr.write(out),
    readStdin: async () => (process.stdin.isTTY ? null : text(process.stdin)),
    env: process.env,
    home: process.env.HOME ?? homedir(),
    cwd: process.cwd(),
    client: (options) => getClient({ ...options, workspace }),
  };
  process.exitCode = await main(args, io, await loadCommands());
}
