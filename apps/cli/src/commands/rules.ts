import { parseArgs } from 'node:util';
import type { Command } from '../client.ts';
import { RULE_TARGETS, syncRules } from '../rules/sync.ts';

const USAGE = 'Usage: onebrain rules sync [--folder <path>] [--check]';

export default {
  name: 'rules',
  describe: [
    'Keep AGENTS.md, CLAUDE.md and Cursor rules in step with a One Brain folder',
    '',
    USAGE,
    '',
    'Reads the .md files directly in one shared folder (default: rules) and writes them into a',
    'block between onebrain marker lines in AGENTS.md, CLAUDE.md and .cursor/rules/onebrain.mdc',
    'at the repository root. Text outside the block is never changed. A missing file is created',
    'only for an AI client that onebrain init sets up on this machine. --check writes nothing and',
    'exits 1 when a file is out of step, for CI.',
  ].join('\n'),
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        folder: { type: 'string', default: 'rules' },
        check: { type: 'boolean', default: false },
      },
    });
    if (positionals.length !== 1 || positionals[0] !== 'sync') {
      io.stderr(`${USAGE}\n`);
      return 2;
    }
    const result = await syncRules(io, { folder: values.folder, check: values.check });
    const changed = [...result.created, ...result.updated];
    if (changed.length + result.unchanged.length + result.failed.length === 0) {
      const files = RULE_TARGETS.map((target) => target.file).join(', ');
      io.stderr(
        `None of ${files} is in this repository, and no AI client is set up here to create one for. Create one of them, or run onebrain init.\n`,
      );
    }
    if (values.check) {
      for (const file of changed) io.stdout(`out of step: ${file}\n`);
      if (changed.length > 0)
        io.stderr(`Run onebrain rules sync: ${changed.length} out of step.\n`);
      else io.stdout(`In step: ${result.unchanged.length} checked.\n`);
      return changed.length > 0 || result.failed.length > 0 ? 1 : 0;
    }
    for (const file of result.created) io.stdout(`created ${file}\n`);
    for (const file of result.updated) io.stdout(`updated ${file}\n`);
    io.stdout(
      `Synced ${result.rules} rules from ${result.folder}: ${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged.\n`,
    );
    return result.failed.length > 0 ? 1 : 0;
  },
} satisfies Command;
