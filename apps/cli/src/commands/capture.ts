import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { type Command, unwrap } from '../client.ts';

const USAGE =
  'Usage: onebrain capture <transcript|-> [--folder <path> | --private] [--ref <external ref>]';

export default {
  name: 'capture',
  describe: `Store a session transcript as a source: in --folder, else the workspace's capture folder, else private. --private keeps it yours whatever the capture folder.\n\n${USAGE}`,
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        folder: { type: 'string' },
        private: { type: 'boolean' },
        ref: { type: 'string' },
      },
    });
    const [path] = positionals;
    if (!path || positionals.length > 1 || (values.private && values.folder)) {
      io.stderr(`${USAGE}\n`);
      return 2;
    }
    const stdin = path === '-';
    const bytes = stdin ? Buffer.from((await io.readStdin()) ?? '') : readFileSync(path);
    const form = new FormData();
    form.append('kind', 'session');
    if (values.folder) form.append('folder', values.folder);
    if (values.private) form.append('visibility', 'private');
    if (values.ref) form.append('externalRef', values.ref);
    form.append('occurredAt', (stdin ? new Date() : statSync(path).mtime).toISOString());
    form.append(
      'content',
      new Blob([bytes], { type: 'text/plain' }),
      stdin ? 'session.txt' : basename(path),
    );

    const { api, workspace } = await io.client();
    const result = await api.POST('/v1/workspaces/{workspace}/sources', {
      params: { path: { workspace } },
      body: form as never,
      bodySerializer: (body) => body as unknown as FormData,
    });
    const source = unwrap(result);
    io.stdout(`${source.id}\n`);
    if (source.duplicate) io.stderr('Already captured.\n');
    return 0;
  },
} satisfies Command;
