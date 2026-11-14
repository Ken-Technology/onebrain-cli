import type { Command } from '../../../../src/client.ts';

export default {
  name: 'ignored',
  describe: 'Never loaded',
  run: async () => 0,
} satisfies Command;
