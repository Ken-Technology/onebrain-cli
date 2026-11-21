import { CliError, type Command, type Io } from '../client.ts';
import { run as access } from './admin/access.ts';
import { run as agents } from './admin/agents.ts';
import { run as folders } from './admin/folders.ts';
import { run as grants } from './admin/grants.ts';
import { run as groups } from './admin/groups.ts';
import { run as keys } from './admin/keys.ts';
import { run as loop } from './admin/loop.ts';
import { run as members } from './admin/members.ts';
import { run as workspace } from './admin/workspace.ts';

const areas: Record<string, (args: string[], io: Io) => Promise<number>> = {
  workspace,
  members,
  groups,
  agents,
  keys,
  folders,
  grants,
  access,
  loop,
};

const usage = `Manage a workspace: members, groups, agents, keys, folders, grants, access and the learning loop

Usage: onebrain admin <area> <action> [args]
Agents and keys: you create your own agents and mint their keys; admins also manage the rest.
Areas: ${Object.keys(areas).join(', ')}. Run onebrain admin <area> for its actions.`;

export default {
  name: 'admin',
  describe: usage,
  run: async (args, io) => {
    const area = args[0] && Object.hasOwn(areas, args[0]) ? areas[args[0]] : undefined;
    if (!area) {
      io.stderr(`${usage}\n`);
      return 2;
    }
    try {
      return await area(args.slice(1), io);
    } catch (error) {
      // A usage mistake (a bad --role, a missing --yes) is exit 2; anything else goes to the loader.
      if (error instanceof CliError && error.exitCode === 2) {
        io.stderr(`error: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  },
} satisfies Command;
