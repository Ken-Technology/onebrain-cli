import { parseArgs } from 'node:util';
import { type Command, unwrap } from '../client.ts';

const USAGE =
  'Usage: onebrain search <query...> [--kind file|skill|memory]... [--folder <path>] [--limit <n>] [--json]';
const KINDS = ['file', 'skill', 'memory'] as const;
type Kind = (typeof KINDS)[number];

export default {
  name: 'search',
  describe: `Search files, skills and memories\n\n${USAGE}`,
  run: async (args, io) => {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        kind: { type: 'string', multiple: true },
        folder: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    const query = positionals.join(' ').trim();
    const kinds = (values.kind ?? []) as string[];
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (
      !query ||
      kinds.some((k) => !KINDS.includes(k as Kind)) ||
      (limit !== undefined && !Number.isInteger(limit))
    ) {
      io.stderr(`${USAGE}\n`);
      return 2;
    }
    const { api, workspace } = await io.client();
    const response = unwrap(
      await api.POST('/v1/workspaces/{workspace}/search', {
        params: { path: { workspace } },
        // The SDK types `limit` as required (the schema's output type); the API defaults it to 10.
        body: {
          query,
          ...(kinds.length ? { kinds: kinds as Kind[] } : {}),
          ...(values.folder ? { folder: values.folder } : {}),
          ...(limit !== undefined ? { limit } : {}),
        } as { query: string; limit: number },
      }),
    );
    if (values.json) io.stdout(`${JSON.stringify(response, null, 2)}\n`);
    else {
      for (const hit of response.data) {
        const snippet = hit.snippet.replace(/\s*\n\s*/g, ' ').trim();
        io.stdout(
          `${hit.kind}  ${hit.path ?? hit.id}  ${hit.status}  ${hit.score.toFixed(3)}\n  ${snippet}\n`,
        );
      }
      if (response.data.length === 0) io.stderr('No results.\n');
    }
    if (!response.vector) io.stderr('Full-text only: the embedding service did not answer.\n');
    return 0;
  },
} satisfies Command;
