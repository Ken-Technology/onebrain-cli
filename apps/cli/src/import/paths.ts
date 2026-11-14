// The API's path segment rule (normalizePath on the server). Case is kept.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A local relative path as a One Brain path, names as written, or null when a part breaks the rule. */
export function toOneBrainPath(relative: string): string | null {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => SEGMENT.test(part)) ? parts.join('/') : null;
}
