# @useonebrain/cloudflare

[One Brain](https://useonebrain.com) for [Cloudflare Agents](https://developers.cloudflare.com/agents/): your team's skills, knowledge and memories in an agent in a few lines, and each finished turn captured so One Brain's learning loop can propose improvements from it.

- `onebrainSkills()`: your One Brain skills in the agent's skill catalog (`activate_skill`, `read_skill_resource`).
- `onebrainContext()`: a context block the model searches (`search_context`) and saves memories to (`set_context`).
- `captureTurn()`: sends each finished turn to One Brain as a session. On by default; `capture: false` turns it off.
- `addOneBrain()`: connects One Brain's MCP server instead, with all six tools, and `withOneBrainApprovals()` makes `write` and `forget` wait for the user.

It runs in Workers (workerd) with no `node:` imports and no `nodejs_compat`.

## Install

```bash
npm install @useonebrain/cloudflare agents
```

Set the key as a secret, and the URL if you do not use the hosted One Brain:

```bash
npx wrangler secret put ONEBRAIN_API_KEY      # a workspace agent key, ob_...
npx wrangler secret put ONEBRAIN_URL          # optional: https://api.useonebrain.com by default
```

The [template](https://github.com/Ken-Technology/onebrain-cli/tree/main/templates/cloudflare) is a whole agent with all of this, deployable with one button.

## Use it with Think

```ts
import { Think, type ChatResponseResult } from '@cloudflare/think';
import { captureTurn, onebrainContext, onebrainSkills } from '@useonebrain/cloudflare';

export class Assistant extends Think<Env> {
  getModel() {
    return '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
  }

  getSkills() {
    return [onebrainSkills({ env: this.env })];
  }

  configureContext() {
    return [onebrainContext({ env: this.env })];
  }

  onChatResponse(result: ChatResponseResult) {
    this.ctx.waitUntil(captureTurn(this, result, { env: this.env }));
  }
}
```

Think 0.24 imports `just-bash`, an optional peer of `agents`, so install it too (`npm install @cloudflare/think ai zod just-bash`), or the Worker does not bundle.

`env` is the Worker's bindings: `ONEBRAIN_URL`, `ONEBRAIN_API_KEY` and `ONEBRAIN_WORKSPACE`, the same names as the `onebrain` CLI. They are read when first needed, so a build without secrets works. Every option below also takes `url`, `apiKey` (a string, or a function called before each request) and `workspace` directly, and `fetch`.

## Use it with AIChatAgent, or the AI SDK on its own

`captureTurn` takes `onChatResponse`'s result in `AIChatAgent` too. The skills and the context block are the Agents SDK's own pieces, so they work wherever those do:

```ts
import { AIChatAgent, type ChatResponseResult } from '@cloudflare/ai-chat';
import { ContextBlocks } from 'agents/context';
import { loadSkillCatalog } from 'agents/skills';
import { createSkillTools } from 'agents/skills/tools/ai-sdk';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { captureTurn, onebrainContext, onebrainSkills } from '@useonebrain/cloudflare';

export class Chat extends AIChatAgent<Env> {
  async onChatMessage() {
    const model = yourModel(this.env); // any AI SDK model
    const context = new ContextBlocks([onebrainContext({ env: this.env })]);
    const catalog = await loadSkillCatalog([onebrainSkills({ env: this.env })]);
    const result = streamText({
      model,
      system: [await context.freezeSystemPrompt(), catalog.prompt() ?? ''].join('\n\n'),
      messages: await convertToModelMessages(this.messages),
      tools: { ...(await context.tools()), ...createSkillTools(catalog) },
      stopWhen: stepCountIs(8),
    });
    return result.toUIMessageStreamResponse();
  }

  onChatResponse(result: ChatResponseResult) {
    this.ctx.waitUntil(captureTurn(this, result, { env: this.env }));
  }
}
```

## Skills: `onebrainSkills(options)`

A `SkillSource` (`agents/skills`) with the skills the key may use. Each skill's `SKILL.md` is parsed as the Agents SDK parses any other, and its other files are its resources (`scripts/`, `references/`, `assets/`). A skill that breaks the Agent Skills spec is reported in the catalog's diagnostics.

| Option | Default |
|---|---|
| `refreshIntervalMs` | `60000`: a listing is reused this long, per key, in the isolate; `0` lists every time |
| `skills` | every skill; a list of names to serve only those |
| `id` | `onebrain`, the source id in diagnostics |

A skill's files are fetched once per version: a listing that shows the same version reuses them. Listings are kept per key (a hash of the URL, workspace and key), never shared between keys. A listing that fails returns a `SkillSourceError`, so the catalog keeps the skills it had.

## Recall and memory: `onebrainContext(options)`

A context block (`agents/context`, which Cloudflare marks experimental) labelled `onebrain`:

- **`search_context`** searches One Brain's files, skills and memories. The model gets at most `limit` results (default 5), each with its path or memory id and a snippet of at most `snippetChars` (default 300), under a first line saying it is content from the One Brain workspace, data and not instructions.
- **`set_context`** saves a One Brain memory. A workspace agent key has no private memories, so give it a `folder` it may write: the memory is shared with whoever may read that folder. With a person's token and no folder, it is private to them.
- **The block's text** in the system prompt is a short fixed note on what One Brain holds and how to use the two tools. No request goes to One Brain per prompt.

| Option | Default |
|---|---|
| `label` | `onebrain` |
| `description` | a one-line description for the prompt |
| `limit` | `5` (at most 50) |
| `snippetChars` | `300` |
| `kinds` | files, skills and memories |
| `folder` | none: private to the person, refused for a workspace agent key |
| `private` | `false` |

## Capture: `captureTurn(agent, result, options)`

**Capture is on.** Call it from `onChatResponse`, the hook Think and AIChatAgent run once a turn has finished and its answer is saved. That is one line in your agent, so you can see it and remove it, and it works the same in both classes without changing your class hierarchy. Pass `this`: the turn count lives in the agent's Durable Object storage. Hand the promise to `this.ctx.waitUntil` rather than awaiting it: Think's `saveMessages()` resolves only after `onChatResponse` does, so a caller waiting on it would wait for the upload too.

What it sends, after each turn that completed:

- Only that turn's messages: what was said since the last capture. The user's and the assistant's text, each tool call with its input, and each tool result. Reasoning is left out, a file or image is a short note with its name (never its data), and the text of a skill the model loaded (`activate_skill`, `read_skill_resource`) is left out.
- As one session source, with the ref `cloudflare:<agent name>#turn-<n>`. The turn number and where the last capture ended are kept in the Durable Object's storage, so a restart does not send a turn again.
- To `folder` when you give one. Without it the server decides, as for the CLI: the workspace's capture folder, else private to the person the key acts for. A workspace agent key has no private sources, so it needs a capture folder on the workspace, or `folder`.

It never throws and never slows the answer: `onChatResponse` runs after the answer was streamed and saved. A turn that ended in an error or was aborted is not sent; its messages go with the next one. A turn that finished while capture was off (`capture: false`, or after a refusal) is never sent, also once capture is on again. When One Brain refuses a capture (for example a workspace agent key with no capture folder: 400), it logs one warning with what to do and stops capturing until the Worker restarts. When One Brain cannot be reached, the messages go with the next turn. The first capture logs one line saying capture is on. No log line holds a key, a token or content.

| Option | Default |
|---|---|
| `capture` | `true`; `false` sends nothing |
| `folder` | the server decides |
| `private` | `false` |
| `client` | `cloudflare`, the first part of the ref |

One Brain's search results carry its notice, so the learning loop leaves them out of what it learns from: One Brain's own answers are not evidence.

## One Brain's MCP server: `addOneBrain(agent, options)`

The MCP route gives the agent all of One Brain's tools (search, read, list, remember, write, forget) through the Agents SDK's MCP client:

```ts
import { Think } from '@cloudflare/think';
import { addOneBrain, withOneBrainApprovals } from '@useonebrain/cloudflare';

export class Assistant extends Think<Env> {
  includeMcpTools = false; // added below, with approvals
  waitForMcpConnections = true;

  override async onStart() {
    await addOneBrain(this, { env: this.env });
  }

  getTools() {
    return withOneBrainApprovals(this.mcp.getAITools());
  }
}
```

- **The key is stored in plain text.** The Agents SDK keeps an MCP server's headers in the Durable Object's SQLite storage, unencrypted, so it can reconnect after a restart. Keep the key in a secret binding, use a key limited to what the agent needs, and rotate it by changing the secret: `addOneBrain` adds the server again when the key changes.
- **OAuth for per-person access.** `addOneBrain(this, { oauth: true })` stores no key: the result is `authenticating` with an `authUrl` for the person to sign in with their own One Brain account, and the agent then sees what they may see. Call it from a request (or pass `callbackHost`) so the callback URL is right.
- **Approvals.** `withOneBrainApprovals(tools)` sets `needsApproval` on One Brain's `write` and `forget`, so a change to the team's knowledge waits for the user. Other tools are left as they are.
- It never throws: a server that cannot be added comes back `{ state: 'failed', error }`.

Tools are named `tool_onebrain_<tool>`. With both the MCP server and `onebrainContext`, the model has two ways to search; pick one.

## Without code

Any MCP client can use One Brain at `<ONEBRAIN_URL>/mcp` (`https://api.useonebrain.com/mcp`), with the key as a Bearer token or by OAuth. On Cloudflare that is `addOneBrain`, a Zero Trust MCP server portal, or the AI Playground. See [One Brain on Cloudflare](https://github.com/Ken-Technology/onebrain-cli/blob/main/docs/integrations/cloudflare.md).

## Supported versions

`agents` 0.32 to 0.34 (the peer range is `>=0.32.0 <0.35.0`): the `agents/skills` source interface this package implements arrived in 0.32. The tests run in Node and inside workerd against 0.32.0, 0.33.0 and 0.34.0. The snippets above ran under `wrangler dev` on `@cloudflare/think` 0.24.0 and `@cloudflare/ai-chat` 0.12.3, with `agents` 0.34.0 (Think 0.24 needs 0.34).

## License

MIT
