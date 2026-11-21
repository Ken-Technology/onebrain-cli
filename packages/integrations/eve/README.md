# @useonebrain/eve

[One Brain](https://useonebrain.com) for [eve](https://eve.dev) agents. Your team's files, skills and memories come into each turn, the agent gets One Brain's tools, and each turn is stored back in One Brain as a session it can learn from.

- `onebrain()`: an eve memory provider. It recalls before each turn, captures after it, and gives the model six tools.
- `onebrainSkills()`: the workspace's skills, as the agent's own skills.
- `onebrainConnection()`: One Brain's MCP server as an eve connection, for tools only.

Needs eve 1.x. eve itself runs on Node 24.

## Install

```bash
npm install @useonebrain/eve
```

Or let eve write the files for you from One Brain's registry:

```bash
eve registry add @onebrain=https://useonebrain.com/r/{name}.json
eve add @onebrain/memory
eve add @onebrain/skills
```

`@onebrain/memory`, `@onebrain/skills` and `@onebrain/connection` each write one of the files below and install this package. `pnpm --filter @useonebrain/eve registry` builds the registry (`dist/r/registry.json` and one JSON per item) for any static host.

## Mount it

```ts
// agent/memory/onebrain.ts
import onebrain from '@useonebrain/eve';
import { defineMemory } from 'eve/memory';

export default defineMemory({
  description: "The team's One Brain: files, skills and memories.",
  provider: onebrain(),
  scope: 'workspace',
});
```

```ts
// agent/skills/onebrain.ts
import { onebrainSkills } from '@useonebrain/eve';

export default onebrainSkills();
```

Set `ONEBRAIN_API_KEY` to a workspace agent key (`ob_...`). A workspace admin makes one with the `onebrain` CLI:

```bash
onebrain admin agents create eve-agent --workspace-agent
onebrain admin keys create eve-agent
```

The key reads and writes what its grants allow, so give the agent access to the folders it should use (`onebrain admin grants put clients --principal eve-agent --role edit`), including `skills` if it should load the workspace's skills.

On each turn:

1. **Recall.** Before the model runs, the user's latest message is searched in One Brain. The top results (5 by default) come into the conversation as One Brain data: each opens with One Brain's notice, then names the file path or memory id, a short snippet and how to read all of it. A result keeps its rank's id from turn to turn, and eve replaces a message with the same id, so the conversation never holds more than 5 of them.
2. **Tools.** The model gets `onebrain__search`, `onebrain__read`, `onebrain__list`, `onebrain__remember`, `onebrain__write` and `onebrain__forget`, the same operations as One Brain's MCP tools. `write` and `forget` wait for a person's approval. Every result carries One Brain's notice.
3. **Capture.** After the turn, its messages are stored in One Brain as one session.

When One Brain can't be reached, recall and capture log a warning and the turn goes on without them. Nothing here fails or holds up a turn: each request gives up after 15 seconds.

## Capture

Capture is on by default. After each turn it sends that turn's messages, and only that turn's:

- what the person wrote
- the agent's replies
- the tools it called, and what they returned

It leaves out the model's reasoning, eve's own messages (instructions, compaction summaries, approval bookkeeping) and the recalled One Brain results. In place of the text of a One Brain skill the model loaded, it keeps only One Brain's notice.

Each turn is one session source with the ref `eve:<session id>#turn-<n>`, so a turn is never sent twice: eve running a capture again with the same operation id sends nothing. When eve compacts the conversation in the middle of a turn, the turn's messages so far go first as `eve:<session id>#turn-<n>#compaction-<k>`, and the rest go when the turn ends.

The session goes in `capture.folder`, else in the workspace's capture folder, else it stays private to the person the key belongs to. A workspace agent's key belongs to no one, so it needs a folder. The first capture logs one line that says where turns go. When One Brain refuses a capture because of how things are set up (no capture folder for a workspace agent's key, a folder the key may not write), the package warns once with what to do and turns capture off for the process. With an `apiKey` function, it turns capture off for that caller only.

```ts
provider: onebrain({ capture: false }),                  // store nothing
provider: onebrain({ capture: { folder: 'agents/eve' } }), // in this folder
```

## Options

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `ONEBRAIN_API_KEY` | A workspace agent key or a person's OAuth token, or a function of the eve session that returns one |
| `url` | `ONEBRAIN_URL`, else `https://api.useonebrain.com` | The One Brain API |
| `workspace` | `ONEBRAIN_WORKSPACE`, else the key's own workspace | The workspace slug |
| `recall` | `{ limit: 5, snippetChars: 500 }` | Also `kinds` (`file`, `skill`, `memory`) and `folder`. `false` turns recall off |
| `capture` | on | `{ folder, private }`, or `false` |
| `tools` | all six, `write` and `forget` on approval | `{ include, approval }`, or `false` for none |
| `fetch` | the global `fetch` | What requests are sent with |

The environment is read when a request is made, so `eve build` needs no key. `onebrainSkills()` takes `apiKey`, `url`, `workspace` and `fetch` too, plus `prefix` (put before each skill's name), `deferred` (keep the skills out of the system prompt until the model searches for them) and `max` (default 100).

## Each person's own access

With one workspace key, everyone who talks to the agent shares what that key may read. To give each person their own access, pass `apiKey` a function. It gets the eve session and returns that person's One Brain token. Then scope the slot per person. With [Vercel Connect](https://vercel.com/docs/connect), the person signs in to One Brain through the connection the first time the agent needs it, and the memory slot uses the same token:

```ts
// agent/connections/onebrain.ts
import { onebrainConnection } from '@useonebrain/eve';
import { connect } from '@vercel/connect/eve';

export default onebrainConnection({ auth: connect('onebrain') });
```

```ts
// agent/memory/onebrain.ts
import onebrain from '@useonebrain/eve';
import { getToken } from '@vercel/connect';
import { defineMemory } from 'eve/memory';
import { byPrincipal } from 'eve/memory/scope';

export default defineMemory({
  description: 'What the signed-in person may read in One Brain.',
  provider: onebrain({
    apiKey: ({ session }) => {
      const caller = session.auth.current;
      if (!caller?.principalId) throw new Error('No signed-in person');
      return getToken('onebrain', {
        subject: { type: 'user', id: caller.principalId, issuer: caller.issuer },
      });
    },
    // The connection gives the tools: the slot recalls and captures.
    tools: false,
  }),
  scope: byPrincipal,
});
```

When the function throws, for example for a person who hasn't signed in yet, recall and capture warn with its error and skip that turn. The next turn asks again.

## Tools only: the MCP connection

For One Brain's tools without recall or capture, mount the connection alone:

```ts
// agent/connections/onebrain.ts
import { onebrainConnection } from '@useonebrain/eve';

export default onebrainConnection();
```

The model finds the tools with `eve__search` and calls them as `onebrain__search` and the rest. `write` and `forget` wait for approval. It takes `apiKey`, `url`, `include`, `approval`, `auth` and `description`. Mount either the connection or a memory slot with tools under the name `onebrain`, not both, or their tools share names.

## Why skills are a file and not an extension

eve can bring skills in through an extension, but an extension is a package of its own: `eve extension build` takes over the package's `.` and `./tools` exports. So an extension couldn't sit in this package next to `onebrain()`. A dynamic skill file does the same work at the start of a session in one line, so the skills come as `onebrainSkills()` for the agent's `skills/` folder.

## License

MIT
