import { describe, expect, it } from 'vitest';
import { createOneBrain, type Message, OneBrainError, toTranscript } from '../src/index.ts';
import { lineEnds, splitSession } from '../src/upload.ts';
import { type Answer, fakeFetch, type Sent } from './fake-fetch.ts';

const URL_ = 'https://brain.test';
const SOURCES = `POST ${URL_}/v1/workspaces/acme/sources`;
const encoder = new TextEncoder();

type Posted = { text: string; bytes: number; ref: string | null; name: string; form: FormData };

/**
 * POST sources as the server answers it, with a small cap: 413 source_too_large with maxBytes over
 * `maxBytes`, 400 for blank content, and a duplicate (200) for content it stored before. `answer`
 * can step in first, for a 429.
 */
function server(maxBytes: number, answer?: (posted: Posted) => Answer | null) {
  const posted: Posted[] = [];
  const stored = new Map<string, string>();
  const route = async (sent: Sent): Promise<Answer> => {
    const form = sent.form as FormData;
    const file = form.get('content') as File;
    const text = await file.text();
    const one = {
      text,
      bytes: encoder.encode(text).length,
      ref: form.get('externalRef') as string | null,
      name: file.name,
      form,
    };
    posted.push(one);
    const early = answer?.(one);
    if (early) return early;
    if (one.bytes > maxBytes) {
      return {
        status: 413,
        body: {
          error: { code: 'source_too_large', message: 'Too large', sizeBytes: one.bytes, maxBytes },
        },
      };
    }
    if (text.trim() === '')
      return { status: 400, body: { error: { code: 'invalid_request', message: 'empty' } } };
    const duplicate = stored.has(text);
    if (!duplicate) stored.set(text, `s${stored.size + 1}`);
    const id = stored.get(text);
    return {
      status: duplicate ? 200 : 201,
      body: {
        id,
        kind: 'session',
        folder: null,
        visibility: 'workspace',
        contentHash: `h-${id}`,
        duplicate,
        createdAt: 'x',
      },
    };
  };
  const fake = fakeFetch({ [SOURCES]: route });
  const brain = createOneBrain({ url: URL_, apiKey: 'ob_k', workspace: 'acme', fetch: fake.fetch });
  return { brain, posted, sent: fake.sent };
}

const conversation = (turns: number): Message[] =>
  Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i} says café\nand a second line\nuser: quoted in turn ${i}`,
  }));

describe('capture', () => {
  it('stores the conversation as one session source with its ref, folder and time', async () => {
    const { brain, posted } = server(10_000);
    const messages: Message[] = [
      { role: 'user', content: 'When does Acme renew?' },
      { role: 'assistant', content: 'In April.' },
    ];
    const sources = await brain.capture({
      messages,
      ref: 'sess-1#turn-1',
      client: 'eve',
      folder: 'sessions',
      occurredAt: new Date('2026-11-20T10:00:00Z'),
    });
    expect(sources).toMatchObject([{ id: 's1', duplicate: false }]);
    expect(posted).toHaveLength(1);
    const form = posted[0]?.form as FormData;
    expect(form.get('kind')).toBe('session');
    expect(form.get('folder')).toBe('sessions');
    expect(form.get('visibility')).toBeNull();
    expect(form.get('externalRef')).toBe('eve:sess-1#turn-1');
    expect(form.get('occurredAt')).toBe('2026-11-20T10:00:00.000Z');
    expect(posted[0]?.text).toBe(toTranscript(messages));
  });

  it('leaves the place to the server without folder and private, sends private as visibility, and refuses both', async () => {
    const { brain, posted, sent } = server(10_000);
    await brain.capture({ messages: [{ role: 'user', content: 'a' }] });
    expect(posted[0]?.form.get('folder')).toBeNull();
    expect(posted[0]?.form.get('visibility')).toBeNull();
    expect(posted[0]?.form.get('externalRef')).toBeNull();
    expect(typeof posted[0]?.form.get('occurredAt')).toBe('string');
    await brain.capture({ messages: [{ role: 'user', content: 'b' }], private: true, ref: 'r' });
    expect(posted[1]?.form.get('visibility')).toBe('private');
    expect(posted[1]?.form.get('externalRef')).toBe('r');
    await expect(
      brain.capture({ messages: [{ role: 'user', content: 'c' }], private: true, folder: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      brain.capture({ messages: [{ role: 'system', content: 'only this' }] }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(sent).toHaveLength(2);
  });

  it('takes a duplicate as a success', async () => {
    const { brain } = server(10_000);
    const messages: Message[] = [{ role: 'user', content: 'same' }];
    await brain.capture({ messages });
    await expect(brain.capture({ messages })).resolves.toMatchObject([
      { id: 's1', duplicate: true },
    ]);
  });

  it('throws what the server refused the whole capture with', async () => {
    const fake = fakeFetch({
      [SOURCES]: () => ({
        status: 403,
        body: { error: { code: 'forbidden', message: 'No private sources for a workspace agent' } },
      }),
    });
    const brain = createOneBrain({
      url: URL_,
      apiKey: 'ob_k',
      workspace: 'acme',
      fetch: fake.fetch,
    });
    const error = await brain
      .capture({ messages: [{ role: 'user', content: 'secret words' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OneBrainError);
    expect(error).toMatchObject({ code: 'forbidden', status: 403 });
    expect((error as Error).message).not.toContain('secret words');
  });

  it('splits a conversation over the cap between messages, never inside one, with refs <ref>#part-<n>', async () => {
    const messages = conversation(12);
    const transcript = toTranscript(messages);
    const { brain, posted } = server(300);
    const sources = await brain.capture({
      messages,
      ref: 'sess-2',
      client: 'ai-sdk',
      folder: 'sessions',
    });
    const [whole, ...parts] = posted;
    expect(whole?.text).toBe(transcript);
    expect(whole?.ref).toBe('ai-sdk:sess-2');
    expect(parts.length).toBeGreaterThan(2);
    expect(sources.map((one) => one.id)).toEqual(parts.map((_, i) => `s${i + 1}`));
    expect(parts.map((part) => part.text).join('')).toBe(transcript);
    const perMessage = messages.map((message) => toTranscript([message]));
    for (const [index, part] of parts.entries()) {
      expect(part.bytes).toBeLessThanOrEqual(300);
      expect(part.ref).toBe(`ai-sdk:sess-2#part-${index + 1}`);
      expect(part.name).toBe(`session part ${index + 1} of ${parts.length}.txt`);
      expect(part.form.get('folder')).toBe('sessions');
      expect(part.form.get('occurredAt')).toBe(whole?.form.get('occurredAt'));
      // Each part is whole messages, in order.
      let rest = part.text;
      while (rest !== '') {
        const next = perMessage.find((one) => rest.startsWith(one));
        expect(next, `part ${index + 1} cuts a message`).toBeDefined();
        rest = rest.slice((next as string).length);
      }
    }
  });

  it('sends the rest when one part is refused, then throws that refusal', async () => {
    const long = { role: 'tool' as const, content: 'zebra '.repeat(80) };
    const messages = [...conversation(2), long, ...conversation(2)];
    const { brain, posted } = server(300);
    const error = await brain.capture({ messages, ref: 'r' }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'source_too_large',
      status: 413,
      details: { maxBytes: 300 },
    });
    expect((error as Error).message).not.toContain('zebra');
    expect(posted.slice(1).map((part) => part.ref)).toEqual(['r#part-1', 'r#part-2', 'r#part-3']);
  });

  it('waits for Retry-After once on a 429, and throws the second', async () => {
    let limited = 0;
    const tooMany = (seconds: string): Answer => ({
      status: 429,
      body: { error: { code: 'too_many_requests', message: 'Slow down' } },
      headers: { 'Retry-After': seconds },
    });
    // The second part's first try is limited, its second is not; the third part's is.
    const { brain, posted } = server(300, (one) =>
      /#part-[23]$/.test(one.ref ?? '') && limited++ !== 1 ? tooMany('0') : null,
    );
    const error = await brain
      .capture({ messages: conversation(12), ref: 'r' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'too_many_requests', status: 429, retryAfter: 0 });
    expect(posted.slice(1).map((part) => part.ref)).toEqual([
      'r#part-1',
      'r#part-2',
      'r#part-2',
      'r#part-3',
    ]);
  });
});

describe('splitSession', () => {
  const bytes = (text: string) => encoder.encode(text);
  const decode = (parts: Uint8Array[]) => parts.map((part) => new TextDecoder().decode(part));

  it('cuts after line ends by default, packing whole lines up to the cap, the last line with or without its end', () => {
    expect(decode(splitSession(bytes('aa\nbb\ncc\ndd'), 6))).toEqual(['aa\nbb\n', 'cc\ndd']);
    expect(lineEnds(bytes('aa\nbb\n'))).toEqual([3, 6]);
    expect(splitSession(bytes(''), 10)).toEqual([]);
  });

  it('cuts only at the ends it is given, and gives a unit over the cap a part of its own', () => {
    const text = 'user: a\nb\nassistant: c\nuser: dddddddddd\n';
    const ends = [10, 23, text.length];
    expect(decode(splitSession(bytes(text), 14, ends))).toEqual([
      'user: a\nb\n',
      'assistant: c\n',
      'user: dddddddddd\n',
    ]);
    expect(decode(splitSession(bytes(text), 23, ends))).toEqual([
      'user: a\nb\nassistant: c\n',
      'user: dddddddddd\n',
    ]);
    expect(decode(splitSession(bytes(text), 1000, ends))).toEqual([text]);
  });
});
