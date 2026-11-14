import { CliError, type Io, type OneBrainClient, unwrap } from '../../client.ts';

/** Rows as aligned columns: every column but the last is padded to its widest cell plus two spaces. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length);
  }
  return rows
    .map(
      (row) =>
        `${row.map((cell, i) => (i < row.length - 1 ? cell.padEnd((widths[i] ?? 0) + 2) : cell)).join('')}\n`,
    )
    .join('')
    .replace(/ +\n/g, '\n');
}

/** Prints `text` on stderr and returns the usage exit code. */
export function usage(io: Io, text: string): number {
  io.stderr(`${text}\n`);
  return 2;
}

/** `value` when it is one of `allowed` (or not given); otherwise a usage error. */
export function pick<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  const found = allowed.find((a) => a === value);
  if (found === undefined) throw new CliError(`${flag} must be one of: ${allowed.join(', ')}.`, 2);
  return found;
}

export async function findGroup(api: OneBrainClient, workspace: string, nameOrId: string) {
  const { data } = unwrap(
    await api.GET('/v1/workspaces/{workspace}/groups', { params: { path: { workspace } } }),
  );
  const found = data.find((g) => g.name === nameOrId || g.id === nameOrId);
  if (!found) throw new CliError(`No group named ${nameOrId}.`);
  return found;
}

export async function findAgent(api: OneBrainClient, workspace: string, nameOrId: string) {
  const { data } = unwrap(
    await api.GET('/v1/workspaces/{workspace}/agents', { params: { path: { workspace } } }),
  );
  const found = data.find((a) => a.name === nameOrId || a.id === nameOrId);
  if (!found) throw new CliError(`No agent named ${nameOrId}.`);
  return found;
}

/** A member by email or principal id, among the workspace's members or those of one group. */
export async function findMember(
  api: OneBrainClient,
  workspace: string,
  emailOrId: string,
  groupId?: string,
) {
  const { data } = groupId
    ? unwrap(
        await api.GET('/v1/workspaces/{workspace}/groups/{id}/members', {
          params: { path: { workspace, id: groupId } },
        }),
      )
    : unwrap(
        await api.GET('/v1/workspaces/{workspace}/members', { params: { path: { workspace } } }),
      );
  const found = data.find((m) => m.email === emailOrId || m.principalId === emailOrId);
  if (!found) throw new CliError(`No member ${emailOrId}.`);
  return found;
}
