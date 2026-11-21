import { describe, expectTypeOf, it } from 'vitest';
import type {
  components,
  ForgetResponse,
  OneBrain,
  SearchResponse,
  SkillFile,
  SkillsResponse,
  TreeResponse,
  WriteResponse,
} from '../src/index.ts';

type Schemas = components['schemas'];

// Checked by the SDK's typecheck (tsc --noEmit takes test/): an answer type that went wrong would
// be never, which any property access gets past.
describe('the answer types are the API schemas', () => {
  it('names each route answer by its schema, none of them never', () => {
    expectTypeOf<SearchResponse>().not.toBeNever();
    expectTypeOf<SearchResponse['data'][number]>().toEqualTypeOf<Schemas['SearchResult']>();
    expectTypeOf<TreeResponse>().not.toBeNever();
    expectTypeOf<TreeResponse['children'][number]>().toEqualTypeOf<Schemas['Node']>();
    expectTypeOf<SkillsResponse>().toEqualTypeOf<{ data: Schemas['Skill'][] }>();
    expectTypeOf<WriteResponse>().toEqualTypeOf<
      Schemas['File'] | { improvement: Schemas['Improvement'] }
    >();
    expectTypeOf<ForgetResponse>().toEqualTypeOf<{
      memory: Schemas['Memory'];
      replacement: Schemas['Memory'] | null;
    }>();
    expectTypeOf<SkillFile>().toEqualTypeOf<{ path: string; body: string }>();
  });

  it('types read and list by what they are asked', () => {
    expectTypeOf<ReturnType<OneBrain['read']>>().not.toBeNever();
    expectTypeOf<OneBrain['read']>().toBeCallableWith({ id: 'm' });
    expectTypeOf<OneBrain['read']>().toBeCallableWith({ path: 'a.md' });
    expectTypeOf<OneBrain['capture']>().returns.resolves.toEqualTypeOf<Schemas['Source'][]>();
  });
});
