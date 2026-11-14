import { parseArgs } from 'node:util';
import { ApiError, CliError, type Io, unwrap } from '../../client.ts';
import { findAgent, pick, table, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin keys list <agent> [--json]
       onebrain admin keys create <agent> [--scope read|write|remember]... [--path-prefix <path>] [--expires <ISO date>]
       onebrain admin keys revoke <agent> <key id>

Only the agent's owner can create its keys. An admin can list and revoke any agent's keys.`;

const SCOPES = ['read', 'write', 'remember'] as const;

/** Says who may mint keys when the API answers 403, then lets the error through. */
async function hintOn403<T>(io: Io, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      io.stderr("Only the agent's owner can create its keys.\n");
    }
    throw error;
  }
}

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      scope: { type: 'string', multiple: true },
      'path-prefix': { type: 'string' },
      expires: { type: 'string' },
    },
  });
  const [action, agentName, keyId, ...extra] = positionals;
  if (!agentName || extra.length > 0) return usage(io, USAGE);

  if (action === 'list' && !keyId) {
    const { api, workspace } = await io.client();
    const agent = await findAgent(api, workspace, agentName);
    const result = unwrap(
      await api.GET('/v1/workspaces/{workspace}/agents/{id}/keys', {
        params: { path: { workspace, id: agent.id } },
      }),
    );
    io.stdout(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : table(
            result.data.map((k) => [
              k.keyId,
              k.scopes.join(','),
              k.pathPrefix ?? '-',
              k.expiresAt ?? '-',
              k.lastUsedAt ?? '-',
              k.revokedAt ?? '-',
            ]),
          ),
    );
    return 0;
  }

  if (action === 'create' && !keyId) {
    const scopes = (values.scope ?? []).flatMap((s) => pick(s, SCOPES, '--scope') ?? []);
    let expiresAt: string | undefined;
    if (values.expires !== undefined) {
      const date = new Date(values.expires);
      if (Number.isNaN(date.getTime()))
        throw new CliError(`--expires: cannot read the date ${values.expires}.`, 2);
      expiresAt = date.toISOString();
    }
    const { api, workspace } = await io.client();
    const agent = await findAgent(api, workspace, agentName);
    const created = await hintOn403(io, async () =>
      unwrap(
        await api.POST('/v1/workspaces/{workspace}/agents/{id}/keys', {
          params: { path: { workspace, id: agent.id } },
          body: {
            ...(scopes.length > 0 ? { scopes } : {}),
            ...(values['path-prefix'] ? { pathPrefix: values['path-prefix'] } : {}),
            ...(expiresAt ? { expiresAt } : {}),
          },
        }),
      ),
    );
    io.stdout(`${created.key}\n`);
    io.stderr(`Key id ${created.keyId}. Store the key now: it is not shown again.\n`);
    return 0;
  }

  if (action === 'revoke' && keyId) {
    const { api, workspace } = await io.client();
    const agent = await findAgent(api, workspace, agentName);
    const path = { workspace, id: agent.id };
    const { data } = unwrap(
      await api.GET('/v1/workspaces/{workspace}/agents/{id}/keys', { params: { path } }),
    );
    const key = data.find((k) => k.keyId === keyId || k.id === keyId);
    if (!key) throw new CliError(`No key ${keyId}.`);
    unwrap(
      await api.DELETE('/v1/workspaces/{workspace}/agents/{id}/keys/{keyId}', {
        params: { path: { ...path, keyId: key.keyId } },
      }),
    );
    io.stdout('revoked\n');
    return 0;
  }

  return usage(io, USAGE);
}
