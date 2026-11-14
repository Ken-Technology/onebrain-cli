import { describe, expect, it } from 'vitest';
import { loadCommands, main } from '../src/index.ts';
import { testIo } from './helpers.ts';

const fixtures = new URL('./fixtures/commands/', import.meta.url);

describe('command loader', () => {
  it('loads top-level command files and skips folders', async () => {
    const names = (await loadCommands(fixtures)).map((c) => c.name);
    expect(names).toEqual(['fail', 'hello']);
  });

  it('runs a command, strips the global --workspace flag and maps errors to exit codes', async () => {
    const commands = await loadCommands(fixtures);
    const t = testIo();
    expect(await main(['hello', '--workspace', 'x', 'ana'], t.io, commands)).toBe(0);
    expect(t.stdout()).toBe('hello ana\n');
    expect(await main(['fail'], t.io, commands)).toBe(1);
    expect(t.stderr()).toContain('error: not_found: No such file');
    expect(await main(['nope'], t.io, commands)).toBe(2);
    expect(await main(['hello', '--help'], t.io, commands)).toBe(0);
    expect(t.stdout()).toContain('Usage: onebrain hello <name>');
  });
});
