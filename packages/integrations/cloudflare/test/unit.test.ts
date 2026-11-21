import { describe, it } from 'vitest';
import { cases } from './cases.ts';

// The cases in Node. workerd.test.ts runs the same cases inside workerd.
describe('@useonebrain/cloudflare in Node', () => {
  for (const one of cases) it(one.name, one.run);
});
