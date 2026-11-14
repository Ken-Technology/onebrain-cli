import { ApiError, type Command } from '../../../src/client.ts';

export default {
  name: 'fail',
  describe: 'Always fails\n\nUsage: onebrain fail',
  run: async () => {
    throw new ApiError(404, 'not_found', 'No such file');
  },
} satisfies Command;
