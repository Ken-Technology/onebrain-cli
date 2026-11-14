import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../config.ts';

export type Manifest = {
  version: 1;
  skills: Record<string, { version: number; roots: ('agents' | 'claude')[] }>;
};

const file = (home: string) => join(configDir(home), 'skills.json');

/** What `skills sync` wrote before. Missing or unreadable means nothing, so nothing gets deleted. */
export function readManifest(home: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(file(home), 'utf8')) as Partial<Manifest>;
    if (parsed.version === 1 && parsed.skills && typeof parsed.skills === 'object') {
      return { version: 1, skills: parsed.skills };
    }
  } catch {}
  return { version: 1, skills: {} };
}

export function writeManifest(home: string, manifest: Manifest): void {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(file(home), `${JSON.stringify(manifest, null, 2)}\n`);
}
