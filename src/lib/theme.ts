/**
 * Light / dark theme with an explicit user choice that is remembered.
 *
 * "system" follows Windows. Picking light or dark pins the app to that theme
 * and survives restarts, which is what the CSS reads off <html data-theme>.
 */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'pdfmaker.theme';
const MODES: ThemeMode[] = ['system', 'light', 'dark'];

let mode: ThemeMode = read();
const listeners = new Set<(m: ThemeMode) => void>();

function read(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && (MODES as string[]).includes(saved)) return saved as ThemeMode;
  } catch {
    /* private mode or blocked storage: fall back to following the system */
  }
  return 'system';
}

function paint() {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

export function getTheme() {
  return mode;
}

/** True when the app is currently painting dark, whichever mode is set. */
export function isDark() {
  if (mode !== 'system') return mode === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function setTheme(next: ThemeMode) {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* not being able to remember it is not worth failing over */
  }
  paint();
  for (const fn of listeners) fn(next);
}

export function onThemeChange(fn: (m: ThemeMode) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply the saved choice as early as possible, before the first paint. */
export function initTheme() {
  paint();
  // While following the system, react to Windows switching between light and dark.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (mode === 'system') for (const fn of listeners) fn(mode);
  });
}
