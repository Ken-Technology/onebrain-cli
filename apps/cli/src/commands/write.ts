import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ApiError, type Command, unwrap } from '../client.ts';

const USAGE =
  'Usage: onebrain write <path> [--file <file>] [--base <version>] [--title <text>] [--why <text>] [--private]';

export default {
  name: 'write',
  describe: `Write a file from a file or stdin\n\n${USAGE}`,
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        file: { type: 'string' },
        base: { type: 'string' },
        title: { type: 'string' },
        why: { type: 'string' },
        private: { type: 'boolean' },
      },
    });
    const [path] = positionals;
    const base = values.base === undefined ? undefined : Number(values.base);
    if (!path || positionals.length > 1 || (base !== undefined && !Number.isInteger(base))) {
      io.stderr(`${USAGE}\n`);
      return 2;
    }
    const body =
      values.file !== undefined ? readFileSync(values.file, 'utf8') : await io.readStdin();
    if (body === null) {
      io.stderr(`${USAGE}\nGive the body with --file or on stdin.\n`);
      return 2;
    }
    const { api, workspace } = await io.client();

    let baseVersion = base;
    if (baseVersion === undefined) {
      try {
        const current = unwrap(
          await api.GET('/v1/workspaces/{workspace}/files', {
            params: { path: { workspace }, query: { path } },
          }),
        );
        baseVersion = current.version;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'not_found') throw error;
        baseVersion = 0;
      }
    }

    try {
      const result = unwrap(
        await api.PUT('/v1/workspaces/{workspace}/files', {
          params: { path: { workspace } },
          body: {
            path,
            body,
            baseVersion,
            ...(values.private ? { visibility: 'private' as const } : {}),
            ...(values.title ? { title: values.title } : {}),
            ...(values.why ? { why: values.why } : {}),
          },
        }),
      );
      if ('improvement' in result) io.stdout(`pending improvement ${result.improvement.id}\n`);
      else io.stdout(`${result.path} version ${result.version}\n`);
      return 0;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        io.stderr(
          `${path} changed: it is at version ${String(error.extra.currentVersion)}. Read it again and retry.\n`,
        );
        return 1;
      }
      throw error;
    }
  },
} satisfies Command;
