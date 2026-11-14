import { type Command, unwrap } from '../client.ts';

export default {
  name: 'whoami',
  describe: 'Show who you are signed in as and the current workspace\n\nUsage: onebrain whoami',
  run: async (_args, io) => {
    const client = await io.client({ needWorkspace: false });
    const me = unwrap(await client.api.GET('/v1/me'));
    const { principal, actsFor } = me;
    const line =
      principal.kind === 'agent'
        ? actsFor
          ? `${principal.displayName} (acts for ${actsFor.email ?? actsFor.displayName})`
          : `${principal.displayName} (workspace agent)`
        : `${principal.displayName} (${principal.email ?? 'no email'})`;
    io.stdout(`${line}\nworkspace: ${client.workspace || me.currentWorkspace?.slug || 'none'}\n`);
    return 0;
  },
} satisfies Command;
