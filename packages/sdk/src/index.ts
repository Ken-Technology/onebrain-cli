import createClient from 'openapi-fetch';
import type { components, paths } from './schema.ts';

export {
  type CaptureInput,
  createOneBrain,
  DEFAULT_URL,
  type ForgetInput,
  type ForgetResponse,
  type ListInput,
  type OneBrain,
  type OneBrainOptions,
  type ReadInput,
  type RememberInput,
  type SearchInput,
  type SearchResponse,
  type SkillFile,
  type SkillsResponse,
  type TreeResponse,
  type WriteInput,
  type WriteResponse,
} from './brain.ts';
export { OneBrainError, type Reply } from './errors.ts';
export { type Message, type MessagePart, ONE_BRAIN_NOTICE, toTranscript } from './transcript.ts';
export {
  type Part,
  type PartOutcome,
  type PostSource,
  type UploadOutcome,
  uploadSession,
} from './upload.ts';
export type { components, paths };

/**
 * A typed client for the One Brain API. Paths, parameters and responses come from the OpenAPI
 * spec, so a route that changes shows up here as a type error. Without a token it sends no
 * Authorization header: the web app sets one per request in its own fetch (apps/web/src/data).
 *
 *   const onebrain = createOneBrainClient({ baseUrl, token });
 *   const { data, error } = await onebrain.GET('/v1/me');
 */
export function createOneBrainClient(options: {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export type OneBrainClient = ReturnType<typeof createOneBrainClient>;
