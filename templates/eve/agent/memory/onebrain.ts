import onebrain from "@useonebrain/eve";
import { defineMemory } from "eve/memory";

/**
 * The team's One Brain as the agent's memory.
 *
 * @remarks
 * Before each reply, eve recalls the One Brain files, skills and memories that match the user's
 * message. After it, the turn's messages are stored in One Brain as a session, which One Brain's
 * learning loop reads. The model gets `onebrain__search`, `__read`, `__list`, `__remember`,
 * `__write` and `__forget`; write and forget wait for a person's approval.
 *
 * `ONEBRAIN_API_KEY` is a workspace agent key (`ob_...`) and `ONEBRAIN_URL` the One Brain API,
 * both read when a request is made. The key decides what the agent may read and write, the same
 * for everyone who talks to it, so the slot has one scope for the whole workspace. Pass
 * `onebrain({ capture: false })` to stop storing turns.
 */
export default defineMemory({
  description: "The team's One Brain: files, skills and memories.",
  provider: onebrain(),
  scope: "workspace",
});
