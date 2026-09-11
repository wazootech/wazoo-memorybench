/**
 * sanitizePathSegment makes a string safe to use as one filesystem path
 * segment on every OS. Windows forbids `: \ / * ? " < > |` in file and
 * directory names while POSIX allows all of them, so model labels must be
 * sanitized before they are used in cache paths.
 *
 * Characters outside `[A-Za-z0-9_.-]` are replaced with `_`. "/" is replaced
 * too, so callers building multi-segment labels (e.g. `{provider}/{model}`)
 * must split on "/" and sanitize each segment to keep the intended nesting.
 */
export function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_.-]/g, "_")
}
