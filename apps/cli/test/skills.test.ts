import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import skills from '../src/commands/skills.ts';
import { fakeApi, testIo } from './helpers.ts';

const W = '/v1/workspaces/kenso';
const at = '2026-11-13T00:00:00.000Z';
const SKILL_MD =
  '---\nname: reply-pricing\ndescription: How we answer pricing questions\n---\n# Reply pricing\n';
const skill = (name: string, version = 1) => ({
  name,
  path: `clients/acme/skills/${name}`,
  description: 'd',
  version,
  updatedAt: at,
});
const files: Record<string, { path: string; body: string }[]> = {
  'reply-pricing': [
    { path: 'SKILL.md', body: SKILL_MD },
    { path: 'REFERENCE.md', body: '# Tiers\n' },
    { path: 'scripts/fill_form.py', body: 'print(1)\n' },
  ],
  'old-skill': [{ path: 'SKILL.md', body: '---\nname: old-skill\n---\n' }],
  'bad-skill': [{ path: '../escape.md', body: 'x' }],
};
const server = (list: ReturnType<typeof skill>[]) =>
  fakeApi({
    [`GET ${W}/skills`]: () => ({ body: { data: list } }),
    ...Object.fromEntries(
      Object.entries(files).map(([name, f]) => [
        `GET ${W}/skills/${name}`,
        () => ({ body: { ...skill(name), files: f } }),
      ]),
    ),
  });
const read = (home: string, path: string) => readFileSync(join(home, path), 'utf8');

describe('skills sync', () => {
  it('writes each readable skill to both folders with the same bytes and records it', async () => {
    const t = testIo({ api: server([skill('reply-pricing')]).api });
    expect(await skills.run(['sync'], t.io)).toBe(0);
    for (const root of ['.agents/skills', '.claude/skills']) {
      expect(read(t.home, `${root}/reply-pricing/SKILL.md`)).toBe(SKILL_MD);
      expect(read(t.home, `${root}/reply-pricing/REFERENCE.md`)).toBe('# Tiers\n');
      expect(read(t.home, `${root}/reply-pricing/scripts/fill_form.py`)).toBe('print(1)\n');
    }
    expect(
      JSON.parse(read(t.home, '.config/onebrain/skills.json')).skills['reply-pricing'],
    ).toEqual({ version: 1, roots: ['agents', 'claude'] });
    expect(t.stdout()).toContain('added reply-pricing');
    expect(t.stdout()).toContain('Synced 1 skills: 1 added, 0 updated, 0 unchanged, 0 removed.');
  });

  it('writes nothing when the caller can read no skill', async () => {
    const t = testIo({ api: server([]).api });
    expect(await skills.run(['sync'], t.io)).toBe(0);
    expect(existsSync(join(t.home, '.agents/skills'))).toBe(false);
    expect(existsSync(join(t.home, '.claude/skills'))).toBe(false);
  });

  it('removes a skill it wrote once it is no longer readable, and nothing else', async () => {
    const { home } = testIo();
    await skills.run(['sync'], testIo({ home, api: server([skill('old-skill')]).api }).io);
    mkdirSync(join(home, '.agents/skills/mine'), { recursive: true });
    writeFileSync(join(home, '.agents/skills/mine/SKILL.md'), 'mine');
    const t = testIo({ home, api: server([]).api });
    expect(await skills.run(['sync'], t.io)).toBe(0);
    expect(existsSync(join(home, '.agents/skills/old-skill'))).toBe(false);
    expect(existsSync(join(home, '.claude/skills/old-skill'))).toBe(false);
    expect(read(home, '.agents/skills/mine/SKILL.md')).toBe('mine');
    expect(t.stdout()).toContain('removed old-skill');
  });

  it('never overwrites a skill folder it did not write', async () => {
    const { home } = testIo();
    mkdirSync(join(home, '.claude/skills/reply-pricing'), { recursive: true });
    writeFileSync(join(home, '.claude/skills/reply-pricing/SKILL.md'), 'hand made');
    const t = testIo({ home, api: server([skill('reply-pricing')]).api });
    expect(await skills.run(['sync'], t.io)).toBe(0);
    expect(read(home, '.claude/skills/reply-pricing/SKILL.md')).toBe('hand made');
    expect(read(home, '.agents/skills/reply-pricing/SKILL.md')).toBe(SKILL_MD);
    expect(t.stderr()).toContain('skipped reply-pricing');
    expect(
      JSON.parse(read(home, '.config/onebrain/skills.json')).skills['reply-pricing'].roots,
    ).toEqual(['agents']);
  });

  it('does not download a skill whose version has not changed', async () => {
    const { home } = testIo();
    await skills.run(['sync'], testIo({ home, api: server([skill('reply-pricing')]).api }).io);
    const again = server([skill('reply-pricing')]);
    expect(await skills.run(['sync'], testIo({ home, api: again.api }).io)).toBe(0);
    expect(again.calls.map((c) => c.path)).toEqual([`${W}/skills`]);
  });

  it('downloads again and reports updated when the version changes', async () => {
    const { home } = testIo();
    await skills.run(['sync'], testIo({ home, api: server([skill('reply-pricing')]).api }).io);
    const t = testIo({ home, api: server([skill('reply-pricing', 2)]).api });
    expect(await skills.run(['sync'], t.io)).toBe(0);
    expect(t.stdout()).toContain('updated reply-pricing');
    expect(
      JSON.parse(read(home, '.config/onebrain/skills.json')).skills['reply-pricing'].version,
    ).toBe(2);
  });

  it('refuses a file path that leaves the skill folder', async () => {
    const t = testIo({ api: server([skill('bad-skill')]).api });
    expect(await skills.run(['sync'], t.io)).toBe(1);
    expect(existsSync(join(t.home, '.agents/skills/escape.md'))).toBe(false);
    expect(existsSync(join(t.home, '.agents/skills/bad-skill'))).toBe(false);
  });

  it('skips a skill name that is not one path segment', async () => {
    const t = testIo({ api: server([skill('../evil')]).api });
    expect(await skills.run(['sync'], t.io)).toBe(1);
    expect(t.stderr()).toContain('not a valid skill name');
  });
});
