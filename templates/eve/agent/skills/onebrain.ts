import { onebrainSkills } from "@useonebrain/eve";

/**
 * The skills in the team's One Brain, as the agent's own skills.
 *
 * @remarks Read once per session with `ONEBRAIN_API_KEY`, each with its files. When One Brain can't be reached, the agent runs without them and the next session tries again.
 */
export default onebrainSkills();
