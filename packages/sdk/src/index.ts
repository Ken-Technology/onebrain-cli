import createClient from 'openapi-fetch';
import type { components, paths } from './schema.ts';

export type { components, paths };

/**
 * A typed client for the One Brain API. Paths, parameters and responses come from the OpenAPI
 * spec, so a route that changes shows up here as a type error.
 *
 *   const onebrain = createOneBrainClient({ baseUrl, token });
 *   const { data, error } = await onebrain.GET('/v1/workspaces');
 */
export function createOneBrainClient(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    headers: { Authorization: `Bearer ${options.token}` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export type OneBrainClient = ReturnType<typeof createOneBrainClient>;
