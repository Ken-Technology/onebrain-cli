import { type ConnectOptions, keyOf, storageOf, urlOf } from './connect.ts';

export type AddOneBrainOptions = Pick<ConnectOptions, 'env' | 'url' | 'apiKey'> & {
  /**
   * Sign in with OAuth instead of a key: each person who connects this agent authorizes One Brain
   * with their own account, and the agent sees what they may see. The result is then usually
   * `authenticating` with an `authUrl` to send them to.
   */
  oauth?: boolean;
  /** The server's id and name. Default `onebrain`, so its tools are `tool_onebrain_<tool>`. */
  id?: string;
  /** For OAuth: the callback origin, when the one the request came in on is not right. */
  callbackHost?: string;
  /** For OAuth: a fixed callback path, routed to this agent by you. */
  callbackPath?: string;
};

export type AddOneBrainResult =
  | { id: string; state: 'ready' }
  | { id: string; state: 'authenticating'; authUrl: string }
  | { id: string; state: 'failed'; error: string };

type McpServerOptions = {
  id?: string;
  callbackHost?: string;
  callbackPath?: string;
  transport?: { type?: 'streamable-http'; headers?: Record<string, string> };
};

/**
 * The parts of an Agent (`agents`) that addOneBrain uses: pass `this`. It also keeps a fingerprint
 * of the key in the Durable Object's storage, read from the agent's (protected) `ctx`.
 */
export type McpAgent = {
  addMcpServer(
    name: string,
    url: string,
    options?: McpServerOptions,
  ): Promise<{ id: string; state: string; authUrl?: string }>;
  removeMcpServer(id: string): Promise<unknown>;
  reconnectMcpServer?(id: string): Promise<{ id: string; state: string; authUrl?: string }>;
};

/**
 * Connects the agent to One Brain's MCP server (`<ONEBRAIN_URL>/mcp`): its tools (search, read,
 * list, remember, write, forget) join the agent's tools. Call it from `onStart`.
 *
 * With a key (ONEBRAIN_API_KEY, or apiKey) it is sent as a Bearer token. The Agents SDK keeps the
 * headers of an MCP server in plain text in the Durable Object's SQLite storage, so the key sits
 * there too: keep it in a secret binding, and use a key limited to what the agent needs. When the
 * key changes, the server is added again with the new one. With `oauth: true` no key is stored:
 * each person signs in, and One Brain's OAuth tokens are kept by the Agents SDK.
 *
 * Never throws: a server that cannot be added comes back `failed`, with a reason that holds no key.
 */
export async function addOneBrain(
  agent: McpAgent,
  options: AddOneBrainOptions = {},
): Promise<AddOneBrainResult> {
  const id = options.id ?? 'onebrain';
  const url = `${urlOf(options)}/mcp`;
  const callback = {
    ...(options.callbackHost ? { callbackHost: options.callbackHost } : {}),
    ...(options.callbackPath ? { callbackPath: options.callbackPath } : {}),
  };
  try {
    if (options.oauth) {
      return settled(
        await connect(agent, id, url, { id, ...callback, transport: { type: 'streamable-http' } }),
      );
    }
    const key = await keyOf(options);
    if (!key) {
      return {
        id,
        state: 'failed',
        error: 'No One Brain key: set ONEBRAIN_API_KEY or pass apiKey, or pass oauth: true.',
      };
    }
    // Added again when the URL or the key changed: the SDK keeps the first headers otherwise.
    const storage = storageOf(agent);
    const stored = `onebrain:mcp:${id}`;
    const fingerprint = await sha256(`${url}\n${key}`);
    const previous = await storage?.get(stored);
    if (previous !== undefined && previous !== fingerprint) {
      await agent.removeMcpServer(id).catch(() => undefined);
    }
    const result = await connect(agent, id, url, {
      id,
      ...callback,
      transport: { type: 'streamable-http', headers: { Authorization: `Bearer ${key}` } },
    });
    await storage?.put(stored, fingerprint);
    return settled(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[onebrain] Could not add One Brain's MCP server at ${url}: ${message}`);
    return { id, state: 'failed', error: message };
  }
}

/** addMcpServer, and once more through reconnectMcpServer when the server is on record as failed. */
async function connect(agent: McpAgent, id: string, url: string, options: McpServerOptions) {
  try {
    return await agent.addMcpServer(id, url, options);
  } catch (error) {
    if (typeof agent.reconnectMcpServer !== 'function') throw error;
    return await agent.reconnectMcpServer(id);
  }
}

function settled(result: { id: string; state: string; authUrl?: string }): AddOneBrainResult {
  if (result.state === 'authenticating' && result.authUrl) {
    return { id: result.id, state: 'authenticating', authUrl: result.authUrl };
  }
  if (result.state === 'ready') return { id: result.id, state: 'ready' };
  return { id: result.id, state: 'failed', error: `The server is ${result.state}` };
}

/**
 * The agent's tools with One Brain's `write` and `forget` waiting for the user's approval
 * (`needsApproval`), as everything that changes or retires the team's knowledge should. Pass what
 * `this.mcp.getAITools()` returns; tools of other servers are left as they are.
 */
export function withOneBrainApprovals<T extends Record<string, object>>(
  tools: T,
  options: { id?: string; tools?: readonly string[] } = {},
): T {
  // The Agents SDK names a server's tools tool_<id without dashes>_<tool>.
  const prefix = `tool_${(options.id ?? 'onebrain').replace(/-/g, '')}_`;
  const gated = new Set((options.tools ?? ['write', 'forget']).map((tool) => `${prefix}${tool}`));
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      gated.has(name) ? { ...tool, needsApproval: true } : tool,
    ]),
  ) as T;
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
