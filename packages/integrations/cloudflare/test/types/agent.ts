// A type test, checked by `pnpm typecheck` and run by nothing: the helpers take `this` of a real
// Agent subclass, whose `ctx` is protected.
import { Agent } from 'agents';
import { addOneBrain, captureTurn, type TurnResult } from '../../src/index.ts';

type UIMessage = { id: string; role: 'user' | 'assistant'; parts: { type: string }[] };

export class Chat extends Agent<{ ONEBRAIN_API_KEY: string }> {
  messages: UIMessage[] = [];

  override async onStart() {
    await addOneBrain(this, { env: this.env });
  }

  onChatResponse(result: TurnResult) {
    this.ctx.waitUntil(captureTurn(this, result, { env: this.env }));
  }
}
