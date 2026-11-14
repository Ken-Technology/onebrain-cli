# onebrain

The `onebrain` command line and the TypeScript SDK for the One Brain API. MIT licensed.

| Path | What it is |
|---|---|
| `apps/cli` | The `onebrain` command: sign-in, search, read, remember, write, review, capture, skills sync, rules sync, init, import and admin |
| `packages/sdk` | The typed API client, generated from `packages/sdk/openapi.json` |
| `docs/export-format.md` | The format of a workspace export, so you can read your data without One Brain |

Needs Node 22.18 or newer and pnpm. Node runs the TypeScript sources directly; there is no build step.

```bash
pnpm install
pnpm typecheck
pnpm test
node apps/cli/src/index.ts --help
```
