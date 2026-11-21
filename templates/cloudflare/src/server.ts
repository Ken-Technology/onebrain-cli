import { type ChatResponseResult, Think } from '@cloudflare/think';
import { captureTurn, onebrainContext, onebrainSkills } from '@useonebrain/cloudflare';
import { getAgentByName, routeAgentRequest } from 'agents';

/** The Worker's bindings: wrangler.jsonc, and the secrets in .dev.vars.example. */
export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  Assistant: DurableObjectNamespace<Assistant>;
  ONEBRAIN_URL?: string;
  ONEBRAIN_API_KEY?: string;
  ONEBRAIN_FOLDER?: string;
  AGENT_TOKEN?: string;
}

/**
 * A chat agent with your team's One Brain: its skills in the skill catalog, its files and memories
 * behind search_context and set_context, and each finished turn sent to One Brain as a session.
 */
export class Assistant extends Think<Env> {
  getModel() {
    return '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
  }

  getSkills() {
    return [onebrainSkills({ env: this.env })];
  }

  configureContext() {
    return [onebrainContext({ env: this.env, folder: this.env.ONEBRAIN_FOLDER || undefined })];
  }

  onChatResponse(result: ChatResponseResult) {
    this.ctx.waitUntil(
      captureTurn(this, result, { env: this.env, folder: this.env.ONEBRAIN_FOLDER || undefined }),
    );
  }

  /** One turn over HTTP: the user's text in, the assistant's text out. */
  async ask(text: string): Promise<{ reply: string } | { error: string }> {
    const turn = await this.saveMessages([
      { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] },
    ]);
    if (turn.status !== 'completed') return { error: turn.error ?? `The turn ${turn.status}.` };
    const last = this.messages.at(-1);
    const reply =
      last?.role === 'assistant'
        ? last.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')
        : '';
    return { reply };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/status') {
      return Response.json({
        agentToken: Boolean(env.AGENT_TOKEN),
        onebrainKey: Boolean(env.ONEBRAIN_API_KEY),
      });
    }
    const guarded = url.pathname.startsWith('/api/') || url.pathname.startsWith('/agents/');
    if (!guarded) return env.ASSETS.fetch(request);

    // This Worker holds your team's One Brain key: only callers with AGENT_TOKEN may use it.
    if (!env.AGENT_TOKEN) {
      return Response.json({ error: 'Set the AGENT_TOKEN secret first.' }, { status: 503 });
    }
    const token =
      request.headers.get('authorization')?.replace(/^Bearer /, '') ??
      url.searchParams.get('token') ??
      '';
    if (!(await same(token, env.AGENT_TOKEN))) {
      return Response.json({ error: 'Wrong or missing token.' }, { status: 401 });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        chat?: unknown;
        message?: unknown;
      } | null;
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      const chat = typeof body?.chat === 'string' && body.chat ? body.chat : 'default';
      if (!message) return Response.json({ error: 'Send a message.' }, { status: 400 });
      const agent = await getAgentByName(env.Assistant, chat);
      return Response.json(await agent.ask(message));
    }
    // The Agents SDK's own routes, for a client of your own: /agents/assistant/<chat>
    return (
      (await routeAgentRequest(request, env)) ??
      Response.json({ error: 'Not found.' }, { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;

/** Compares two secrets in constant time. */
async function same(given: string, expected: string): Promise<boolean> {
  const digest = async (text: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}
