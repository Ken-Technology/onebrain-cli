import { parseArgs } from 'node:util';
import { CliError, type Io, unwrap } from '../../client.ts';
import { table, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin workspace list
       onebrain admin workspace create <slug> [--name <name>] [--org <organization id>]
       onebrain admin workspace revoke-key <slug> --yes
       onebrain admin workspace delete <slug> --yes`;

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      org: { type: 'string' },
      yes: { type: 'boolean' },
    },
  });
  const [action, slug, ...extra] = positionals;

  if (action === 'list' && !slug) {
    const { api } = await io.client({ needWorkspace: false });
    const me = unwrap(await api.GET('/v1/me'));
    const rows = me.workspaces.map((w) => [
      `${w.slug === me.currentWorkspace?.slug ? '*' : ' '} ${w.slug}`,
      w.name,
      w.role ?? '',
    ]);
    io.stdout(table(rows));
    return 0;
  }

  if (action === 'create' && slug && extra.length === 0) {
    const { api } = await io.client({ needWorkspace: false });
    let organization = values.org;
    if (!organization) {
      const { organizations } = unwrap(await api.GET('/v1/me'));
      const [only] = organizations;
      if (organizations.length === 1 && only) organization = only.id;
      else {
        const list = organizations.map((o) => `${o.id} (${o.name})`).join(', ');
        io.stderr(
          organizations.length === 0
            ? 'Pass --org <organization id> (the bootstrap command printed it).\n'
            : `Pass --org with one of: ${list}.\n`,
        );
        return 2;
      }
    }
    const created = unwrap(
      await api.POST('/v1/organizations/{organization}/workspaces', {
        params: { path: { organization } },
        body: { name: values.name ?? slug, slug },
      }),
    );
    io.stdout(`${created.id}\n`);
    return 0;
  }

  if ((action === 'revoke-key' || action === 'delete') && slug && extra.length === 0) {
    if (!values.yes) throw new CliError('This cannot be undone. Run it again with --yes.', 2);
    const { api } = await io.client({ needWorkspace: false });
    const params = { params: { path: { workspace: slug } } };
    if (action === 'revoke-key')
      unwrap(await api.POST('/v1/workspaces/{workspace}/key/revoke', params));
    else unwrap(await api.DELETE('/v1/workspaces/{workspace}', params));
    io.stdout(action === 'revoke-key' ? 'revoked\n' : 'deleted\n');
    return 0;
  }

  return usage(io, USAGE);
}
