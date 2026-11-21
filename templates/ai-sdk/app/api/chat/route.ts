import { onebrainTools, withOneBrain } from '@useonebrain/ai-sdk';
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai';
import { after } from 'next/server';

export const maxDuration = 60;

// Any AI Gateway model id. On Vercel the gateway signs in by itself; elsewhere set AI_GATEWAY_API_KEY.
const MODEL = process.env.MODEL ?? 'anthropic/claude-sonnet-5.5';

export async function POST(request: Request) {
  const { id, messages }: { id: string; messages: UIMessage[] } = await request.json();

  const result = streamText({
    // Recall before each call, and capture each finished turn; after() keeps the function alive
    // until the capture is stored. ONEBRAIN_API_KEY and ONEBRAIN_URL come from the environment.
    model: withOneBrain(MODEL, { waitUntil: after }),
    instructions:
      "You answer from the team's One Brain. Search it before you answer anything about the team, its clients or its work, and say which file or memory you used. Remember what the user asks you to remember.",
    messages: await convertToModelMessages(messages),
    // search, read, list, remember, write and forget. write and forget wait for the user's approval.
    tools: onebrainTools(),
    stopWhen: isStepCount(8),
    // The chat's id ties its turns together in One Brain.
    providerOptions: { onebrain: { sessionId: id } },
  });

  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
}
