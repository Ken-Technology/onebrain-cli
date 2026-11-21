# One Brain chat (AI SDK)

The smallest chat on your team's [One Brain](https://useonebrain.com): a Next.js App Router page and one route, on the [AI SDK](https://ai-sdk.dev) and [`@useonebrain/ai-sdk`](../../packages/integrations/ai-sdk).

- Before each answer, the model gets what One Brain finds for the question, marked as search results.
- It can search, read, list and remember. To write a file or forget a memory it asks first, and you approve or deny in the chat.
- Each finished turn is stored in One Brain as a session it learns from.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FKen-Technology%2Fonebrain-cli%2Ftree%2Fmain%2Ftemplates%2Fai-sdk&env=ONEBRAIN_API_KEY,ONEBRAIN_URL&envDefaults=%7B%22ONEBRAIN_URL%22%3A%22https%3A%2F%2Fapi.useonebrain.com%22%7D&envDescription=A%20One%20Brain%20workspace%20agent%20key%20and%20the%20One%20Brain%20API%20it%20signs%20in%20to.&envLink=https%3A%2F%2Fgithub.com%2FKen-Technology%2Fonebrain-cli%2Ftree%2Fmain%2Ftemplates%2Fai-sdk%23keys)

## Keys

| Variable | What to put there |
|---|---|
| `ONEBRAIN_API_KEY` | A workspace agent key: in the One Brain app, Settings > Agents, or `onebrain admin agents create chat-bot --workspace-agent` then `onebrain admin keys create chat-bot` |
| `ONEBRAIN_URL` | `https://api.useonebrain.com`, or your own One Brain's API |
| `AI_GATEWAY_API_KEY` | Only outside Vercel: an [AI Gateway](https://vercel.com/ai-gateway) key. On Vercel the gateway signs in by itself |
| `MODEL` | Optional: any AI Gateway model id. Default `anthropic/claude-sonnet-5.5` |

The agent sees only what it is granted. Give it the folders the chat should know: `onebrain admin grants put clients --principal chat-bot --role view` (or `--role edit` to let it write there).

Captured turns go to the workspace's capture folder (Settings > General > Capture folder). A workspace agent has no private sessions, so without a capture folder the chat logs one warning and stops capturing; it still answers.

## Run it locally

```bash
cp .env.example .env.local   # then fill it in
npm install
npm run dev
```

Open http://localhost:3000 and ask about something in your workspace.

## How it works

`app/api/chat/route.ts` is the whole server:

- `withOneBrain(MODEL, { waitUntil: after })` wraps the model. Recall searches One Brain with the latest message and hands the results to the model as data. Capture stores the turn after the answer has streamed; `after` from `next/server` keeps the function alive until it is stored.
- `onebrainTools()` gives the model One Brain's six tools. `write` and `forget` need approval, which `app/page.tsx` shows as Approve and Deny buttons.
- `providerOptions: { onebrain: { sessionId: id } }` passes the chat's id, so all the turns of one chat form one session.

To stop capturing, pass `capture: false` to `withOneBrain`. The package's [README](../../packages/integrations/ai-sdk/README.md) has every option.

## For maintainers

`package-lock.json` pins the published `@useonebrain/sdk` and `@useonebrain/ai-sdk`. After a release, run `npm update --package-lock-only` here and commit the lockfile.

To try a change to the packages before it is released, install them from this repo as packed tarballs:

```bash
pnpm --filter @useonebrain/sdk pack --pack-destination /tmp/onebrain-tarballs
pnpm --filter @useonebrain/ai-sdk pack --pack-destination /tmp/onebrain-tarballs
cp -r templates/ai-sdk /tmp/onebrain-chat && cd /tmp/onebrain-chat
npm install /tmp/onebrain-tarballs/useonebrain-sdk-0.1.0.tgz /tmp/onebrain-tarballs/useonebrain-ai-sdk-0.1.0.tgz
```

Then fill in `.env.local` and run `npm run dev` as above.
