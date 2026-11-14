import { parseArgs } from 'node:util';
import { type Command, unwrap } from '../client.ts';

const USAGE = 'Usage: onebrain remember <text...|-> [--folder <path>] [--private]';

export default {
  name: 'remember',
  describe: `Save a memory\n\n${USAGE}`,
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { folder: { type: 'string' }, private: { type: 'boolean' } },
    });
    const folder = values.folder?.replace(/^[\s/]+|[\s/]+$/g, '');
    if (values.private && folder && folder !== 'me' && !folder.startsWith('me/')) {
      io.stderr(`A private memory has no folder or one under me/: ${values.folder} is shared.\n`);
      return 2;
    }
    const given = positionals.join(' ');
    const text = given && given !== '-' ? given : await io.readStdin();
    if (!text?.trim()) {
      io.stderr(`${USAGE}\n`);
      return 2;
    }
    const { api, workspace } = await io.client();
    const result = await api.POST('/v1/workspaces/{workspace}/memories', {
      params: { path: { workspace } },
      body: {
        text,
        ...(values.folder ? { folder: values.folder } : {}),
        ...(values.private ? { visibility: 'private' as const } : {}),
      },
    });
    const saved = unwrap(result);
    io.stdout(`${saved.id}\nstatus: ${saved.status}\n`);
    if (result.response.status === 200) io.stderr('Already saved.\n');
    return 0;
  },
} satisfies Command;
