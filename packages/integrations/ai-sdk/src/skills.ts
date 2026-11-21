import { type ConnectOptions, lazyBrain } from './connect.ts';

/** A skill in the shape `HarnessAgent`'s `skills` setting takes (`@ai-sdk/harness`). */
export type HarnessSkill = {
  name: string;
  description: string;
  /** SKILL.md without its frontmatter: the harness writes the frontmatter from name and description. */
  content: string;
  /** The skill's other files, by their path in the skill folder. */
  files: { path: string; content: string }[];
};

export type LoadOneBrainSkillsOptions = ConnectOptions & {
  /** Only these skills. Default: every skill the key may use. */
  names?: string[];
};

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The workspace's skills, with every file of each, for `new HarnessAgent({ skills })`:
 *
 *   const agent = new HarnessAgent({ harness: claudeCode, skills: await loadOneBrainSkills() });
 *
 * Load them when the agent starts, or per turn in `prepareCall` to pick up skills changed since.
 */
export async function loadOneBrainSkills(
  options: LoadOneBrainSkillsOptions = {},
): Promise<HarnessSkill[]> {
  const { names, ...connect } = options;
  const brain = lazyBrain(connect)();
  const wanted = names ?? (await brain.skills.list()).data.map((skill) => skill.name);
  const skills = await Promise.all(wanted.map((name) => brain.skills.get(name)));
  return skills.map((skill) => {
    const main = skill.files.find((file) => file.path === 'SKILL.md');
    return {
      name: skill.name,
      description: skill.description,
      content: (main?.body ?? '').replace(FRONTMATTER, '').replace(/^\s*\n/, ''),
      files: skill.files
        .filter((file) => file.path !== 'SKILL.md')
        .map((file) => ({ path: file.path, content: file.body })),
    };
  });
}
