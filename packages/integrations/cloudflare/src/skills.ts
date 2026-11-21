import { type OneBrain, OneBrainError } from '@useonebrain/sdk';
import {
  type InvalidSkill,
  type ListedSkill,
  parseSkill,
  parseSkillResourcePath,
  SkillParseError,
  type SkillResource,
  type SkillResourceInfo,
  type SkillResourceKind,
  SkillResourceNotFoundError,
  type SkillSource,
  SkillSourceError,
} from 'agents/skills';
import { type ConnectOptions, identityOf, lazyBrain } from './connect.ts';

export type OneBrainSkillsOptions = ConnectOptions & {
  /** The source id in the catalog's diagnostics. Default `onebrain`. */
  id?: string;
  /**
   * How long a listing is reused before One Brain is asked again, per key, in this isolate.
   * Default 60 seconds, as Cloudflare's R2 source; `0` asks on every listing.
   */
  refreshIntervalMs?: number;
  /** Only serve these skill names. Default: every skill the key may use. */
  skills?: readonly string[];
};

type SkillDetail = Awaited<ReturnType<OneBrain['skills']['get']>>;
/** One skill as listed, with its files' text, at the version One Brain gave. */
type Held = { version: number; listed: ListedSkill | InvalidSkill; files: Map<string, string> };
/** What one key saw: when it was listed, and its skills by name. */
type Listing = { at: number; skills: Map<string, Held> };

/**
 * Listings per key (identityOf: a hash of the URL, the workspace and the key), shared by every
 * source in the isolate, so each agent in it does not list again. Never shared across keys.
 */
const listings = new Map<string, Listing>();
const refreshing = new Map<string, Promise<Listing>>();
/** The most keys whose listings an isolate keeps; the oldest goes first. */
const MAX_KEYS = 50;

/**
 * Your team's One Brain skills as an Agent Skills source: they join the agent's skill catalog, and
 * the model loads one with `activate_skill` and its files with `read_skill_resource`.
 *
 *   getSkills() { return [onebrainSkills({ env: this.env })]; }   // Think
 *
 * The skills the key may use are listed again after `refreshIntervalMs`; a skill is fetched again
 * only when its version changed. A failed listing is returned as a `SkillSourceError`, so the
 * catalog keeps the last skills it had.
 */
export function onebrainSkills(options: OneBrainSkillsOptions = {}): SkillSource {
  const id = options.id ?? 'onebrain';
  const refreshMs = Math.max(0, options.refreshIntervalMs ?? 60_000);
  const allowed = options.skills ? new Set(options.skills) : null;
  const brain = lazyBrain(options);

  const current = async (): Promise<Listing> => {
    const key = await identityOf(options);
    const held = listings.get(key);
    if (held && Date.now() - held.at < refreshMs) return held;
    let pending = refreshing.get(key);
    if (!pending) {
      pending = relist(brain(), held).finally(() => refreshing.delete(key));
      refreshing.set(key, pending);
    }
    const listing = await pending;
    listings.delete(key);
    listings.set(key, listing);
    for (const oldest of listings.keys()) {
      if (listings.size <= MAX_KEYS) break;
      listings.delete(oldest);
    }
    return listing;
  };

  return {
    id,
    async list() {
      try {
        const listing = await current();
        const skills: ListedSkill[] = [];
        const invalid: InvalidSkill[] = [];
        for (const [name, held] of listing.skills) {
          if (allowed && !allowed.has(name)) continue;
          if ('skill' in held.listed) skills.push(held.listed);
          else invalid.push(held.listed);
        }
        return { ok: true, value: { skills, invalid } };
      } catch (cause) {
        return { ok: false, error: new SkillSourceError(id, 'list', cause) };
      }
    },
    async readResource(skill, path) {
      if (allowed && !allowed.has(skill)) {
        return { ok: false, error: new SkillResourceNotFoundError(skill, path) };
      }
      try {
        const listing = listings.get(await identityOf(options));
        let body = listing?.skills.get(skill)?.files.get(path);
        if (body === undefined) {
          const detail = await brain().skills.get(skill);
          body = detail.files.find((file) => file.path === path)?.body;
        }
        if (body === undefined || path === 'SKILL.md') {
          return { ok: false, error: new SkillResourceNotFoundError(skill, path) };
        }
        const resource: SkillResource = { ...describe(path), content: body };
        return { ok: true, value: resource };
      } catch (cause) {
        if (cause instanceof OneBrainError && cause.code === 'not_found') {
          return { ok: false, error: new SkillResourceNotFoundError(skill, path) };
        }
        return { ok: false, error: new SkillSourceError(id, 'read-resource', cause) };
      }
    },
  };
}

/** Lists the skills again, fetching only those that are new or at another version. */
async function relist(brain: OneBrain, previous: Listing | undefined): Promise<Listing> {
  const { data } = await brain.skills.list();
  const held = await Promise.all(
    data.map(async (summary): Promise<[string, Held | null]> => {
      const kept = previous?.skills.get(summary.name);
      if (kept && kept.version === summary.version) return [summary.name, kept];
      try {
        return [summary.name, toHeld(await brain.skills.get(summary.name))];
      } catch (error) {
        // Deleted, or made private, between the listing and now.
        if (error instanceof OneBrainError && error.code === 'not_found')
          return [summary.name, null];
        throw error;
      }
    }),
  );
  const skills = new Map<string, Held>();
  for (const [name, one] of held) if (one) skills.set(name, one);
  return { at: Date.now(), skills };
}

/** A One Brain skill as the Agent Skills catalog takes it: SKILL.md parsed, the other files as resources. */
function toHeld(detail: SkillDetail): Held {
  const directory = detail.path.split('/').filter(Boolean).at(-1) ?? detail.name;
  const files = new Map(detail.files.map((file) => [file.path, file.body]));
  const location = `${detail.name}/SKILL.md`;
  const markdown = files.get('SKILL.md');
  if (markdown === undefined) {
    const error = new SkillParseError('missing-frontmatter', 'The skill has no SKILL.md');
    return { version: detail.version, listed: { location, error }, files };
  }
  const parsed = parseSkill(markdown, { directory });
  if (!parsed.ok)
    return { version: detail.version, listed: { location, error: parsed.error }, files };
  const resources: SkillResourceInfo[] = [];
  for (const [path, body] of files) {
    if (path === 'SKILL.md') continue;
    const checked = parseSkillResourcePath(path);
    if (checked.ok) resources.push({ ...describe(checked.value), size: byteLength(body) });
  }
  const listed: ListedSkill = {
    skill: parsed.value,
    resources,
    ...(parsed.warnings.length > 0 ? { warnings: parsed.warnings } : {}),
  };
  return { version: detail.version, listed, files };
}

const KINDS: Record<string, SkillResourceKind> = {
  scripts: 'script',
  references: 'reference',
  assets: 'asset',
};
const MIME_TYPES: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
};

/** A skill file's kind from its top folder, as the Agent Skills spec names them. Text always: One Brain stores text. */
function describe(path: SkillResourceInfo['path']): Omit<SkillResourceInfo, 'size'> {
  const kind = KINDS[path.split('/')[0] ?? ''] ?? 'file';
  const extension = path.includes('.') ? (path.split('.').at(-1)?.toLowerCase() ?? '') : '';
  const mimeType = MIME_TYPES[extension];
  return { path, kind, encoding: 'text', ...(mimeType ? { mimeType } : {}) };
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;
