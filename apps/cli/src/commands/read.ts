import { parseArgs } from 'node:util';
import { ApiError, type Command, unwrap } from '../client.ts';

const USAGE = 'Usage: onebrain read <path|id> [--version <n>] [--json]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  name: 'read',
  describe: `Read a file, a skill or a memory\n\n${USAGE}`,
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { version: { type: 'string' }, json: { type: 'boolean' } },
    });
    const [target] = positionals;
    const version = values.version === undefined ? undefined : Number(values.version);
    if (
      !target ||
      positionals.length > 1 ||
      (version !== undefined && !Number.isInteger(version))
    ) {
      io.stderr(`${USAGE}\n`);
      return 2;
    }
    const { api, workspace } = await io.client();
    const json = (data: unknown) => io.stdout(`${JSON.stringify(data, null, 2)}\n`);

    if (UUID.test(target)) {
      const memory = unwrap(
        await api.GET('/v1/workspaces/{workspace}/memories/{id}', {
          params: { path: { workspace, id: target } },
        }),
      );
      if (values.json) json(memory);
      else {
        io.stdout(`${memory.text}\n`);
        io.stderr(`status: ${memory.status}\n`);
      }
      return 0;
    }

    try {
      const file = unwrap(
        await api.GET('/v1/workspaces/{workspace}/files', {
          params: {
            path: { workspace },
            query: { path: target, ...(version !== undefined ? { version } : {}) },
          },
        }),
      );
      if (values.json) json(file);
      else {
        io.stdout(`${file.body}\n`);
        io.stderr(
          `${file.path} version ${file.version} (${file.changeKind} by ${file.author.displayName})\n`,
        );
      }
      return 0;
    } catch (error) {
      const name = target.replace(/^[\s/]+|[\s/]+$/g, '');
      const last = name.split('/').pop() ?? '';
      const underMe = name === 'me' || name.startsWith('me/');
      if (
        !(error instanceof ApiError) ||
        error.code !== 'not_found' ||
        underMe ||
        last.includes('.')
      ) {
        throw error;
      }
      try {
        const skill = unwrap(
          await api.GET('/v1/workspaces/{workspace}/skills/{name}', {
            params: { path: { workspace, name: last } },
          }),
        );
        if (values.json) json(skill);
        else for (const f of skill.files) io.stdout(`==> ${f.path} <==\n${f.body}\n`);
        return 0;
      } catch (second) {
        if (second instanceof ApiError && second.code === 'not_found') throw error;
        throw second;
      }
    }
  },
} satisfies Command;
