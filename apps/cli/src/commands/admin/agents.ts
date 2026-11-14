import { parseArgs } from 'node:util';
import { CliError, type Io, unwrap } from '../../client.ts';
import { findAgent, table, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin agents list [--json]
       onebrain admin agents create <name> [--workspace-agent]
       onebrain admin agents delete <name>

create makes an agent you own, and only you can mint its keys. --workspace-agent makes one the
workspace owns (admins only). An admin can delete any agent.`;

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      owner: { type: 'string' },
      'workspace-agent': { type: 'boolean' },
    },
  });
  const [action, name, ...extra] = positionals;

  if (action === 'list' && !name) {
    const { api, workspace } = await io.client();
    const result = unwrap(
      await api.GET('/v1/workspaces/{workspace}/agents', { params: { path: { workspace } } }),
    );
    io.stdout(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : table(result.data.map((a) => [a.id, a.name, a.ownerKind, a.owner?.email ?? '-'])),
    );
    return 0;
  }

  if (action === 'create' && name && extra.length === 0) {
    if (values.owner !== undefined) {
      throw new CliError(
        'A person creates their own agents: leave out --owner. Use --workspace-agent for an agent the workspace owns.',
        2,
      );
    }
    const { api, workspace } = await io.client();
    let owner: { owner: string } | Record<string, never> = {};
    if (!values['workspace-agent']) {
      const email = unwrap(await api.GET('/v1/me')).principal.email;
      if (!email) throw new CliError('Your account has no email to own the agent.');
      owner = { owner: email };
    }
    const created = unwrap(
      await api.POST('/v1/workspaces/{workspace}/agents', {
        params: { path: { workspace } },
        body: { name, ...owner },
      }),
    );
    io.stdout(`${created.id}\n`);
    return 0;
  }

  if (action === 'delete' && name && extra.length === 0) {
    const { api, workspace } = await io.client();
    const agent = await findAgent(api, workspace, name);
    unwrap(
      await api.DELETE('/v1/workspaces/{workspace}/agents/{id}', {
        params: { path: { workspace, id: agent.id } },
      }),
    );
    io.stdout('deleted\n');
    return 0;
  }

  return usage(io, USAGE);
}
