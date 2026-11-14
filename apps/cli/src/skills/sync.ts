import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Io, unwrap } from '../client.ts';
import { readManifest, writeManifest } from './manifest.ts';

export type SyncResult = {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  failed: string[];
};

const ROOTS = { agents: '.agents/skills', claude: '.claude/skills' } as const;
type Root = keyof typeof ROOTS;
const ROOT_NAMES = Object.keys(ROOTS) as Root[];

// One path segment by the API's rule, so join(root, name) stays inside root. Case is kept.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safeFile = (path: string) =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.split('/').includes('..');

/** Writes every skill the caller may read, removes the ones it wrote that are gone, and leaves other folders alone. */
export async function syncSkills(io: Io): Promise<SyncResult> {
  const { api, workspace } = await io.client();
  const listed = unwrap(
    await api.GET('/v1/workspaces/{workspace}/skills', { params: { path: { workspace } } }),
  ).data;
  const manifest = readManifest(io.home);
  const result: SyncResult = { added: [], updated: [], unchanged: [], removed: [], failed: [] };
  const dir = (root: Root, name: string) => join(io.home, ROOTS[root], name);

  for (const skill of listed) {
    if (!NAME.test(skill.name)) {
      io.stderr(`skipped ${skill.name}: not a valid skill name\n`);
      result.failed.push(skill.name);
      continue;
    }
    const known = manifest.skills[skill.name];
    const roots = ROOT_NAMES.filter((root) => {
      if (known?.roots.includes(root) || !existsSync(dir(root, skill.name))) return true;
      io.stderr(`skipped ${skill.name} in ${dir(root, skill.name)}: onebrain did not write it\n`);
      return false;
    });
    if (roots.length === 0) continue;
    if (
      known?.version === skill.version &&
      roots.every((root) => known.roots.includes(root) && existsSync(dir(root, skill.name)))
    ) {
      result.unchanged.push(skill.name);
      continue;
    }
    const detail = unwrap(
      await api.GET('/v1/workspaces/{workspace}/skills/{name}', {
        params: { path: { workspace, name: skill.name } },
      }),
    );
    if (!detail.files.every((file) => safeFile(file.path))) {
      io.stderr(`skipped ${skill.name}: a file path leaves the skill folder\n`);
      result.failed.push(skill.name);
      continue;
    }
    for (const root of roots) {
      rmSync(dir(root, skill.name), { recursive: true, force: true });
      for (const file of detail.files) {
        const target = join(dir(root, skill.name), file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.body);
      }
    }
    (known ? result.updated : result.added).push(skill.name);
    manifest.skills[skill.name] = { version: skill.version, roots };
  }

  const readable = new Set(listed.map((skill) => skill.name));
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (readable.has(name) || !NAME.test(name)) continue;
    for (const root of entry.roots.filter((r) => r in ROOTS)) {
      rmSync(dir(root, name), { recursive: true, force: true });
    }
    result.removed.push(name);
  }
  const kept = Object.entries(manifest.skills).filter(([name]) => !result.removed.includes(name));
  writeManifest(io.home, { version: 1, skills: Object.fromEntries(kept) });
  return result;
}

/** The stdout lines `skills sync` and `init` print for a result. */
export function syncLines(result: SyncResult): string[] {
  const lines = [
    ...result.added.map((n) => `added ${n}`),
    ...result.updated.map((n) => `updated ${n}`),
    ...result.removed.map((n) => `removed ${n}`),
  ];
  const total = result.added.length + result.updated.length + result.unchanged.length;
  lines.push(
    `Synced ${total} skills: ${result.added.length} added, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.removed.length} removed.`,
  );
  return lines;
}
