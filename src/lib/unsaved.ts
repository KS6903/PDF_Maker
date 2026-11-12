/**
 * Whoever holds unsaved work registers here, so the desktop shell can ask
 * about it with the app's own dialog instead of a native message box when the
 * window is closed. The editor and Transform pictures register.
 */
export interface UnsavedGuard {
  /** Names of open documents or pictures with changes not yet saved. */
  names(): string[];
}

const guards = new Set<UnsavedGuard>();

export function setUnsavedGuard(g: UnsavedGuard) {
  guards.add(g);
}

export function clearUnsavedGuard(g: UnsavedGuard) {
  guards.delete(g);
}

export function unsavedNames(): string[] {
  return [...guards].flatMap((g) => g.names());
}
