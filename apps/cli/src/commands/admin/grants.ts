import { parseArgs } from 'node:util';
import { type Io, unwrap } from '../../client.ts';
import { pick, table, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin grants list <path> [--json]
       onebrain admin grants put <path> (--group <name> | --principal <email or agent name>) --role view|edit|manage
       onebrain admin grants delete <path> (--group <name> | --principal <email or agent name>)`;

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      group: { type: 'string' },
      principal: { type: 'string' },
      role: { type: 'string' },
    },
  });
  const [action, path, ...extra] = positionals;
  if (!path || extra.length > 0) return usage(io, USAGE);
  // Exactly one grantee, sent as it was given; the API resolves names.
  const { group, principal } = values;
  const grantee =
    group !== undefined && principal === undefined
      ? { group }
      : principal !== undefined && group === undefined
        ? { principal }
        : null;

  if (action === 'list') {
    const { api, workspace } = await io.client();
    const result = unwrap(
      await api.GET('/v1/workspaces/{workspace}/grants', {
        params: { path: { workspace }, query: { path } },
      }),
    );
    io.stdout(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : table(
            result.data.map((g) => [
              g.id,
              g.granteeKind,
              g.grantee.name,
              g.role,
              g.inheritedFrom ?? '-',
            ]),
          ),
    );
    return 0;
  }

  if (action === 'put' && grantee) {
    const role = pick(values.role, ['view', 'edit', 'manage'], '--role');
    if (!role) return usage(io, USAGE);
    const { api, workspace } = await io.client();
    const grant = unwrap(
      await api.PUT('/v1/workspaces/{workspace}/grants', {
        params: { path: { workspace } },
        body: { path, role, ...grantee },
      }),
    );
    io.stdout(`${grant.id}\n`);
    return 0;
  }

  if (action === 'delete' && grantee) {
    const { api, workspace } = await io.client();
    unwrap(
      await api.DELETE('/v1/workspaces/{workspace}/grants', {
        params: { path: { workspace }, query: { path, ...grantee } },
      }),
    );
    io.stdout('deleted\n');
    return 0;
  }

  return usage(io, USAGE);
}
