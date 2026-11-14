import { CliError, type Command, unwrap } from '../client.ts';
import { writeConfig } from '../config.ts';

const USAGE = 'Usage: onebrain workspace use <slug>\n       onebrain workspace [list]';

export default {
  name: 'workspace',
  describe: `Switch or list your workspaces\n\n${USAGE}`,
  run: async (args, io) => {
    const [action = 'list', slug] = args;
    if (action === 'use' && slug && args.length === 2) {
      if (io.env.ONEBRAIN_API_KEY) {
        throw new CliError('An agent key is bound to its workspace.', 2);
      }
      const { api } = await io.client({ needWorkspace: false });
      unwrap(await api.PUT('/v1/me/workspace', { body: { workspace: slug } }));
      writeConfig(io.home, { workspace: slug });
      io.stdout(`Now using workspace ${slug}.\n`);
      return 0;
    }
    if (action === 'list' && args.length <= 1) {
      const { api } = await io.client({ needWorkspace: false });
      const me = unwrap(await api.GET('/v1/me'));
      for (const w of me.workspaces) {
        const mark = w.slug === me.currentWorkspace?.slug ? '*' : ' ';
        const line = `${mark} ${w.slug}  ${w.name}  ${w.role ?? ''}`;
        io.stdout(`${line.trimEnd()}\n`);
      }
      return 0;
    }
    io.stderr(`${USAGE}\n`);
    return 2;
  },
} satisfies Command;
