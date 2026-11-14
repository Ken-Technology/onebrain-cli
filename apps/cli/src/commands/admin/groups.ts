import { parseArgs } from 'node:util';
import { type Io, unwrap } from '../../client.ts';
import { findGroup, findMember, table, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin groups list [--json]
       onebrain admin groups create <name>
       onebrain admin groups delete <name>
       onebrain admin groups members <name> [--json]
       onebrain admin groups add <name> <email>
       onebrain admin groups remove <name> <email>`;

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  const [action, name, email, ...extra] = positionals;
  const wantsEmail = action === 'add' || action === 'remove';
  const known = ['list', 'create', 'delete', 'members', 'add', 'remove'];
  if (!action || !known.includes(action) || extra.length > 0) return usage(io, USAGE);
  if (action === 'list' ? name : !name || (wantsEmail ? !email : email)) return usage(io, USAGE);

  const { api, workspace } = await io.client();
  const base = { params: { path: { workspace } } };

  if (action === 'list') {
    const result = unwrap(await api.GET('/v1/workspaces/{workspace}/groups', base));
    io.stdout(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : table(result.data.map((g) => [g.id, g.name, String(g.memberCount)])),
    );
    return 0;
  }
  if (action === 'create' && name) {
    const created = unwrap(
      await api.POST('/v1/workspaces/{workspace}/groups', { ...base, body: { name } }),
    );
    io.stdout(`${created.id}\n`);
    return 0;
  }

  const group = await findGroup(api, workspace, name as string);
  const path = { workspace, id: group.id };
  if (action === 'delete') {
    unwrap(await api.DELETE('/v1/workspaces/{workspace}/groups/{id}', { params: { path } }));
    io.stdout('deleted\n');
  } else if (action === 'members') {
    const result = unwrap(
      await api.GET('/v1/workspaces/{workspace}/groups/{id}/members', { params: { path } }),
    );
    io.stdout(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : table(result.data.map((m) => [m.principalId, m.email, m.displayName, m.role])),
    );
  } else if (action === 'add') {
    const added = unwrap(
      await api.POST('/v1/workspaces/{workspace}/groups/{id}/members', {
        params: { path },
        body: { email: email as string },
      }),
    );
    io.stdout(`${added.principalId}\n`);
  } else {
    const member = await findMember(api, workspace, email as string, group.id);
    unwrap(
      await api.DELETE('/v1/workspaces/{workspace}/groups/{id}/members/{principalId}', {
        params: { path: { ...path, principalId: member.principalId } },
      }),
    );
    io.stdout('removed\n');
  }
  return 0;
}
