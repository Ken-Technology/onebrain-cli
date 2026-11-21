import onebrain from '@useonebrain/eve';
import { defineMemory } from 'eve/memory';

// One Brain as the agent's memory. Each turn recalls what the team's One Brain knows about the
// user's message and stores the turn as a session; the model gets onebrain__search, __read, __list,
// __remember, __write and __forget (write and forget wait for a person's approval).
//
// ONEBRAIN_API_KEY is a workspace agent key (ob_...) and ONEBRAIN_URL the One Brain API. The key
// decides what the agent may read and write, the same for everyone who talks to it, so the slot has
// one scope for the whole workspace. Capture is on: pass onebrain({ capture: false }) to turn it off.
export default defineMemory({
  description: "The team's One Brain: files, skills and memories.",
  provider: onebrain(),
  scope: 'workspace',
});
