import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError, type CliClient, type Command, unwrap } from '../client.ts';

const USAGE = `Usage: onebrain review [list] [--status pending|accepted|dismissed|superseded] [--json]
       onebrain review show <id>        (also: onebrain review <id>)
       onebrain review accept <id>
       onebrain review edit <id> [--file <file>]
       onebrain review dismiss <id> [--reason <text>]`;
const STATUSES = ['pending', 'accepted', 'dismissed', 'superseded'] as const;
type Status = (typeof STATUSES)[number];

/** A line diff from `before` to `after`: ' ' kept, '-' removed, '+' added, removals first. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return `(too large to diff; the new body follows)\n${after}`;
  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i++]}`);
      j++;
    } else if (i < a.length && (j === b.length || at(i + 1, j) >= at(i, j + 1))) {
      out.push(`-${a[i++]}`);
    } else {
      out.push(`+${b[j++]}`);
    }
  }
  return out.join('\n');
}

const base = (workspace: string, id: string) => ({ params: { path: { workspace, id } } });

async function accept(
  { api, workspace }: CliClient,
  id: string,
  body: string | undefined,
  io: { stdout: (t: string) => void; stderr: (t: string) => void },
): Promise<number> {
  try {
    const result = unwrap(
      await api.POST('/v1/workspaces/{workspace}/improvements/{id}/accept', {
        ...base(workspace, id),
        body: body === undefined ? {} : { body },
      }),
    );
    io.stdout(`accepted\n${result.file.path} version ${result.file.version}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'conflict') {
      const path = (await improvementPath(api, workspace, id)) ?? 'The file';
      io.stderr(`${path} changed since this was proposed. It stays pending; review it again.\n`);
      return 1;
    }
    throw error;
  }
}

async function improvementPath(
  api: CliClient['api'],
  workspace: string,
  id: string,
): Promise<string | null> {
  try {
    const { data } = await api.GET(
      '/v1/workspaces/{workspace}/improvements/{id}',
      base(workspace, id),
    );
    return data?.path ?? null;
  } catch {
    return null;
  }
}

export default {
  name: 'review',
  describe: `Review what agents propose to change\n\n${USAGE}`,
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        status: { type: 'string' },
        json: { type: 'boolean' },
        file: { type: 'string' },
        reason: { type: 'string' },
      },
    });
    const [first, second] = positionals;
    const named = ['list', 'show', 'accept', 'edit', 'dismiss'].includes(first ?? '');
    const action = named ? (first as string) : first ? 'show' : 'list';
    const id = named ? second : first;
    const status = values.status ?? 'pending';
    if (
      positionals.length > (named ? (action === 'list' ? 1 : 2) : 1) ||
      (action !== 'list' && !id) ||
      !STATUSES.includes(status as Status)
    ) {
      io.stderr(`${USAGE}\n`);
      return 2;
    }

    const client = await io.client();
    const { api, workspace } = client;

    if (action === 'list') {
      const { data } = unwrap(
        await api.GET('/v1/workspaces/{workspace}/improvements', {
          params: { path: { workspace }, query: { status: status as Status } },
        }),
      );
      if (values.json) io.stdout(`${JSON.stringify(data, null, 2)}\n`);
      else {
        for (const item of data) {
          io.stdout(
            `${item.id}  ${item.path}  ${item.title}  (${item.proposedBy.displayName}, ${item.createdAt.slice(0, 10)})\n`,
          );
        }
        if (data.length === 0) io.stderr('Nothing to review.\n');
      }
      return 0;
    }

    const target = id as string;
    if (action === 'show') {
      const item = unwrap(
        await api.GET('/v1/workspaces/{workspace}/improvements/{id}', base(workspace, target)),
      );
      if (values.json) {
        io.stdout(`${JSON.stringify(item, null, 2)}\n`);
        return 0;
      }
      const sources = item.citations.map((c) => `${c.kind}:${c.ref}`).join(', ');
      io.stdout(
        `${item.title}\n${item.path} (base version ${item.baseVersion}) proposed by ${item.proposedBy.displayName}\nWhy: ${item.why}\n${sources ? `Sources: ${sources}\n` : ''}\n${lineDiff(item.currentBody, item.newBody)}\n`,
      );
      return 0;
    }

    if (action === 'accept') return accept(client, target, undefined, io);

    if (action === 'dismiss') {
      unwrap(
        await api.POST('/v1/workspaces/{workspace}/improvements/{id}/dismiss', {
          ...base(workspace, target),
          body: values.reason ? { reason: values.reason } : {},
        }),
      );
      io.stdout('dismissed\n');
      return 0;
    }

    // edit
    let body: string;
    if (values.file !== undefined) body = readFileSync(values.file, 'utf8');
    else {
      const item = unwrap(
        await api.GET('/v1/workspaces/{workspace}/improvements/{id}', base(workspace, target)),
      );
      const dir = mkdtempSync(join(tmpdir(), 'onebrain-'));
      const file = join(dir, `${target}.md`);
      try {
        writeFileSync(file, item.newBody);
        const editor = io.env.VISUAL ?? io.env.EDITOR ?? 'vi';
        const run = spawnSync(`${editor} "${file}"`, { shell: true, stdio: 'inherit' });
        if (run.status !== 0) {
          io.stderr('The editor did not exit cleanly. Nothing was accepted.\n');
          return 1;
        }
        body = readFileSync(file, 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (!body.trim()) {
      io.stderr('The body is empty. Nothing was accepted.\n');
      return 1;
    }
    return accept(client, target, body, io);
  },
} satisfies Command;
