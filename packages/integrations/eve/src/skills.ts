import type { OneBrain } from '@useonebrain/sdk';
import { defineDynamic, defineSkill } from 'eve/skills';
import { type ConnectionOptions, clientFactory, describeError, holderOf } from './client.ts';
import { SKILL_MARKER } from './messages.ts';

export type SkillsOptions = ConnectionOptions & {
  /**
   * Put before each skill's name, such as `team-`. Default: none, so a One Brain skill keeps its
   * name. A One Brain skill named like one of the agent's own skills replaces it.
   */
  prefix?: string;
  /** Keep the skills out of the system prompt until the model finds them with eve__search. Default: false. */
  deferred?: boolean;
  /** The most skills to load. Default 100. */
  max?: number;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A memo result may be 1 MB: what is kept of skill files stays well under it. */
const FILES_BUDGET = 800_000;
const PREFIX = '[@useonebrain/eve]';

type Loaded = {
  name: string;
  description: string;
  content: string;
  files: Record<string, string>;
};

/** A SKILL.md's body without its frontmatter: eve writes the frontmatter from the definition. */
export function skillBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return (match ? markdown.slice(match[0].length) : markdown).replace(/^\s*\n/, '');
}

/** The skills the caller may use, each with its files, within FILES_BUDGET. */
async function loadSkills(brain: OneBrain, options: SkillsOptions): Promise<Loaded[]> {
  const prefix = options.prefix ?? '';
  const listed = (await brain.skills.list()).data.slice(0, options.max ?? 100);
  const settled = await Promise.allSettled(listed.map((skill) => brain.skills.get(skill.name)));
  let budget = FILES_BUDGET;
  const loaded: Loaded[] = [];
  for (const [index, one] of settled.entries()) {
    if (one.status === 'rejected') {
      // One skill that cannot be read leaves the others in place.
      console.warn(
        `${PREFIX} Skipped One Brain skill "${listed[index]?.name}": ${describeError(one.reason)}`,
      );
      continue;
    }
    const skill = one.value;
    const name = `${prefix}${skill.name}`;
    if (!NAME.test(name)) {
      console.warn(`${PREFIX} Skipped One Brain skill "${skill.name}": not a name eve accepts.`);
      continue;
    }
    const main = skill.files.find((file) => file.path === 'SKILL.md');
    const marker = `${SKILL_MARKER} ${skill.name} version ${skill.version} -->`;
    const body = skillBody(main?.body ?? '');
    budget -= body.length;
    const files: Record<string, string> = {};
    let left = false;
    for (const file of skill.files) {
      if (file.path === 'SKILL.md') continue;
      if (file.body.length > budget) {
        left = true;
        continue;
      }
      budget -= file.body.length;
      files[file.path] = file.body;
    }
    const note = left
      ? `\n\nSome files of this skill are only in One Brain: read them from ${skill.path}/ with One Brain's read tool.`
      : '';
    loaded.push({
      name,
      description: (skill.description || `The ${skill.name} skill from One Brain.`).slice(0, 1024),
      content: `${marker}\n${body}${note}`,
      files,
    });
  }
  return loaded;
}

/**
 * The workspace's skills, for the caller, as eve skills. Default-export it from a file in the
 * agent's `skills/` folder:
 *
 *   // agent/skills/onebrain.ts
 *   import { onebrainSkills } from '@useonebrain/eve';
 *   export default onebrainSkills();
 *
 * It is a dynamic skill (`defineDynamic`): the skills the key or the caller's token may use are
 * read once per session and caller, at the session's first model call, and kept with the session.
 * Each comes with its files, which eve puts in the sandbox when the skill is loaded. When One Brain
 * cannot be reached, the agent runs without them, and the next session tries again.
 */
export function onebrainSkills(options: SkillsOptions = {}) {
  const client = clientFactory(options);
  return defineDynamic(async (ctx) => {
    const holder = holderOf(options, ctx);
    // A failure is kept as no skills for the session, so the agent's model calls do not each wait
    // on One Brain again.
    const skills = (await ctx.memo(['onebrain-skills', ctx.session.id, holder], async () => {
      try {
        return await loadSkills(await client(ctx), options);
      } catch (error) {
        console.warn(`${PREFIX} Could not load the One Brain skills: ${describeError(error)}`);
        return [];
      }
    })) as Loaded[];
    if (skills.length === 0) return null;
    return Object.fromEntries(
      skills.map((skill) => [
        skill.name,
        defineSkill({
          description: skill.description,
          content: skill.content,
          ...(Object.keys(skill.files).length > 0 ? { files: skill.files } : {}),
          ...(options.deferred ? { deferred: true } : {}),
        }),
      ]),
    );
  });
}
