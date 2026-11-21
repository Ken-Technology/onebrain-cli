/**
 * The package's unit tests, written once and run twice: in Node by unit.test.ts, and inside workerd
 * by workerd.test.ts, which bundles this file into a Worker without nodejs_compat. So they use no
 * Node built-ins and no test framework: each case throws when it fails.
 */
import { ONE_BRAIN_NOTICE } from '@useonebrain/sdk';
import { ContextBlocks } from 'agents/context';
import { loadSkillCatalog, type SkillSource } from 'agents/skills';
import { resetCaptureState } from '../src/capture.ts';
import {
  addOneBrain,
  captureTurn,
  onebrainContext,
  onebrainSkills,
  withOneBrainApprovals,
} from '../src/index.ts';
import { error, type FakeSkill, fakeBrain, skillMd, URL_ } from './fake-brain.ts';

export type Case = { name: string; run: () => Promise<void> };
export const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected ${b}\n  got      ${a}`);
}
/** Runs fn with console.log and console.warn recorded, not printed. */
async function quiet<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; logged: string[]; warned: string[] }> {
  const { log, warn } = console;
  const logged: string[] = [];
  const warned: string[] = [];
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  console.warn = (...args: unknown[]) => warned.push(args.join(' '));
  try {
    return { value: await fn(), logged, warned };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

let keys = 0;
/** A key no other case uses, so the isolate-wide skills cache never mixes cases. */
const freshKey = (prefix = 'ob_k') =>
  `${prefix}${++keys}x${crypto.randomUUID().replaceAll('-', '')}`;

const renewal: FakeSkill = {
  name: 'renewal-check',
  version: 1,
  files: {
    'SKILL.md': skillMd('renewal-check', '# Renewal check\nRead the client overview first.'),
    'references/steps.md': '# Steps\nCheck the date.',
    'scripts/run.py': 'print("ok")',
  },
};

// Skills

test('skills: the catalog lists the skill, activates it and reads its files', async () => {
  const key = freshKey();
  const brain = fakeBrain({ skills: { [key]: [renewal] } });
  const source = onebrainSkills({ url: URL_, apiKey: key, workspace: 'acme', fetch: brain.fetch });
  const catalog = await loadSkillCatalog([source]);
  same(catalog.diagnostics, [], 'no diagnostics');
  check(
    catalog.prompt()?.includes('- renewal-check: Use when renewal-check comes up.'),
    'in the prompt',
  );
  const activated = catalog.activate('renewal-check');
  check(activated.ok, 'activates');
  check(activated.value.includes('Read the client overview first.'), 'the body');
  check(activated.value.includes('<file kind="reference" encoding="text"'), 'a reference listed');
  check(activated.value.includes('>scripts/run.py</file>'), 'a script listed');
  const read = await catalog.readResource({ path: 'renewal-check/references/steps.md' });
  check(read.ok, 'reads a file');
  same(
    {
      content: read.value.resource.content,
      kind: read.value.resource.kind,
      mime: read.value.resource.mimeType,
    },
    { content: '# Steps\nCheck the date.', kind: 'reference', mime: 'text/markdown' },
    'the file',
  );
  const missing = await catalog.readResource({ name: 'renewal-check', path: 'references/none.md' });
  check(!missing.ok && missing.error.name === 'SkillResourceNotFoundError', 'a missing file');
  const requests = brain.requests.map((one) => `${one.method} ${one.path}`);
  same(
    requests,
    ['GET /v1/workspaces/acme/skills', 'GET /v1/workspaces/acme/skills/renewal-check'],
    'one listing and one skill, the file from what was fetched',
  );
  check(
    brain.requests.every((one) => one.key === key),
    'signed in with the key',
  );
});

test('skills: a listing is reused, and a skill fetched again only at a new version', async () => {
  const key = freshKey();
  const skill = { ...renewal, files: { ...renewal.files } };
  const brain = fakeBrain({ skills: { [key]: [skill] } });
  const options = { url: URL_, apiKey: key, workspace: 'acme', fetch: brain.fetch };
  await onebrainSkills(options).list();
  await onebrainSkills(options).list(); // another source in the isolate, same key: the cache
  same(brain.requests.length, 2, 'listed once, fetched once');
  const always = onebrainSkills({ ...options, refreshIntervalMs: 0 });
  await always.list();
  same(brain.requests.length, 3, 'listed again, the skill not fetched again');
  skill.version = 2;
  skill.files['SKILL.md'] = skillMd('renewal-check', 'Version two.');
  const listed = await always.list();
  check(listed.ok, 'lists');
  same(listed.value.skills[0]?.skill.body.trim(), 'Version two.', 'the new version');
  same(brain.requests.length, 5, 'listed again and the new version fetched');
});

test('skills: listings are kept apart per key', async () => {
  const one = freshKey();
  const two = freshKey();
  const other: FakeSkill = {
    name: 'pricing',
    version: 1,
    files: { 'SKILL.md': skillMd('pricing') },
  };
  const brain = fakeBrain({ skills: { [one]: [renewal], [two]: [other] } });
  const names = async (key: string) => {
    const listed = await onebrainSkills({
      url: URL_,
      apiKey: key,
      workspace: 'acme',
      fetch: brain.fetch,
    }).list();
    check(listed.ok, 'lists');
    return listed.value.skills.map((skill) => skill.skill.name);
  };
  same(await names(one), ['renewal-check'], 'the first key');
  same(await names(two), ['pricing'], 'the second key');
  // A key given as a function, read per listing: a person's token.
  let token = one;
  const source = onebrainSkills({
    url: URL_,
    apiKey: () => token,
    workspace: 'acme',
    fetch: brain.fetch,
  });
  const first = await source.list();
  token = two;
  const second = await source.list();
  check(first.ok && second.ok, 'lists');
  same(
    [first.value.skills[0]?.skill.name, second.value.skills[0]?.skill.name],
    ['renewal-check', 'pricing'],
    'the token decides, not the cache',
  );
});

test('skills: a failed listing is an error, and the catalog keeps the last skills', async () => {
  const key = freshKey();
  let down = false;
  const brain = fakeBrain({
    skills: { [key]: [renewal] },
    listing: () => (down ? error(503, 'busy', 'Busy') : null),
  });
  const source = onebrainSkills({
    url: URL_,
    apiKey: key,
    workspace: 'acme',
    fetch: brain.fetch,
    refreshIntervalMs: 0,
  });
  const first = await loadSkillCatalog([source]);
  down = true;
  const listed = await source.list();
  check(!listed.ok && listed.error.name === 'SkillSourceError', 'a SkillSourceError');
  check(!listed.error.message.includes(key), 'no key in the error');
  const second = await loadSkillCatalog([source], { previous: first });
  same(
    second.skills.map((entry) => entry.skill.name),
    ['renewal-check'],
    'kept',
  );
  same(
    second.diagnostics.map((one) => one._tag),
    ['SourceFailed'],
    'reported',
  );
});

test('skills: a skill without SKILL.md or with broken frontmatter is listed as invalid; an allowlist limits', async () => {
  const key = freshKey();
  const brain = fakeBrain({
    skills: {
      [key]: [
        renewal,
        { name: 'no-skill-md', version: 1, files: { 'notes.md': 'x' } },
        {
          name: 'broken',
          version: 1,
          files: { 'SKILL.md': '---\nname: broken\n---\nNo description.' },
        },
      ],
    },
  });
  const options = { url: URL_, apiKey: key, workspace: 'acme', fetch: brain.fetch };
  const listed = await onebrainSkills(options).list();
  check(listed.ok, 'lists');
  same(
    listed.value.skills.map((one) => one.skill.name),
    ['renewal-check'],
    'the valid one',
  );
  same(
    listed.value.invalid.map((one) => [one.location, one.error.code]),
    [
      ['no-skill-md/SKILL.md', 'missing-frontmatter'],
      ['broken/SKILL.md', 'invalid-description'],
    ],
    'the invalid ones',
  );
  const only = await onebrainSkills({ ...options, skills: ['pricing'] }).list();
  check(only.ok, 'lists');
  same([only.value.skills.length, only.value.invalid.length], [0, 0], 'none allowed');
});

// Context

const hits = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'file',
    path: 'clients/acme/overview.md',
    title: 'Acme overview',
    snippet: `Renewal is in March. ${'More words. '.repeat(60)}`,
    status: 'accepted',
    source: null,
    score: 0.9,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'memory',
    path: null,
    snippet: 'Acme moved its renewal to April 14.',
    status: 'unreviewed',
    source: null,
    score: 0.8,
  },
];

test('context: search_context returns One Brain results marked as data, capped, with paths and ids', async () => {
  const key = freshKey();
  const brain = fakeBrain({ hits });
  const block = onebrainContext({
    url: URL_,
    apiKey: key,
    workspace: 'acme',
    fetch: brain.fetch,
    limit: 2,
  });
  const context = new ContextBlocks([block]);
  const prompt = await context.freezeSystemPrompt();
  check(prompt.includes('ONEBRAIN ('), 'a labelled block');
  check(prompt.includes('[searchable]'), 'searchable');
  check(prompt.includes('search_context (label "onebrain")'), 'how to search');
  check(prompt.includes("not on this agent's filesystem"), 'not a file on disk');
  same(brain.requests.length, 0, 'the prompt asks One Brain nothing');
  const tools = (await context.tools()) as unknown as Record<
    string,
    { execute: (input: unknown) => Promise<unknown> }
  >;
  check(tools.search_context && tools.set_context, 'both tools');
  const answer = String(
    await tools.search_context.execute({ label: 'onebrain', query: '  Acme renewal ' }),
  );
  const lines = answer.split('\n');
  same(lines[0], ONE_BRAIN_NOTICE, 'the notice first');
  check(
    lines[1]?.startsWith('One Brain search results for "Acme renewal" in workspace acme (2):'),
    'a header',
  );
  check(answer.includes('[1] file clients/acme/overview.md "Acme overview"'), 'the file path');
  check(
    answer.includes('[2] memory 22222222-2222-4222-8222-222222222222 (unreviewed)'),
    'the memory id',
  );
  const snippet = lines.find((line) => line.startsWith('Renewal is in March.')) ?? '';
  check(snippet.length <= 300 && snippet.endsWith('…'), 'the snippet cut to 300');
  same(brain.requests[0]?.body, { query: 'Acme renewal', limit: 2 }, 'the search sent');
});

test('context: set_context saves a One Brain memory in the folder', async () => {
  const key = freshKey('ob_agent');
  const brain = fakeBrain();
  const context = new ContextBlocks([
    onebrainContext({
      url: URL_,
      apiKey: key,
      workspace: 'acme',
      fetch: brain.fetch,
      folder: 'clients/acme',
    }),
  ]);
  const tools = (await context.tools()) as unknown as Record<
    string,
    { execute: (input: unknown) => Promise<unknown> }
  >;
  const saved = await tools.set_context?.execute({
    label: 'onebrain',
    content: 'Acme renews in April.',
    metadata: { title: 'Acme renewal' },
  });
  check(String(saved).startsWith('Indexed'), `saved: ${String(saved)}`);
  same(
    brain.memories,
    [{ text: 'Acme renews in April.', folder: 'clients/acme', visibility: null }],
    'remembered',
  );
  // Without a folder, a workspace agent key is refused: the model sees why, never the key.
  const bare = new ContextBlocks([
    onebrainContext({ url: URL_, apiKey: key, workspace: 'acme', fetch: brain.fetch }),
  ]);
  const refused = String(
    await (
      (await bare.tools()) as unknown as Record<
        string,
        { execute: (input: unknown) => Promise<unknown> }
      >
    ).set_context?.execute({
      label: 'onebrain',
      content: 'Another fact.',
    }),
  );
  check(refused.startsWith('Error:') && refused.includes('name a folder'), `refused: ${refused}`);
  check(!refused.includes(key), 'no key');
});

test('context: a failed or empty search tells the model so, without the key', async () => {
  const brain = fakeBrain({ hits: [] });
  const block = onebrainContext({
    url: URL_,
    apiKey: 'ob_bad',
    workspace: 'acme',
    fetch: brain.fetch,
  });
  const failed = await block.provider.search('anything');
  check(
    failed?.startsWith('One Brain search failed: Sign in first (unauthorized).'),
    `failed: ${failed}`,
  );
  check(!failed?.includes('ob_bad'), 'no key');
  const none = onebrainContext({
    url: URL_,
    apiKey: freshKey(),
    workspace: 'acme',
    fetch: brain.fetch,
  });
  same(await none.provider.search('nothing here'), null, 'no results: search_context says so');
  same(await none.provider.search('   '), null, 'an empty query asks nothing');
});

// MCP

function mcpAgent(stateIn: Map<string, unknown> = new Map()) {
  const calls: unknown[][] = [];
  const agent = {
    calls,
    storage: stateIn,
    ctx: {
      storage: {
        get: async (key: string) => stateIn.get(key),
        put: async (key: string, value: unknown) => void stateIn.set(key, value),
      },
    },
    async addMcpServer(name: string, url: string, options?: unknown) {
      calls.push(['add', name, url, options]);
      const transport = (options as { transport?: { headers?: unknown } }).transport;
      return transport?.headers
        ? { id: name, state: 'ready' }
        : { id: name, state: 'authenticating', authUrl: 'https://auth.test/authorize?x=1' };
    },
    async removeMcpServer(id: string) {
      calls.push(['remove', id]);
    },
  };
  return agent;
}

test("addOneBrain: adds One Brain's MCP server with the key as a Bearer token, again when the key changes", async () => {
  const agent = mcpAgent();
  const env = { ONEBRAIN_URL: 'https://brain.test/', ONEBRAIN_API_KEY: 'ob_one' };
  same(await addOneBrain(agent, { env }), { id: 'onebrain', state: 'ready' }, 'ready');
  same(
    agent.calls[0],
    [
      'add',
      'onebrain',
      'https://brain.test/mcp',
      {
        id: 'onebrain',
        transport: { type: 'streamable-http', headers: { Authorization: 'Bearer ob_one' } },
      },
    ],
    'the server and its header',
  );
  await addOneBrain(agent, { env });
  same(
    agent.calls.map((call) => call[0]),
    ['add', 'add'],
    'the same key: added as is (the SDK returns the existing one)',
  );
  await addOneBrain(agent, { env: { ...env, ONEBRAIN_API_KEY: 'ob_two' } });
  same(
    agent.calls.slice(2).map((call) => call[0]),
    ['remove', 'add'],
    'a new key: removed, then added',
  );
  check(
    ![...agent.storage.values()].some((value) => String(value).includes('ob_')),
    'only a hash stored',
  );
});

test('addOneBrain: OAuth stores no key and gives the link; no key fails without throwing', async () => {
  const agent = mcpAgent();
  const oauth = await addOneBrain(agent, {
    url: 'https://brain.test',
    oauth: true,
    callbackHost: 'https://agent.test',
  });
  same(
    oauth,
    { id: 'onebrain', state: 'authenticating', authUrl: 'https://auth.test/authorize?x=1' },
    'a link',
  );
  same(
    agent.calls[0]?.[3],
    { id: 'onebrain', callbackHost: 'https://agent.test', transport: { type: 'streamable-http' } },
    'no header',
  );
  const none = await addOneBrain(mcpAgent(), { env: {} });
  same(none.state, 'failed', 'failed');
  const throwing = {
    ...mcpAgent(),
    addMcpServer: async () => Promise.reject(new Error('HTTP 401')),
  };
  const { value, warned } = await quiet(() =>
    addOneBrain(throwing, { apiKey: 'ob_secret', url: URL_ }),
  );
  same(value, { id: 'onebrain', state: 'failed', error: 'HTTP 401' }, 'failed, not thrown');
  check(warned.length === 1 && !warned[0]?.includes('ob_secret'), 'one warning, no key');
});

test("withOneBrainApprovals: One Brain's write and forget wait for approval, nothing else", async () => {
  const tool = { description: 'x', execute: async () => 'ok' };
  const tools = withOneBrainApprovals({
    tool_onebrain_search: tool,
    tool_onebrain_write: tool,
    tool_onebrain_forget: tool,
    tool_github_write: tool,
  });
  same(
    Object.entries(tools).map(([name, one]) => [name, 'needsApproval' in one]),
    [
      ['tool_onebrain_search', false],
      ['tool_onebrain_write', true],
      ['tool_onebrain_forget', true],
      ['tool_github_write', false],
    ],
    'gated',
  );
});

// Capture

type Part = { type: string; [key: string]: unknown };
type UIMessage = { id: string; role: 'user' | 'assistant' | 'system'; parts: Part[] };
const text = (value: string): Part => ({ type: 'text', text: value });
const say = (id: string, role: UIMessage['role'], ...parts: (Part | string)[]): UIMessage => ({
  id,
  role,
  parts: parts.map((part) => (typeof part === 'string' ? text(part) : part)),
});

function chatAgent(name = 'chat-1') {
  const storage = new Map<string, unknown>();
  return {
    name,
    messages: [] as UIMessage[],
    storage,
    ctx: {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => void storage.set(key, value),
      },
    },
  };
}
const done = { status: 'completed' };

test('capture: each finished turn is sent once, with only its own messages and ref <name>#turn-<n>', async () => {
  resetCaptureState();
  const brain = fakeBrain();
  const agent = chatAgent();
  const options = { url: URL_, apiKey: freshKey(), workspace: 'acme', fetch: brain.fetch };
  agent.messages.push(
    say('m0', 'user', 'Old question from before capture'),
    say('m1', 'assistant', 'Old answer'),
  );
  agent.messages.push(
    say('u1', 'user', 'When does Acme renew?'),
    say('a1', 'assistant', { type: 'step-start' }, 'In April.'),
  );
  const { logged } = await quiet(() => captureTurn(agent, done, options));
  same(
    brain.posted.map((one) => [one.ref, one.folder, one.visibility, one.text]),
    [
      [
        'cloudflare:chat-1#turn-1',
        null,
        null,
        'user: When does Acme renew?\nassistant: In April.\n',
      ],
    ],
    'the first turn, without the history before it',
  );
  check(
    logged.length === 1 && logged[0]?.includes('capture: false'),
    'one line says capture is on',
  );
  check(!logged[0]?.includes('Acme'), 'no content logged');

  await quiet(() => captureTurn(agent, done, options));
  same(brain.posted.length, 1, 'nothing new: nothing sent');

  agent.messages.push(say('u2', 'user', 'And Globex?'), say('a2', 'assistant', 'In May.'));
  const second = await quiet(() => captureTurn(agent, done, options));
  same(
    brain.posted.map((one) => [one.ref, one.text]).at(-1),
    ['cloudflare:chat-1#turn-2', 'user: And Globex?\nassistant: In May.\n'],
    'the second turn only',
  );
  same(second.logged, [], 'said once per process');
});

test('capture: a turn that continues after an approval sends the answered call and what follows', async () => {
  resetCaptureState();
  const brain = fakeBrain();
  const agent = chatAgent();
  const options = {
    url: URL_,
    apiKey: freshKey(),
    workspace: 'acme',
    fetch: brain.fetch,
    folder: 'agents/chat',
  };
  const call: Part = {
    type: 'tool-tool_onebrain_write',
    toolCallId: 'c1',
    state: 'approval-requested',
    input: { path: 'a.md' },
  };
  agent.messages.push(
    say('u1', 'user', 'Fix a.md'),
    say('a1', 'assistant', 'I will write it.', call),
  );
  await quiet(() => captureTurn(agent, done, options));
  const answered = { ...call, state: 'output-available', output: { written: true } };
  agent.messages[1] = say('a1', 'assistant', 'I will write it.', answered, 'Done.');
  await quiet(() => captureTurn(agent, done, options));
  same(
    brain.posted.map((one) => [one.ref, one.folder, one.text]),
    [
      [
        'cloudflare:chat-1#turn-1',
        'agents/chat',
        'user: Fix a.md\nassistant: I will write it.\nassistant: [tool tool_onebrain_write] {"path":"a.md"}\n',
      ],
      [
        'cloudflare:chat-1#turn-2',
        'agents/chat',
        'assistant: [tool tool_onebrain_write] {"path":"a.md"}\ntool: {"written":true}\nassistant: Done.\n',
      ],
    ],
    'the call again with its answer',
  );
});

test("capture: tool calls and results are written as such; a skill's text and reasoning are left out; files are noted", async () => {
  resetCaptureState();
  const brain = fakeBrain();
  const agent = chatAgent('assistant');
  agent.messages.push(
    say('u1', 'user', 'Check renewals', {
      type: 'file',
      mediaType: 'image/png',
      filename: 'shot.png',
      url: 'data:secret',
    }),
    say(
      'a1',
      'assistant',
      { type: 'reasoning', text: 'thinking hard' },
      {
        type: 'tool-activate_skill',
        state: 'output-available',
        input: { name: 'renewal-check' },
        output: 'SKILL BODY',
      },
      {
        type: 'tool-search_context',
        state: 'output-available',
        input: { label: 'onebrain', query: 'acme' },
        output: `${ONE_BRAIN_NOTICE}\nhit`,
      },
      {
        type: 'dynamic-tool',
        toolName: 'weather',
        state: 'output-error',
        input: {},
        errorText: 'down',
      },
      { type: 'data-progress', data: { secret: 'x' } },
      'Renewals are in April.',
    ),
  );
  await quiet(() =>
    captureTurn(agent, done, {
      url: URL_,
      apiKey: freshKey(),
      workspace: 'acme',
      fetch: brain.fetch,
    }),
  );
  same(
    brain.posted[0]?.text,
    [
      'user: Check renewals\n[file shot.png]',
      'assistant: [tool activate_skill] {"name":"renewal-check"}',
      'tool: [skill content left out]',
      'assistant: [tool search_context] {"label":"onebrain","query":"acme"}',
      `tool: ${ONE_BRAIN_NOTICE}\nhit`,
      'assistant: [tool weather] {}',
      'tool: Error: down',
      'assistant: [data-progress]\nRenewals are in April.',
      '',
    ].join('\n'),
    'the transcript',
  );
});

test('capture: capture: false, an error or an abort sends nothing; the next finished turn carries them', async () => {
  resetCaptureState();
  const brain = fakeBrain();
  const agent = chatAgent();
  const options = { url: URL_, apiKey: freshKey(), workspace: 'acme', fetch: brain.fetch };
  agent.messages.push(say('u1', 'user', 'One'), say('a1', 'assistant', 'First.'));
  await captureTurn(agent, done, { ...options, capture: false });
  await captureTurn(agent, { status: 'error' }, options);
  await captureTurn(agent, { status: 'aborted' }, options);
  same(brain.requests.length, 0, 'nothing sent');
  agent.messages.push(say('u2', 'user', 'Two'), say('a2', 'assistant', 'Second.'));
  await quiet(() => captureTurn(agent, done, options));
  same(
    brain.posted.map((one) => one.text),
    ['user: Two\nassistant: Second.\n'],
    'only the turn after: the one while off is passed over',
  );
});

test('capture: turns finished while capture was off are never sent, also once it is on again', async () => {
  resetCaptureState();
  const brain = fakeBrain();
  const agent = chatAgent();
  const options = { url: URL_, apiKey: freshKey(), workspace: 'acme', fetch: brain.fetch };
  agent.messages.push(say('u1', 'user', 'One'), say('a1', 'assistant', 'First.'));
  await quiet(() => captureTurn(agent, done, options));
  agent.messages.push(say('u2', 'user', 'Off the record'), say('a2', 'assistant', 'Noted.'));
  await captureTurn(agent, done, { ...options, capture: false });
  agent.messages.push(say('u3', 'user', 'Three'), say('a3', 'assistant', 'Third.'));
  await quiet(() => captureTurn(agent, done, options));
  same(
    brain.posted.map((one) => [one.ref, one.text]),
    [
      ['cloudflare:chat-1#turn-1', 'user: One\nassistant: First.\n'],
      ['cloudflare:chat-1#turn-2', 'user: Three\nassistant: Third.\n'],
    ],
    'the turn while off is skipped, not carried',
  );
});

test('capture: a refusal warns once with what to do, turns capture off and never throws', async () => {
  resetCaptureState();
  const brain = fakeBrain({
    sources: () =>
      error(
        400,
        'invalid_request',
        'A workspace agent has no private sources: name a folder or set a capture folder',
      ),
  });
  const agent = chatAgent();
  const key = freshKey('ob_agent');
  const options = { url: URL_, apiKey: key, workspace: 'acme', fetch: brain.fetch };
  agent.messages.push(say('u1', 'user', 'Secret plan'), say('a1', 'assistant', 'Noted.'));
  const first = await quiet(() => captureTurn(agent, done, options));
  same(first.warned.length, 1, 'one warning');
  check(
    first.warned[0]?.includes('capture folder') && first.warned[0]?.includes('capture: false'),
    'what to do',
  );
  check(
    !first.warned[0]?.includes(key) && !first.warned[0]?.includes('Secret plan'),
    'no key, no content',
  );
  agent.messages.push(say('u2', 'user', 'More'), say('a2', 'assistant', 'Ok.'));
  const second = await quiet(() => captureTurn(agent, done, options));
  same(second.warned, [], 'silent after that');
  same(
    brain.requests.filter((one) => one.path.endsWith('/sources')).length,
    1,
    'no more uploads in this process',
  );
  resetCaptureState();
});

test('capture: an outage keeps the messages for the next finished turn', async () => {
  resetCaptureState();
  let down = true;
  const brain = fakeBrain({ sources: () => (down ? error(503, 'busy', 'Busy') : null) });
  const agent = chatAgent();
  const options = { url: URL_, apiKey: freshKey(), workspace: 'acme', fetch: brain.fetch };
  agent.messages.push(say('u1', 'user', 'One'), say('a1', 'assistant', 'First.'));
  const failed = await quiet(() => captureTurn(agent, done, options));
  same(failed.warned.length, 1, 'said once');
  down = false;
  agent.messages.push(say('u2', 'user', 'Two'), say('a2', 'assistant', 'Second.'));
  await quiet(() => captureTurn(agent, done, options));
  same(
    brain.posted.map((one) => [one.ref, one.text]),
    [['cloudflare:chat-1#turn-1', 'user: One\nassistant: First.\nuser: Two\nassistant: Second.\n']],
    'both turns, as turn 1',
  );
});

test('capture: turns captured at once go one after another, each once', async () => {
  resetCaptureState();
  const brain = fakeBrain();
  const agent = chatAgent();
  const options = { url: URL_, apiKey: freshKey(), workspace: 'acme', fetch: brain.fetch };
  agent.messages.push(say('u1', 'user', 'One'), say('a1', 'assistant', 'First.'));
  await quiet(() =>
    Promise.all([captureTurn(agent, done, options), captureTurn(agent, done, options)]),
  );
  same(
    brain.posted.map((one) => one.ref),
    ['cloudflare:chat-1#turn-1'],
    'once',
  );
});

test('capture: an agent without Durable Object storage sends nothing and says so once', async () => {
  resetCaptureState();
  const brain = fakeBrain();
  const options = { url: URL_, apiKey: freshKey(), workspace: 'acme', fetch: brain.fetch };
  const agent = {
    name: 'bare',
    messages: [say('u1', 'user', 'Hi'), say('a1', 'assistant', 'Hello.')],
  };
  const first = await quiet(() => captureTurn(agent, done, options));
  const second = await quiet(() => captureTurn(agent, done, options));
  same(brain.requests.length, 0, 'no request');
  check(
    first.warned.length === 1 && first.warned[0]?.includes('(this)'),
    'one warning: pass the agent',
  );
  same(second.warned, [], 'said once');
});

/** Every case, in order: [name, null] when it passed, else [name, message]. */
export async function runAll(only?: string): Promise<[string, string | null][]> {
  const results: [string, string | null][] = [];
  for (const one of cases) {
    if (only && one.name !== only) continue;
    try {
      await one.run();
      results.push([one.name, null]);
    } catch (failure) {
      results.push([
        one.name,
        failure instanceof Error ? (failure.stack ?? failure.message) : String(failure),
      ]);
    }
  }
  return results;
}

// Unused here; keeps the import of SkillSource checked against the package's return type.
export const typed: (source: ReturnType<typeof onebrainSkills>) => SkillSource = (source) => source;
