import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { type Part, uploadSession } from '@useonebrain/sdk';
import { type Command, unwrap } from '../client.ts';

const USAGE =
  'Usage: onebrain capture <transcript|-> [--folder <path> | --private] [--ref <external ref>]';

export default {
  name: 'capture',
  describe: `Store a session transcript as a source: in --folder, else the workspace's capture folder, else private. --private keeps it yours whatever the capture folder. A transcript over the server's largest source is stored in parts, cut at line ends, with refs <ref>#part-<n>.\n\n${USAGE}`,
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
    const name = stdin ? 'session.txt' : basename(path);
    const occurredAt = (stdin ? new Date() : statSync(path).mtime).toISOString();

    const { api, workspace } = await io.client();
    /** The whole transcript, or with `part` one part of it: its own source, ref and name. */
    const post = (content: Uint8Array, part?: Part) => {
      const form = new FormData();
      form.append('kind', 'session');
      if (values.folder) form.append('folder', values.folder);
      if (values.private) form.append('visibility', 'private');
      if (values.ref)
        form.append('externalRef', part ? `${values.ref}#part-${part.n}` : values.ref);
      form.append('occurredAt', occurredAt);
      form.append(
        'content',
        new Blob([content], { type: 'text/plain' }),
        part ? `${name} part ${part.n} of ${part.of}` : name,
      );
      return api.POST('/v1/workspaces/{workspace}/sources', {
        params: { path: { workspace } },
        body: form as never,
        bodySerializer: (body) => body as unknown as FormData,
      });
    };

    // The capture log (the hook's stdout and stderr) gets ids, counts and sizes, never content.
    const session = values.ref ?? name;
    const outcome = await uploadSession({
      bytes,
      post,
      onPart: (part) => {
        const where = `part ${part.part.n} of ${part.part.of}`;
        if ('stored' in part) io.stdout(`${part.stored.id}\n`);
        else if ('rateLimited' in part) {
          io.stderr(
            `${session}: rate limited at ${where}, ${part.part.of - part.part.n + 1} parts not sent\n`,
          );
        } else {
          io.stderr(
            `${session}: ${where} refused (${part.refused.code}), ${part.bytes} bytes, the largest source is ${part.maxBytes} bytes\n`,
          );
        }
      },
    });
    if ('whole' in outcome) {
      const source = unwrap(outcome.whole);
      io.stdout(`${source.id}\n`);
      if (source.duplicate) io.stderr('Already captured.\n');
      return 0;
    }
    const { parts, stored, duplicates, refused, notSent } = outcome;
    io.stderr(
      `${session}: ${bytes.length} bytes in ${parts} parts: ${stored.length} stored${duplicates > 0 ? ` (${duplicates} captured before)` : ''}, ${refused.length} refused${notSent > 0 ? `, ${notSent} not sent` : ''}\n`,
    );
    return stored.length === parts ? 0 : 1;
  },
} satisfies Command;
