import { parseArgs } from 'node:util';
import { apiUrl, CliError, type Command } from '../client.ts';
import { collectKenBrain, collectLocal, readMemories } from '../import/collect.ts';
import { ensureImportFolder } from '../import/folder.ts';
import { toOneBrainPath } from '../import/paths.ts';
import { uploadFiles, uploadMemories } from '../import/upload.ts';

const USAGE = `Usage: onebrain import <path> --into <folder> [--allow-open] [--concurrency <1-16>]
       onebrain import ken-brain <repo> <memories.jsonl> --into <folder> [--allow-open] [--concurrency <1-16>] [--restart]`;

const describe = `Bring files, folders or ken-brain into One Brain

${USAGE}

A new shared <folder> is created restricted, with manage for you (a person only). An existing
folder that is open to the whole workspace is refused unless you pass --allow-open.
Files keep their names; running an import again creates nothing new.
8 requests run at once (--concurrency changes that). Failed requests are retried, and progress
goes to stderr every 1,000 items. A memories run writes <memories.jsonl>.onebrain-progress, so a
rerun posts only what is missing; --restart ignores that file.`;

/** Trim slashes and whitespace at the ends, as the API does; null when a segment breaks the rule. */
function parseInto(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.replace(/^[\s/]+|[\s/]+$/g, '');
  return toOneBrainPath(trimmed) === trimmed ? trimmed : null;
}

function readable<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new CliError(`Cannot read ${(error as { path?: string }).path ?? 'the path'}.`, 2);
    }
    throw error;
  }
}

export default {
  name: 'import',
  describe,
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      options: {
        into: { type: 'string' },
        'allow-open': { type: 'boolean' },
        concurrency: { type: 'string' },
        restart: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const kenBrain = positionals[0] === 'ken-brain' && positionals.length === 3;
    if (!kenBrain && positionals.length !== 1) {
      io.stderr(`${USAGE}\n`);
      return 2;
    }
    const into = parseInto(values.into);
    if (into === null) {
      io.stderr(
        `--into <folder> is required and each name in it must match [A-Za-z0-9][A-Za-z0-9._-]*.\n${USAGE}\n`,
      );
      return 2;
    }

    const concurrency = values.concurrency === undefined ? 8 : Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      io.stderr(`--concurrency must be a whole number from 1 to 16.\n${USAGE}\n`);
      return 2;
    }

    const [first = '', repo = '', jsonl = ''] = positionals;
    const found = readable(() =>
      kenBrain ? collectKenBrain(repo, into) : collectLocal(first, into),
    );
    const lines = kenBrain ? readable(() => readMemories(jsonl)) : null;
    for (const skip of found.skipped) io.stderr(`skipped ${skip.path}: ${skip.reason}\n`);
    for (const line of lines?.invalid ?? []) {
      io.stderr(`failed memories line ${line}: needs a string id and a non-empty string text\n`);
    }

    const client = await io.client();
    await ensureImportFolder(client, into, io, { allowOpen: values['allow-open'] === true });
    const files = await uploadFiles(client, io, found.files, { concurrency });
    io.stdout(
      `files: ${files.created} created, ${files.proposed} proposed, ${files.existing} already there, ${found.skipped.length} skipped, ${files.failed} failed\n`,
    );
    let failed = files.failed;
    if (lines) {
      const memories = await uploadMemories(client, io, lines.memories, into, {
        concurrency,
        progressFile: `${jsonl}.onebrain-progress`,
        server: apiUrl(io.env, io.home),
        restart: values.restart === true,
      });
      const bad = memories.failed + lines.invalid.length;
      const resumed = memories.resumed > 0 ? `, ${memories.resumed} done in an earlier run` : '';
      io.stdout(
        `memories: ${memories.created} created, ${memories.existing} already there, ${bad} failed${resumed}\n`,
      );
      failed += bad;
    }
    return failed > 0 ? 1 : 0;
  },
} satisfies Command;
