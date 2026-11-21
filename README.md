# onebrain

The `onebrain` command line, the TypeScript SDK and the agent framework packages for the One Brain API. MIT licensed.

| Path | What it is |
|---|---|
| `apps/cli` | The `onebrain` command: sign-in, search, read, remember, write, review, capture, skills sync, rules sync, init, import and admin |
| `packages/sdk` | `@useonebrain/sdk`: `createOneBrain`, the client an agent uses to search, read, remember and capture, on the typed API client generated from `packages/sdk/openapi.json`. Runs in Node, Vercel and Cloudflare Workers |
| `packages/integrations` | One Brain for an agent framework, one package each, built on `@useonebrain/sdk` |
| `templates` | Starter agents that use One Brain |
| `skills/onebrain` | The `onebrain` skill: how any agent uses One Brain well |
| `docs/export-format.md` | The format of a workspace export, so you can read your data without One Brain |
| `scripts/check-packs.mjs` | Packs each npm package and checks the tarball. CI and the release run it |

Needs Node 22.18 or newer and pnpm. In this repository Node runs the TypeScript sources directly, with no build step. The packages are built for npm when they are packed: `pnpm --filter @useonebrain/sdk pack` builds `dist/` first.

```bash
pnpm install
pnpm typecheck
pnpm test
node apps/cli/src/index.ts --help
node scripts/check-packs.mjs
```

## Releasing

`@useonebrain/sdk`, `@useonebrain/eve`, `@useonebrain/cloudflare` and `@useonebrain/ai-sdk` go to npm together, at one version, from this repository. The `onebrain` CLI is private and is not published. This tree is exported from One Brain's private repository, so a release starts there:

1. Set `version` in `packages/sdk/package.json` and in each `packages/integrations/*/package.json` to the new version, the same for all four.
2. Export (`node scripts/export-cli.mjs <empty folder>`), make this repository's tree equal the export except `.git` and `.github`, run `pnpm install` to refresh `pnpm-lock.yaml`, and open a pull request here.
3. Merge it once CI is green.
4. Tag the merge commit on `main` with the version and push the tag:

   ```bash
   git switch main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The tag starts `.github/workflows/release.yml`. It checks that the tagged commit is on `main`, installs from the lockfile, typechecks and tests. Then `node scripts/check-packs.mjs --version X.Y.Z` packs each package, which builds `dist/`, checks each tarball, and fails if a package's version is not the tag's. Only then does `pnpm -r publish` publish the packages, the SDK first, each with an npm provenance statement. It skips a package whose version is already on npm, so running the workflow again for the same tag publishes only what is missing.
