import { ONE_BRAIN_NOTICE } from '@useonebrain/sdk';
import { generateText, isStepCount } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCaptureState } from '../src/capture.ts';
import { captureSession, loadOneBrainSkills, onebrainTools } from '../src/index.ts';
import { answer, callTools, fakeBrain, hit, mockModel } from './support.ts';

beforeEach(() => {
  resetCaptureState();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const run = <T>(tool: { execute?: unknown }, input: T) =>
  (tool.execute as (input: T, options: unknown) => Promise<unknown>)(input, {
    toolCallId: 'c1',
    messages: [],
  });

const FILE = {
  id: crypto.randomUUID(),
  path: 'clients/acme/overview.md',
  version: 3,
  body: '# Acme',
  author: { id: 'u', displayName: 'A' },
  updatedAt: '2026-11-20T00:00:00Z',
};

describe('onebrainTools', () => {
  it('has the six MCP tools, with their input bounds, and write and forget need approval', () => {
    const tools = onebrainTools();
    expect(Object.keys(tools)).toEqual(['search', 'read', 'list', 'remember', 'write', 'forget']);
    expect(tools.write.needsApproval).toBe(true);
    expect(tools.forget.needsApproval).toBe(true);
    expect(tools.search.needsApproval).toBeUndefined();
    expect(onebrainTools({ needsApproval: false }).write.needsApproval).toBe(false);
    const search = tools.search.inputSchema as unknown as {
      safeParse(v: unknown): { success: boolean };
    };
    expect(search.safeParse({ query: 'x', limit: 50 }).success).toBe(true);
    expect(search.safeParse({ query: ' ', limit: 5 }).success).toBe(false);
    expect(search.safeParse({ query: 'x', limit: 51 }).success).toBe(false);
  });

  it('answers { workspace, notice, data } from the API', async () => {
    const memory = {
      id: crypto.randomUUID(),
      text: 'Acme renews in April.',
      folder: 'clients/acme',
    };
    const brain = fakeBrain({
      'POST /search': () => ({ body: { workspace: 'acme', vector: false, data: [hit({})] } }),
      'GET /files': () => ({ body: FILE }),
      'POST /memories': () => ({ status: 201, body: memory }),
      'GET /tree': () => ({
        body: { node: { path: 'clients' }, children: [{ kind: 'folder', path: 'clients/acme' }] },
      }),
    });
    const tools = onebrainTools(brain.options);
    expect(await run(tools.search, { query: 'Acme' })).toEqual({
      workspace: 'acme',
      notice: ONE_BRAIN_NOTICE,
      vector: false,
      data: [expect.objectContaining({ path: 'clients/acme/overview.md' })],
    });
    expect(await run(tools.read, { path: 'clients/acme/overview.md' })).toEqual({
      workspace: 'acme',
      notice: ONE_BRAIN_NOTICE,
      data: [FILE],
    });
    expect(await run(tools.remember, { text: memory.text, folder: 'clients/acme' })).toEqual({
      workspace: 'acme',
      notice: ONE_BRAIN_NOTICE,
      data: [memory],
    });
    expect(await run(tools.list, { path: 'clients' })).toEqual({
      workspace: 'acme',
      notice: ONE_BRAIN_NOTICE,
      folder: 'clients',
      data: [{ kind: 'folder', path: 'clients/acme' }],
    });
    expect(brain.sent.find((one) => one.path === '/memories')?.body).toEqual({
      text: memory.text,
      folder: 'clients/acme',
    });
  });

  it("answers the API's refusal as the MCP tools do, so the model can act on it", async () => {
    const brain = fakeBrain({
      'GET /files': () => ({ body: FILE }),
      'PUT /files': () => ({
        status: 409,
        body: { error: { code: 'conflict', message: 'The file changed', currentVersion: 4 } },
      }),
    });
    const tools = onebrainTools(brain.options);
    expect(await run(tools.write, { path: FILE.path, body: '# Acme 2' })).toEqual({
      error: { code: 'conflict', message: 'The file changed', currentVersion: 4 },
    });
    expect(await run(tools.read, {})).toEqual({
      error: { code: 'invalid_request', message: 'Pass either path or id' },
    });
  });

  it('turns a write in a review folder into the improvement and says it waits for a person', async () => {
    const improvementId = crypto.randomUUID();
    const brain = fakeBrain({
      'GET /files': () => ({ body: FILE }),
      'PUT /files': () => ({
        status: 202,
        body: { improvement: { id: improvementId, path: FILE.path, status: 'pending' } },
      }),
    });
    const out = (await run(onebrainTools(brain.options).write, {
      path: FILE.path,
      body: '# Acme 2',
    })) as { data: Record<string, unknown>[] };
    expect(out.data[0]).toMatchObject({ kind: 'improvement', id: improvementId });
    expect(out.data[0]?.message).toContain(`accepts improvement ${improvementId}`);
    expect(brain.sent.find((one) => one.method === 'PUT')?.body).toMatchObject({ baseVersion: 3 });
  });

  it('asks for approval before write runs in generateText, and runs it once approved', async () => {
    const brain = fakeBrain({
      'GET /files': () => ({ body: FILE }),
      'PUT /files': () => ({ body: { ...FILE, version: 4 } }),
    });
    const tools = onebrainTools(brain.options);
    const first = await generateText({
      model: mockModel({
        generate: [callTools({ toolName: 'write', input: { path: FILE.path, body: '# New' } })],
      }),
      tools,
      prompt: 'Rewrite the overview',
      stopWhen: isStepCount(3),
    });
    const request = first.content.find((part) => part.type === 'tool-approval-request');
    expect(request).toBeDefined();
    expect(brain.sent.filter((one) => one.method === 'PUT')).toEqual([]);

    const approved = await generateText({
      model: mockModel({ generate: [answer('Rewritten.')] }),
      tools,
      messages: [
        { role: 'user', content: 'Rewrite the overview' },
        ...first.responseMessages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: (request as { approvalId: string }).approvalId,
              approved: true,
            },
          ],
        },
      ],
      stopWhen: isStepCount(3),
    });
    expect(approved.text).toBe('Rewritten.');
    expect(brain.sent.filter((one) => one.method === 'PUT')).toHaveLength(1);
  });

  it('reads no key when made, so a build without secrets works', () => {
    vi.stubEnv('ONEBRAIN_API_KEY', '');
    expect(() => onebrainTools()).not.toThrow();
    vi.unstubAllEnvs();
  });
});

describe('loadOneBrainSkills', () => {
  it('gives each skill as HarnessAgent takes it: SKILL.md without its frontmatter, and the other files', async () => {
    const brain = fakeBrain({
      'GET /skills': () => ({
        body: { data: [{ name: 'renewal-check', path: 'skills/renewal-check' }] },
      }),
      'GET /skills/renewal-check': () => ({
        body: {
          name: 'renewal-check',
          path: 'skills/renewal-check',
          description: "Use when a client's renewal comes up.",
          files: [
            {
              path: 'SKILL.md',
              body: '---\nname: renewal-check\ndescription: Use when.\n---\n\n# Renewal check\nRead references/steps.md.\n',
            },
            { path: 'references/steps.md', body: '# Steps' },
          ],
        },
      }),
    });
    expect(await loadOneBrainSkills(brain.options)).toEqual([
      {
        name: 'renewal-check',
        description: "Use when a client's renewal comes up.",
        content: '# Renewal check\nRead references/steps.md.\n',
        files: [{ path: 'references/steps.md', content: '# Steps' }],
      },
    ]);
  });
});

describe('captureSession', () => {
  it("stores the turn's messages with the ref, tool calls in short, and nothing of a file but its name", async () => {
    const brain = fakeBrain();
    const sources = await captureSession({
      ...brain.options,
      sessionId: 'c-9',
      turn: 3,
      folder: 'agents/sessions',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this' },
            { type: 'file', mediaType: 'application/pdf', filename: 'deal.pdf', data: 'JVBERi0x' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'tool-call', toolCallId: 't', toolName: 'search', input: { query: 'deal' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't',
              toolName: 'search',
              output: { type: 'text', value: 'nothing' },
            },
          ],
        },
        { role: 'assistant', content: 'Nothing on it yet.' },
      ],
    });
    expect(sources).toHaveLength(1);
    expect(await brain.stored()).toEqual([
      {
        ref: 'ai-sdk:c-9#turn-3',
        text: 'user: Read this\n[file deal.pdf]\nassistant: [tool search] {"query":"deal"}\ntool: nothing\nassistant: Nothing on it yet.\n',
      },
    ]);
    expect(brain.captures()[0]?.form?.get('folder')).toBe('agents/sessions');
  });

  it('resolves with [] instead of throwing when the key is missing', async () => {
    vi.stubEnv('ONEBRAIN_API_KEY', '');
    const sources = await captureSession({
      url: 'https://brain.test',
      workspace: 'acme',
      sessionId: 's',
      turn: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    vi.unstubAllEnvs();
    expect(sources).toEqual([]);
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('ONEBRAIN_API_KEY');
  });
});
