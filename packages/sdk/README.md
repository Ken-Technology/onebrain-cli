# @useonebrain/sdk

The client for [One Brain](https://useonebrain.com), your team's knowledge base for AI agents: files, skills, memories, and the sessions it learns from. Give your agent search, read and remember in a few lines, and capture its conversations so One Brain can propose improvements from them.

It runs wherever `fetch` does: Node 22 and later, Vercel Functions and Cloudflare Workers, with no Node built-ins.

## Install

```bash
npm install @useonebrain/sdk
```

## Use it

```ts
import { createOneBrain } from '@useonebrain/sdk';

const brain = createOneBrain({ apiKey: process.env.ONEBRAIN_API_KEY });

const { data } = await brain.search({ query: 'Acme renewal', limit: 5 });
const file = await brain.read({ path: data[0].path });
await brain.remember({ text: 'Acme moved its renewal to April', folder: 'clients/acme' });
```

| Method | What it does |
|---|---|
| `search({ query, kinds?, folder?, limit? })` | Searches the files, skills and memories the key may read |
| `read({ path })` / `read({ id })` | A file, or a skill folder with its files, by path; a memory by id |
| `list({ path? })` / `list({ skills: true })` | A folder's children (the root by default), or the skills |
| `remember({ text, folder?, private?, source? })` | Saves a memory. With a folder it is shared with whoever reads the folder; without one it is private |
| `write({ path, body, baseVersion?, title?, why? })` | Creates or changes a file. In a review folder it becomes an improvement a person accepts |
| `forget({ id, reason, correction? })` | Retires a memory that is wrong or out of date, with an optional correction |
| `skills.list()`, `skills.get(name)`, `skills.file(name, path)` | The skills, one skill with its files, one file of a skill |
| `capture({ messages, ref?, client?, folder?, private? })` | Stores a conversation as a session One Brain learns from |
| `workspace()` | The workspace slug the client works in |
| `api` | The typed client underneath, signed in, for every other route |

Each method resolves with the body the One Brain API answers, typed from its OpenAPI spec. They are the same operations as One Brain's MCP tools of the same names.

## Sign in

`apiKey` is either a workspace agent key (`ob_...`, made in the One Brain app under Agents, or with `onebrain admin keys create <agent>`) or a person's OAuth access token. Both go as a Bearer token. Pass a function to hand out a fresh token before each request:

```ts
const brain = createOneBrain({ apiKey: async () => await getAccessToken() });
```

| Option | Default |
|---|---|
| `url` | `ONEBRAIN_URL`, else `https://api.useonebrain.com` |
| `apiKey` | `ONEBRAIN_API_KEY` |
| `workspace` | `ONEBRAIN_WORKSPACE`, else the key's own workspace, asked once from `GET /v1/me` |
| `fetch` | the global `fetch` |

The environment is read only where there is one: in a Cloudflare Worker without `nodejs_compat`, pass the options from your bindings.

## Capture conversations

```ts
import { createOneBrain, type Message } from '@useonebrain/sdk';

const messages: Message[] = [
  { role: 'user', content: 'When does Acme renew?' },
  { role: 'assistant', content: 'In April. I saved that.' },
];
await brain.capture({ messages, ref: `${sessionId}#turn-${turn}`, client: 'my-agent' });
```

`capture` writes the messages as the plain transcript One Brain's learning loop reads (`toTranscript` gives you that text) and stores it as a session. Messages are `{ role: 'system' | 'user' | 'assistant' | 'tool', content: string | parts }`. Tool calls and results become lines the loop reads as such; an image or a file becomes a short note, never its data; system messages and reasoning are left out.

- **Send each message once.** One Brain tells sessions apart by their content; the ref is only a label. Send the messages that are new since the last capture, with a ref of their own such as `<session id>#turn-<n>`. Sending the whole conversation every turn stores every turn again.
- **Where it lands.** With `folder`, there. With neither `folder` nor `private`, the server decides: the workspace's capture folder, else private to the person the key acts for. A workspace agent has no private sources, so give it a folder or set a capture folder.
- **Long sessions** over the largest source the server stores go in parts cut between messages, with refs `<ref>#part-<n>`.
- **One Brain's own answers are not evidence.** When your tools hand the agent what One Brain returned, include `ONE_BRAIN_NOTICE` in their output (`{ notice: ONE_BRAIN_NOTICE, data }`), as One Brain's MCP tools do: the loop leaves those answers out.

## Errors

A refused request throws a `OneBrainError` with the API's `code` (`not_found`, `conflict`, `too_many_requests`, ...), the HTTP `status`, `retryAfter` in seconds when the API gives one, and the error's other fields in `details` (such as `currentVersion` on a conflict). Its message never holds your key, a token or content.

```ts
import { OneBrainError } from '@useonebrain/sdk';

try {
  await brain.write({ path: 'notes/plan.md', body, baseVersion: 3 });
} catch (error) {
  if (error instanceof OneBrainError && error.code === 'conflict') {
    console.log('Changed meanwhile; now at version', error.details.currentVersion);
  }
}
```

## License

MIT
