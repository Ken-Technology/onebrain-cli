import { defineMcpClientConnection } from 'eve/connections';
import { baseUrl, resolveKey } from './client.ts';
import { DEFAULT_APPROVAL, TOOL_NAMES, type ToolsOptions } from './tools.ts';

type McpConnection = Parameters<typeof defineMcpClientConnection>[0];

export type ConnectionFactoryOptions = ToolsOptions & {
  /**
   * A workspace agent key (`ob_...`), or a function that returns one. Default: env
   * ONEBRAIN_API_KEY, read when the connection first connects. For each person's own access, pass
   * `auth` instead.
   */
  apiKey?: string | (() => string | Promise<string>);
  /** Default: env ONEBRAIN_URL, else https://api.useonebrain.com. The server is `<url>/mcp`. */
  url?: string;
  /**
   * eve's auth for the connection, in place of the key: `connect("<connector>")` from
   * `@vercel/connect/eve` signs each person in to One Brain with OAuth.
   */
  auth?: McpConnection['auth'];
  /** What the model reads about the connection. */
  description?: string;
};

/**
 * One Brain's MCP server as an eve connection, for an agent that wants only the tools:
 *
 *   // agent/connections/onebrain.ts
 *   import { onebrainConnection } from '@useonebrain/eve';
 *   export default onebrainConnection();
 *
 * The model finds the tools with eve__search and calls them with eve__tool, as `onebrain__search`
 * and the rest. Only One Brain's six tools are allowed, and write and forget wait for a person's
 * approval unless `approval` says otherwise. The key goes as a Bearer token.
 */
export function onebrainConnection(options: ConnectionFactoryOptions = {}) {
  const allow = options.include ?? TOOL_NAMES;
  const approve = options.approval ?? DEFAULT_APPROVAL;
  const auth: McpConnection['auth'] = options.auth ?? {
    getToken: async () => ({
      token: await resolveKey(
        typeof options.apiKey === 'function' ? await options.apiKey() : options.apiKey,
        undefined,
      ),
    }),
  };
  return defineMcpClientConnection({
    url: `${baseUrl(options)}/mcp`,
    description:
      options.description ??
      "The team's One Brain: search, read and list its files, skills and memories, remember what is worth keeping, write files and forget memories that are wrong.",
    auth,
    tools: { allow: [...allow] },
    approval: ({ toolName }) =>
      approve.some((name) => toolName === name || toolName.endsWith(`__${name}`))
        ? 'user-approval'
        : 'not-applicable',
  });
}
