import { type Command, unwrap } from '../client.ts';
import { syncLines, syncSkills } from '../skills/sync.ts';

const USAGE = 'Usage: onebrain skills sync\n       onebrain skills list [--json]';

export default {
  name: 'skills',
  describe: `Put the skills you may read where your AI clients look for them\n\n${USAGE}`,
  run: async (args, io) => {
    const [action, ...rest] = args;
    if (action === 'sync' && rest.length === 0) {
      const result = await syncSkills(io);
      io.stdout(`${syncLines(result).join('\n')}\n`);
      return result.failed.length > 0 ? 1 : 0;
    }
    if (action === 'list' && rest.every((arg) => arg === '--json')) {
      const { api, workspace } = await io.client();
      const { data } = unwrap(
        await api.GET('/v1/workspaces/{workspace}/skills', { params: { path: { workspace } } }),
      );
      if (rest.length > 0) io.stdout(`${JSON.stringify(data, null, 2)}\n`);
      else
        for (const s of data) io.stdout(`${s.name}  ${s.version}  ${s.path}  ${s.description}\n`);
      return 0;
    }
    io.stderr(`${USAGE}\n`);
    return 2;
  },
} satisfies Command;
