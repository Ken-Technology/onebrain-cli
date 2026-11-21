import { onebrainSkills } from '@useonebrain/eve';

// The skills in the team's One Brain, as the agent's own skills: read once per session with
// ONEBRAIN_API_KEY from ONEBRAIN_URL, each with its files. When One Brain cannot be reached, the
// agent runs without them.
export default onebrainSkills();
