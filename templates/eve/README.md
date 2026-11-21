# One Brain eve agent

An [eve](https://eve.dev) agent that works from your team's [One Brain](https://useonebrain.com). Before each reply it gets the files, skills and memories that match the message. It can search, read and save to One Brain. After each turn, it stores the turn in One Brain as a session the team's brain learns from.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FKen-Technology%2Fonebrain-cli%2Ftree%2Fmain%2Ftemplates%2Feve&env=ONEBRAIN_API_KEY,ONEBRAIN_URL&envDefaults=%7B%22ONEBRAIN_URL%22%3A%22https%3A%2F%2Fapi.useonebrain.com%22%7D&envDescription=A%20One%20Brain%20workspace%20agent%20key%20%28ob_...%29%20and%20the%20One%20Brain%20API%20URL.&envLink=https%3A%2F%2Fgithub.com%2FKen-Technology%2Fonebrain-cli%2Ftree%2Fmain%2Ftemplates%2Feve%23environment-variables&project-name=onebrain-eve-agent&repository-name=onebrain-eve-agent)

One Brain comes in through [`@useonebrain/eve`](https://github.com/Ken-Technology/onebrain-cli/tree/main/packages/integrations/eve#readme), in two files:

- `agent/memory/onebrain.ts`: One Brain as the agent's memory. It recalls before each turn, captures after it, and gives the model `onebrain__search`, `onebrain__read`, `onebrain__list`, `onebrain__remember`, `onebrain__write` and `onebrain__forget`. `write` and `forget` wait for a person's approval.
- `agent/skills/onebrain.ts`: the workspace's skills, as the agent's own skills.

## Environment variables

| Name | Required | What it is |
|---|---|---|
| `ONEBRAIN_API_KEY` | Yes | A One Brain workspace agent key (`ob_...`). It decides what the agent may read and write. |
| `ONEBRAIN_URL` | No | The One Brain API. Unset, the agent uses `https://api.useonebrain.com`. |
| `ONEBRAIN_WORKSPACE` | No | The workspace slug. Unset, the agent uses the key's own workspace. |

A workspace admin makes the key with the `onebrain` CLI, then gives the agent the folders it should use: `edit` on the folders it may save to, and `view` on `skills` so it loads the workspace's skills.

```bash
onebrain admin agents create eve-agent --workspace-agent
onebrain admin keys create eve-agent
onebrain admin grants put clients --principal eve-agent --role edit
onebrain admin grants put skills --principal eve-agent --role view
```

A workspace agent's key belongs to no one, so its captured turns need a folder: set the workspace's capture folder in One Brain under Settings > General (for example `sessions`), and give the agent `edit` on it. Without one, the agent warns once and stores nothing. Turns go nowhere else.

The model is eve's default, `anthropic/claude-fable-5.2` through Vercel's AI Gateway. Deployed on Vercel, it needs no key. To run it on your machine, link the project to Vercel or put `AI_GATEWAY_API_KEY` in `.env.local`. To use another model, change `model` in `agent/agent.ts`.

## Run it

Deploy with the button above, or run it on your machine with Node 24:

```bash
npm install
cp .env.example .env.local   # then fill in ONEBRAIN_API_KEY
npm run dev
```

`npm run dev` runs `eve dev`, which reads `.env.local`. There is no lockfile yet: the template's first lockfile comes once `@useonebrain/eve` is published to npm, so the install resolves the newest versions its ranges allow.

## From the first message to the captured turn

Say your One Brain has `clients/acme.md`, which names Acme's renewal date and contact, and you ask the agent:

> When does Acme renew, and who is the contact?

1. **Recall.** Before the model runs, the agent searches One Brain for your message. The best matches, here `clients/acme.md`, come into the conversation as One Brain data, each with its path, a snippet and how to read all of it.
2. **Reply.** The model answers from them and names the file. When a snippet isn't enough, it reads the whole file with `onebrain__read`.
3. **Saving.** Tell it "Remember that Acme wants a 30-minute call before signing." It saves that as a memory with `onebrain__remember`, in the folder it belongs to (`clients`), and the next session recalls it.
4. **Capture.** After each turn, the turn's messages are stored in One Brain as one session: what you wrote, the agent's replies, its tool calls and their results. Its ref is `eve:<session id>#turn-<n>`, so the same turn is never stored twice.

To see the captured turns, list the latest sessions, then open one:

```bash
curl -s "$ONEBRAIN_URL/v1/workspaces/<workspace>/sources?kind=session&limit=2" -H "Authorization: Bearer $ONEBRAIN_API_KEY"
curl -s "$ONEBRAIN_URL/v1/workspaces/<workspace>/sources/<id>" -H "Authorization: Bearer $ONEBRAIN_API_KEY"
```

The second answer's `externalRef` is the turn's ref, `folder` is the capture folder, and `excerpt` starts with what you wrote:

```json
{ "externalRef": "eve:wrun_01M7XSFCTTSQAN2SJPW81G0EQY#turn-2", "folder": "sessions", "excerpt": "user: Remember that Acme wants a 30-minute call before signing.\nassistant: [tool onebrain__remember] ..." }
```

To store nothing, pass `onebrain({ capture: false })` in `agent/memory/onebrain.ts`. The [package README](https://github.com/Ken-Technology/onebrain-cli/tree/main/packages/integrations/eve#readme) has every option, and how to give each person their own One Brain access instead of one workspace key.

## What changed from eve's memory-agent template

This template starts from eve's memory-agent template, as it is in the eve repo under `apps/templates/eve-memory-agent-template` for eve 1.2.0 (MIT, copyright Vercel, kept in [LICENSE](LICENSE)). From it:

- **Kept as is:** `agent/agent.ts`, the eve channel, the current-time instruction, the sandbox, the `agent`, `web_fetch`, `web_search`, `write_file` and `edit_file` tools, `tsconfig.json`, `.gitignore` and `.vercelignore`.
- **Replaced:** the two file-based memories (user and channel preferences), by One Brain's memory slot and skills (`agent/memory/onebrain.ts`, `agent/skills/onebrain.ts`). `agent/instructions.md` is rewritten for One Brain, and `.env.example` holds the One Brain variables instead of Slack's.
- **Removed:** the Slack channel and its helpers under `agent/lib`, the memory scope, the tests and evals, the lint, format, knip and lefthook setup with their dev dependencies, `AGENTS.md`, `CLAUDE.md`, `CUSTOMIZATION.md`, the lockfile, and the `@vercel/connect` and `zod` dependencies only the removed files used.
- **Added:** the `@useonebrain/eve` dependency. The package is renamed `onebrain-eve-agent` and marked private, and `pnpm-workspace.yaml` lets pnpm install `@useonebrain/*` releases as soon as they're published.

## License

MIT. See [LICENSE](LICENSE).
