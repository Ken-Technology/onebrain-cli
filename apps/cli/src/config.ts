import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Config = { url?: string; workspace?: string };

export function configDir(home: string): string {
  return join(home, '.config', 'onebrain');
}

export function readConfig(home: string): Config {
  try {
    return JSON.parse(readFileSync(join(configDir(home), 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

/** Merges `patch` into `<home>/.config/onebrain/config.json` (mode 600, folder mode 700). */
export function writeConfig(home: string, patch: Partial<Config>): void {
  mkdirSync(configDir(home), { recursive: true, mode: 0o700 });
  const file = join(configDir(home), 'config.json');
  const next = { ...readConfig(home), ...patch };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
