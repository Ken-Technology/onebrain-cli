# AI SDK tools registry entry (draft)

The entry to add to the `tools` array in [vercel/ai](https://github.com/vercel/ai)'s `content/tools-registry/registry.ts`, following its [guide](https://github.com/vercel/ai/blob/main/contributing/add-new-tool-to-registry.md). File it only after `@useonebrain/ai-sdk` is on npm, since the guide requires a published package.

```ts
  {
    slug: 'onebrain',
    name: 'One Brain',
    description:
      "Give agents your team's knowledge base. Tools to search, read and list knowledge files, skills and memories, remember new facts, and propose file edits a person approves. withOneBrain adds recall before each answer and stores each finished turn as a session One Brain learns from.",
    packageName: '@useonebrain/ai-sdk',
    tags: ['memory', 'knowledge-base', 'skills', 'search'],
    apiKeyEnvName: 'ONEBRAIN_API_KEY',
    installCommand: {
      pnpm: 'pnpm add @useonebrain/ai-sdk',
      npm: 'npm install @useonebrain/ai-sdk',
      yarn: 'yarn add @useonebrain/ai-sdk',
      bun: 'bun add @useonebrain/ai-sdk',
    },
    codeExample: `import { generateText, isStepCount } from 'ai';
import { onebrainTools, withOneBrain } from '@useonebrain/ai-sdk';

const { text } = await generateText({
  model: withOneBrain('anthropic/claude-sonnet-5.5'),
  prompt: 'When does Northwind renew, and who is their champion?',
  tools: onebrainTools(),
  stopWhen: isStepCount(5),
  providerOptions: { onebrain: { sessionId: 'demo' } },
});

console.log(text);`,
    docsUrl: 'https://useonebrain.com/integrations/ai-sdk',
    apiKeyUrl: 'https://app.useonebrain.com',
    websiteUrl: 'https://useonebrain.com',
    npmUrl: 'https://www.npmjs.com/package/@useonebrain/ai-sdk',
  },
```

## Filing it

1. Publish `@useonebrain/ai-sdk` to npm and run the code example against it.
2. Check that `docsUrl`, the AI SDK guide on useonebrain.com, answers 200: the guide asks for the integration guide itself, not a home page. If it does not yet, use the package README in onebrain-cli instead (`https://github.com/Ken-Technology/onebrain-cli/tree/main/packages/integrations/ai-sdk#readme`; the registry already lists GitHub READMEs, such as Redis's).
3. Fork vercel/ai, branch `feat/add-tool-onebrain`, add the entry to `content/tools-registry/registry.ts` only, commit `feat(tools-registry): add onebrain`, and open a PR with that title.
