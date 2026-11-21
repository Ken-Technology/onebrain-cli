'use client';

import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import { type FormEvent, useState } from 'react';

/** What each One Brain tool call shows while it runs and after. */
const DOING: Record<string, string> = {
  search: 'Searched One Brain',
  read: 'Read',
  list: 'Listed',
  remember: 'Remembered',
  write: 'Write',
  forget: 'Forget',
};

type ToolPart = {
  type: string;
  state: string;
  input?: Record<string, unknown>;
  approval?: { id: string; isAutomatic?: boolean };
};

function label(name: string, input: Record<string, unknown> | undefined) {
  const what = input?.query ?? input?.path ?? input?.text ?? input?.id ?? '';
  return `${DOING[name] ?? name}${what ? `: ${String(what).slice(0, 80)}` : ''}`;
}

export default function Chat() {
  const [input, setInput] = useState('');
  const { messages, sendMessage, addToolApprovalResponse, status } = useChat({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (input.trim() === '') return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <main>
      <h1>Chat with your team&apos;s One Brain</h1>
      {messages.map((message) => (
        <div key={message.id} className={`message ${message.role}`}>
          {message.parts.map((part, i) => {
            const key = `${message.id}-${i}`;
            if (part.type === 'text') return <p key={key}>{part.text}</p>;
            if (!part.type.startsWith('tool-')) return null;
            const tool = part as ToolPart;
            const name = tool.type.slice('tool-'.length);
            if (
              tool.state === 'approval-requested' &&
              tool.approval &&
              !tool.approval.isAutomatic
            ) {
              const id = tool.approval.id;
              return (
                <div key={key} className="tool approval">
                  <span>{label(name, tool.input)}?</span>
                  <button
                    type="button"
                    onClick={() => addToolApprovalResponse({ id, approved: true })}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => addToolApprovalResponse({ id, approved: false })}
                  >
                    Deny
                  </button>
                </div>
              );
            }
            return (
              <div key={key} className="tool">
                {label(name, tool.input)}
                {tool.state === 'output-denied' ? ' (denied)' : ''}
              </div>
            );
          })}
        </div>
      ))}
      <form onSubmit={submit}>
        <input
          value={input}
          placeholder="Ask about your team's work..."
          onChange={(event) => setInput(event.currentTarget.value)}
          disabled={status !== 'ready'}
        />
      </form>
    </main>
  );
}
