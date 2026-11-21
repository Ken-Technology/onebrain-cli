import { createMCPClient, type MCPClientConfig, type OAuthClientProvider } from '@ai-sdk/mcp';
import { DEFAULT_URL, OneBrainError } from '@useonebrain/sdk';
import { env } from './connect.ts';

/**
 * The URL without trailing slashes. A loop, not a regex: `/\/+$/` takes quadratic time on a long
 * run of slashes.
 */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

export type OneBrainMcpOptions = Omit<MCPClientConfig, 'transport'> & {
  /** The API's base URL; the MCP server is at `<url>/mcp`. Default: env ONEBRAIN_URL, else https://api.useonebrain.com. */
  url?: string;
  /**
   * A workspace agent key (`ob_...`) or a person's access token, sent as a Bearer token. A function
   * is called once, when the client connects. Default: env ONEBRAIN_API_KEY. Not with authProvider.
   */
  apiKey?: string | (() => string | Promise<string>);
  /** Sign a person in with OAuth instead of a key: the MCP client runs the flow against One Brain. */
  authProvider?: OAuthClientProvider;
};

/**
 * An MCP client connected to One Brain's MCP server, for its six tools without this package's
 * own: `const tools = await (await onebrainMcp()).tools()`. Close it when you are done with it.
 * Needs `@ai-sdk/mcp`.
 */
export async function onebrainMcp(options: OneBrainMcpOptions = {}) {
  const { url: given, apiKey, authProvider, ...config } = options;
  const url = `${withoutTrailingSlashes(given ?? env('ONEBRAIN_URL') ?? DEFAULT_URL)}/mcp`;
  if (authProvider) {
    return createMCPClient({ ...config, transport: { type: 'http', url, authProvider } });
  }
  const key = apiKey ?? env('ONEBRAIN_API_KEY');
  const token = typeof key === 'function' ? await key() : key;
  if (!token) {
    throw new OneBrainError(
      'no_api_key',
      'No One Brain key: pass apiKey or authProvider to onebrainMcp, or set ONEBRAIN_API_KEY.',
    );
  }
  return createMCPClient({
    ...config,
    transport: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
  });
}
