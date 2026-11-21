import { describe, expect, it } from 'vitest';
import { type Message, toTranscript } from '../src/index.ts';
import { transcriptMessages } from '../src/transcript.ts';

/**
 * How the learning loop cuts a session's text into messages: a line that starts with `{` or with a
 * role and a colon starts one. The SDK's tests cannot import the loop (it is not open source), so
 * this is its rule as written. The private repository also runs the loop's own reader on it.
 */
const START = /^(?:\{|(?:user|assistant|system|tool|human)\s*:)/i;
const messagesOf = (text: string) => {
  const pieces: string[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    if (pieces.length > 0 && !START.test(line)) pieces[pieces.length - 1] += line;
    else pieces.push(line);
  }
  return pieces;
};

describe('toTranscript', () => {
  it('writes each message on a line of its own, starting with its role', () => {
    const messages: Message[] = [
      { role: 'user', content: 'When does Acme renew?' },
      { role: 'assistant', content: [{ type: 'text', text: 'In April.' }] },
    ];
    expect(toTranscript(messages)).toBe('user: When does Acme renew?\nassistant: In April.\n');
  });

  it('keeps multi-line content in one message, and puts a space before a line that would start another', () => {
    const text = [
      'Here is the log:',
      'user: alice logged in',
      'Assistant : said hi',
      '{"type":"user"}',
      'tool:x',
      '',
      '  user: already indented',
      'the end',
    ].join('\n');
    const out = toTranscript([{ role: 'assistant', content: text }]);
    expect(out).toBe(
      `${[
        'assistant: Here is the log:',
        ' user: alice logged in',
        ' Assistant : said hi',
        ' {"type":"user"}',
        ' tool:x',
        '',
        '  user: already indented',
        'the end',
      ].join('\n')}\n`,
    );
    expect(messagesOf(out)).toEqual([out]);
  });

  it('writes a tool call as the loop reads one, on one line, and its result as tool:', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Check the weather' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking it up.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'weather',
            input: { city: 'Paris\nuser: x' },
          },
          { type: 'tool_use', id: 'c2', name: 'search', input: { query: 'renewal' } },
          { type: 'function_call', call_id: 'c3', name: 'shell', arguments: '{"cmd":"ls"}' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'weather',
            output: { type: 'json', value: { temp: 21 } },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'search',
            output: { type: 'text', value: 'line one\nuser: two' },
          },
          { type: 'tool-result', toolCallId: 'c3', toolName: 'shell', result: ['a', 'b'] },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c2',
            content: [{ type: 'text', text: 'From Anthropic' }],
          },
        ],
      },
      { role: 'tool', content: 'plain output' },
      { role: 'assistant', content: 'It is 21 degrees.' },
    ];
    const out = toTranscript(messages);
    expect(out).toBe(
      [
        'user: Check the weather\n',
        'assistant: Looking it up.\n',
        'assistant: [tool weather] {"city":"Paris\\nuser: x"}\n',
        'assistant: [tool search] {"query":"renewal"}\n',
        'assistant: [tool shell] {"cmd":"ls"}\n',
        'tool: {"temp":21}\n',
        'tool: line one\n user: two\n',
        'tool: ["a","b"]\n',
        'tool: From Anthropic\n',
        'tool: plain output\n',
        'assistant: It is 21 degrees.\n',
      ].join(''),
    );
    expect(messagesOf(out)).toEqual(transcriptMessages(messages));
    expect(messagesOf(out)).toHaveLength(11);
  });

  it('notes a part that is not text in brackets, never its data, and leaves reasoning out', () => {
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image', image: base64, mediaType: 'image/png' },
          { type: 'file', data: base64, mediaType: 'application/pdf', filename: 'contract.pdf' },
          { type: 'audio', data: base64 },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Let me think about the picture' },
          { type: 'text', text: 'A cat.' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'screenshot',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Taken' },
                { type: 'media', data: base64, mediaType: 'image/jpeg' },
              ],
            },
          },
        ],
      },
    ];
    const out = toTranscript(messages);
    expect(out).toBe(
      'user: What is in this picture?\n[image image/png]\n[file contract.pdf]\n[audio]\n' +
        'assistant: A cat.\n' +
        'tool: Taken\n[media image/jpeg]\n',
    );
    expect(out).not.toContain(base64.slice(0, 20));
    expect(out).not.toContain('think about');
  });

  it('leaves out system messages and messages with no text', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are Ken. Memories: Acme renews in April.' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] },
      { role: 'user', content: 'Hi', name: 'alice' },
    ];
    expect(toTranscript(messages)).toBe('user: Hi\n');
    expect(toTranscript([])).toBe('');
  });

  it('is what transcriptMessages gives, joined', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a\nb' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 't', input: {} },
          { type: 'text', text: 'c' },
        ],
      },
    ];
    expect(transcriptMessages(messages)).toEqual([
      'user: a\nb\n',
      'assistant: [tool t] {}\n',
      'assistant: c\n',
    ]);
    expect(toTranscript(messages)).toBe(transcriptMessages(messages).join(''));
  });
});
