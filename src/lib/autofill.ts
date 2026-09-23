/**
 * Remembers short things the user types into PDFs (name, email, address,
 * phone…) so they can be filled in again with one click. Stored in this
 * computer's local storage only; never uploaded.
 */

export interface AutofillEntry {
  value: string;
  labels: string[]; // labels it was typed next to, e.g. ["name", "full name"]
  uses: number;
  lastUsed: number;
}

const KEY = 'pdfmaker.autofill';
const MAX_ENTRIES = 300;
const MAX_LENGTH = 200;

let cache: AutofillEntry[] | null = null;

function load(): AutofillEntry[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '[]') as AutofillEntry[];
  } catch {
    cache = [];
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache ?? []));
  } catch {
    /* storage full or unavailable: remembering is best-effort */
  }
}

export function rememberEntry(value: string, label?: string) {
  const v = value.trim();
  if (!v || v.length > MAX_LENGTH || v.split('\n').length > 4) return;
  const list = load();
  let e = list.find((x) => x.value === v);
  if (!e) {
    e = { value: v, labels: [], uses: 0, lastUsed: 0 };
    list.push(e);
  }
  e.uses++;
  e.lastUsed = Date.now();
  if (label && !e.labels.includes(label)) e.labels.push(label);
  // Keep the most useful entries.
  list.sort((a, b) => b.lastUsed - a.lastUsed);
  list.length = Math.min(list.length, MAX_ENTRIES);
  persist();
}

/** Entries matching what's typed so far, best first. Label matches rank highest. */
export function suggestEntries(typed: string, label?: string, limit = 6): AutofillEntry[] {
  const q = typed.trim().toLowerCase();
  const words = label ? label.split(' ') : [];
  const score = (e: AutofillEntry) => {
    let s = Math.min(e.uses, 20) + (e.lastUsed / 1e12);
    if (label && e.labels.includes(label)) s += 100;
    else if (words.length && e.labels.some((l) => words.some((w) => w.length > 2 && l.includes(w)))) s += 40;
    return s;
  };
  return load()
    .filter((e) => e.value.toLowerCase() !== q && (!q || e.value.toLowerCase().includes(q)))
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

export function forgetEntry(value: string) {
  cache = load().filter((e) => e.value !== value);
  persist();
}

export function forgetAll() {
  cache = [];
  persist();
}
