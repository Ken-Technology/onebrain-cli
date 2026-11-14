import { parseArgs } from 'node:util';
import { CliError, type Io, unwrap } from '../../client.ts';
import { pick, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin folders create <path> [--access open|restricted] [--write-policy review|direct|inherit] [--private]
       onebrain admin folders update <path> [--access open|restricted] [--write-policy review|direct|inherit]`;

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      access: { type: 'string' },
      'write-policy': { type: 'string' },
      private: { type: 'boolean' },
    },
  });
  const [action, path, ...extra] = positionals;
  if ((action !== 'create' && action !== 'update') || !path || extra.length > 0) {
    return usage(io, USAGE);
  }
  if (action === 'update' && values.private) return usage(io, USAGE);

  const access = pick(values.access, ['open', 'restricted'], '--access');
  const writePolicy = pick(
    values['write-policy'],
    ['review', 'direct', 'inherit'],
    '--write-policy',
  );
  const body = {
    path,
    ...(access ? { access } : {}),
    ...(writePolicy ? { writePolicy } : {}),
  };
  const { api, workspace } = await io.client();
  const params = { params: { path: { workspace } } };

  if (action === 'create') {
    const created = unwrap(
      await api.POST('/v1/workspaces/{workspace}/folders', {
        ...params,
        body: { ...body, ...(values.private ? { visibility: 'private' as const } : {}) },
      }),
    );
    // The generated Node type is nullable; a created folder never is.
    if (!created) throw new CliError('The API returned no folder.');
    io.stdout(`${created.id}\n`);
  } else {
    unwrap(await api.PATCH('/v1/workspaces/{workspace}/folders', { ...params, body }));
    io.stdout(`updated ${path}\n`);
  }
  return 0;
}
