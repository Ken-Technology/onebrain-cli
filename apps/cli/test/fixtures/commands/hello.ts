import type { Command } from '../../../src/client.ts';

export default {
  name: 'hello',
  describe: 'Say hello\n\nUsage: onebrain hello <name>',
  run: async (args, io) => {
    io.stdout(`hello ${args[0]}\n`);
    return 0;
  },
} satisfies Command;
