import { createOneBrain, type OneBrain, type OneBrainOptions } from '@useonebrain/sdk';

/**
 * How a function of this package reaches One Brain: the options of `createOneBrain` from
 * `@useonebrain/sdk` (url, apiKey, workspace, fetch; each defaults to its environment variable),
 * or a client you already made with it.
 */
export type ConnectOptions = OneBrainOptions & {
  /** A client made with `createOneBrain`, used instead of making one from the options. */
  brain?: OneBrain;
};

/**
 * The One Brain client, made at its first use: importing a module that calls onebrainTools() or
 * withOneBrain() at the top, as a Next.js build does, reads no environment and needs no key.
 */
export function lazyBrain(options: ConnectOptions): () => OneBrain {
  const { brain: given, ...connect } = options;
  let brain = given;
  return () => {
    brain ??= createOneBrain(connect);
    return brain;
  };
}

/** An environment variable, or undefined; never throws (a Worker without nodejs_compat has no process). */
export function env(name: string): string | undefined {
  try {
    const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process;
    const value = process?.env?.[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}
