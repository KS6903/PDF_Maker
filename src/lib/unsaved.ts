/**
 * Whoever holds unsaved work registers here, so the desktop shell can ask
 * about it with the app's own dialog instead of a native message box when the
 * window is closed. Only the editor registers today.
 */
export interface UnsavedGuard {
  /** Names of open documents with edits not yet written to a PDF. */
  names(): string[];
}

let guard: UnsavedGuard | null = null;

export function setUnsavedGuard(g: UnsavedGuard) {
  guard = g;
}

export function clearUnsavedGuard(g: UnsavedGuard) {
  if (guard === g) guard = null;
}

export function unsavedNames(): string[] {
  return guard?.names() ?? [];
}
