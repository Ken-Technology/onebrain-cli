import { parseArgs } from 'node:util';
import { type Io, unwrap } from '../../client.ts';
import { findMember, pick, table, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin members list [--json]
       onebrain admin members add <email> --role admin|editor|viewer [--name <display name>]
       onebrain admin members remove <email>`;

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' }, role: { type: 'string' }, name: { type: 'string' } },
  });
  const [action, email, ...extra] = positionals;

  if (action === 'list' && !email) {
    const { api, workspace } = await io.client();
    const result = unwrap(
      await api.GET('/v1/workspaces/{workspace}/members', { params: { path: { workspace } } }),
    );
    io.stdout(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : table(result.data.map((m) => [m.principalId, m.email, m.displayName, m.role])),
    );
    return 0;
  }

  if (action === 'add' && email && extra.length === 0) {
    const role = pick(values.role, ['admin', 'editor', 'viewer'], '--role');
    if (!role) return usage(io, USAGE);
    const { api, workspace } = await io.client();
    const added = unwrap(
      await api.POST('/v1/workspaces/{workspace}/members', {
        params: { path: { workspace } },
        body: { email, role, ...(values.name ? { displayName: values.name } : {}) },
      }),
    );
    io.stdout(`${added.principalId}\n`);
    return 0;
  }

  if (action === 'remove' && email && extra.length === 0) {
    const { api, workspace } = await io.client();
    const member = await findMember(api, workspace, email);
    unwrap(
      await api.DELETE('/v1/workspaces/{workspace}/members/{principalId}', {
        params: { path: { workspace, principalId: member.principalId } },
      }),
    );
    io.stdout('removed\n');
    return 0;
  }

  return usage(io, USAGE);
}
