# One Brain Agent

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ken-Technology/onebrain-cli/tree/main/templates/cloudflare)

A chat agent on Cloudflare that knows what your team knows. It is built with [Think](https://developers.cloudflare.com/agents/) and [`@useonebrain/cloudflare`](https://www.npmjs.com/package/@useonebrain/cloudflare).

<!-- dash-content-start -->

A chat agent with your team's [One Brain](https://useonebrain.com): the skills, knowledge files and memories your team keeps for its AI agents.

- **Skills.** Your One Brain skills join the agent's skill catalog. The model loads one when a request matches it.
- **Knowledge.** The agent searches your One Brain before it answers about your team, clients and projects, and says which file or memory an answer came from.
- **Memory.** When you tell it something worth keeping, it saves it as a One Brain memory your team can review.
- **Learning.** Each finished chat turn is sent to One Brain as a session. One Brain's learning loop proposes improvements to your files from them.

It is one Worker:

- a [Think](https://developers.cloudflare.com/agents/) agent in a Durable Object, one per chat, with its messages;
- [Workers AI](https://developers.cloudflare.com/workers-ai/) for the model (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`);
- a small chat page served from static assets.

The Worker holds your One Brain agent key, and only callers with your `AGENT_TOKEN` may chat with it.

<!-- dash-content-end -->

## Get started

You need a One Brain workspace and an agent key for it (`ob_...`). Make one in the One Brain app under **Agents**, or with `onebrain admin keys create <agent>`. The agent reads and writes what the key may.

Create the project:

```bash
npm create cloudflare@latest -- --template https://github.com/Ken-Technology/onebrain-cli/templates/cloudflare
```

**No lockfile yet.** `@useonebrain/cloudflare` is not on npm yet, so the template has no `package-lock.json`, and both the Deploy button and `npm create` fail at `npm install` until it is published (DEV-13094). A lockfile comes with the first release.

Set the secrets for local runs:

```bash
cp .dev.vars.example .dev.vars    # then fill in ONEBRAIN_API_KEY and AGENT_TOKEN
npx wrangler login                # Workers AI runs on your account, also under wrangler dev
npm run dev
```

Open http://localhost:8787 and enter your `AGENT_TOKEN` when the page asks for it.

To deploy, set the secrets on the Worker, then deploy:

```bash
npx wrangler secret put ONEBRAIN_API_KEY
npx wrangler secret put AGENT_TOKEN
npm run deploy
```

## Settings

| Name | Kind | What it is |
|---|---|---|
| `ONEBRAIN_API_KEY` | secret | The One Brain agent key. |
| `AGENT_TOKEN` | secret | The token a caller must send. Make one with `openssl rand -hex 32`. Without it, the Worker refuses every chat. |
| `ONEBRAIN_URL` | secret or var | Your One Brain API. Default `https://api.useonebrain.com`. |
| `ONEBRAIN_FOLDER` | var | The folder for the agent's memories and captured chats, such as `agents/assistant`. Empty by default: a key that acts for a person keeps memories private to that person, and chats go to the workspace's capture folder (else private). A workspace agent key has no private space, so it needs this or a capture folder on the workspace. |
| `ONEBRAIN_WORKSPACE` | var | The workspace slug, for a key that may use several. |

## What it sends to One Brain

Capture is on: after each finished turn, the turn's messages go to One Brain as a session with the ref `cloudflare:<chat>#turn-<n>`. That covers the user's text, the assistant's text, and tool calls with their results. Skill contents are left out. Each turn is sent once, and a turn finished while capture is off is never sent. To turn capture off, pass `capture: false` to `captureTurn` in `src/server.ts`.

## Call it

- `POST /api/chat` with `Authorization: Bearer <AGENT_TOKEN>` and `{ "chat": "<id>", "message": "..." }` runs one turn and answers `{ "reply": "..." }`. Each chat id is its own conversation.
- `/agents/assistant/<chat>?token=<AGENT_TOKEN>` is the Agents SDK's WebSocket, for a client of your own. `useAgent` from `agents/react` sends the token with `query: { token }`.
- `GET /api/status` says which secrets are missing, without their values.

## Change it

- **Another model:** return any AI SDK model from `getModel()` in `src/server.ts`.
- **MCP instead of the context block:** `addOneBrain(this, { env: this.env })` in `onStart` connects One Brain's MCP server, with its six tools. See the [package README](https://github.com/Ken-Technology/onebrain-cli/tree/main/packages/integrations/cloudflare).
