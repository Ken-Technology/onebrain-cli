import { parseArgs } from 'node:util';
import { type Io, unwrap } from '../../client.ts';
import { pick, usage } from './shared.ts';

const USAGE = `Usage: onebrain admin access explain <email, agent name or principal id> <path> [--for read|write] [--json]

Says why someone can or cannot read (or write) a path, and what would change it. Admins only.`;

export async function run(args: string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { for: { type: 'string' }, json: { type: 'boolean' } },
  });
  const [action, who, path, ...extra] = positionals;
  if (action !== 'explain' || !who || !path || extra.length > 0) return usage(io, USAGE);
  const wanted = pick(values.for, ['read', 'write'], '--for') ?? 'read';

  const { api, workspace } = await io.client();
  const result = unwrap(
    await api.GET('/v1/workspaces/{workspace}/access/explain', {
      params: { path: { workspace }, query: { who, path, for: wanted } },
    }),
  );
  if (values.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const { subject, need } = result;
  const kind = subject.actsAs
    ? `agent of ${subject.actsAs.name}`
    : subject.kind === 'user'
      ? 'person'
      : 'workspace agent';
  const level = result.found
    ? result.level === 'none'
      ? 'no access'
      : result.level
    : result.reason === 'private_space'
      ? 'private space'
      : 'nothing readable';
  const lines = [
    `${subject.name} (${kind}${subject.role ? `, ${subject.role}` : ''}) on ${result.path}: ${level}`,
    ...result.why.map((line) => `- ${line}`),
    ...(need ? [need.command ? `To give access: ${need.command}` : need.text] : []),
    ...(result.keys ?? []).map(
      (key) =>
        `key ${key.keyId} (${key.scopes.join(',')}; ${key.pathPrefix ?? 'any path'}): ${key.state}, ${key.covers ? 'covers' : 'does not cover'} this path`,
    ),
  ];
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
