import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { toOneBrainPath } from './paths.ts';

export type Collected = {
  files: { source: string; target: string }[];
  skipped: { path: string; reason: string }[];
};

const MAX_BYTES = 1_000_000;
const TEXT = new Set(['.md', '.markdown', '.txt']);
export const KEN_BRAIN_FOLDERS = [
  'articles',
  'runbooks',
  'decisions',
  'clients',
  'people',
  'style',
];

function isPassedOver(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Every file under `dir` as a relative path with forward slashes. */
function walk(dir: string, relative = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
    if (isPassedOver(entry.name)) continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(dir, next));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

/** Applies the file rules to one file; adds it to `out` or reports why it was skipped. */
function consider(
  out: Collected,
  source: string,
  relative: string,
  into: string,
  extensions: Set<string>,
): void {
  if (!extensions.has(extname(relative).toLowerCase())) {
    out.skipped.push({ path: relative, reason: 'not a text file' });
    return;
  }
  const target = toOneBrainPath(relative);
  if (target === null) {
    out.skipped.push({ path: relative, reason: 'not a valid One Brain name' });
    return;
  }
  if (statSync(source).size > MAX_BYTES) {
    out.skipped.push({ path: relative, reason: 'over 1,000,000 bytes' });
    return;
  }
  if (readFileSync(source).includes(0)) {
    out.skipped.push({ path: relative, reason: 'contains a NUL byte' });
    return;
  }
  out.files.push({ source, target: `${into}/${target}` });
}

function sorted(out: Collected): Collected {
  out.files.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return out;
}

/** A file or a folder of .md, .markdown and .txt files, to `<into>/<relative path>`. */
export function collectLocal(path: string, into: string): Collected {
  const out: Collected = { files: [], skipped: [] };
  if (statSync(path).isDirectory()) {
    for (const relative of walk(path)) consider(out, join(path, relative), relative, into, TEXT);
  } else {
    consider(out, path, basename(path), into, TEXT);
  }
  return sorted(out);
}

/** Every .md under the six ken-brain folders, to `<into>/<folder>/<relative path>`. */
export function collectKenBrain(repo: string, into: string): Collected {
  const out: Collected = { files: [], skipped: [] };
  for (const folder of KEN_BRAIN_FOLDERS) {
    let names: string[];
    try {
      names = walk(join(repo, folder));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue;
      throw error;
    }
    for (const relative of names) {
      // Only .md files belong to ken-brain's folders; other files (a .conf, a .png) are not counted.
      if (extname(relative).toLowerCase() !== '.md') continue;
      consider(out, join(repo, folder, relative), `${folder}/${relative}`, into, new Set(['.md']));
    }
  }
  return sorted(out);
}

export type Memory = { id: string; line: number; text: string; createdAt: string | null };

/** The memories of a memories.jsonl, and the one-based numbers of the lines that cannot be used. */
export function readMemories(file: string): { memories: Memory[]; invalid: number[] } {
  const memories: Memory[] = [];
  const invalid: number[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '') return;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        invalid.push(index + 1);
        return;
      }
      const { id, text, created_at: createdAt } = (row ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string' || typeof text !== 'string' || text.trim() === '') {
        invalid.push(index + 1);
        return;
      }
      const date = typeof createdAt === 'string' ? new Date(createdAt) : null;
      memories.push({
        id,
        line: index + 1,
        text,
        createdAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      });
    });
  return { memories, invalid };
}
