/**
 * The editor's open documents, so closing the app doesn't lose your work:
 * reopening restores the same tabs, their unsaved edits, zoom and scroll.
 *
 * Everything is kept in IndexedDB on this computer only, never uploaded.
 */

import { STORES, run } from './db';

export interface SessionTab {
  fileId: string;
  name: string;
  /** Annotations, exactly as the editor stores them. */
  anns: unknown[];
  nextId: number;
  zoom: number;
  scrollTop: number;
  dirty: boolean;
}

export interface SessionInput extends Omit<SessionTab, 'fileId'> {
  fileId: string;
  bytes: Uint8Array;
}

const META = STORES.session;
const DATA = STORES.sessionData;
const KEY = 'current';
const MAX_FILE = 60 * 1024 * 1024;
const MAX_TOTAL = 250 * 1024 * 1024;

/** The tabs that were open last time, or null. */
export async function loadSession(): Promise<{ tabs: SessionTab[]; active: number } | null> {
  try {
    const row = await run<{ tabs: SessionTab[]; active: number }>([META], 'readonly', (t) => t.objectStore(META).get(KEY));
    return row?.tabs?.length ? { tabs: row.tabs, active: row.active } : null;
  } catch {
    return null;
  }
}

export async function getSessionFile(fileId: string): Promise<Uint8Array | undefined> {
  try {
    return await run<Uint8Array>([DATA], 'readonly', (t) => t.objectStore(DATA).get(fileId));
  } catch {
    return undefined;
  }
}

/**
 * Store the open tabs. File bytes are written once per document; later saves
 * only update the edits, so typing stays cheap.
 */
export async function saveSession(tabs: SessionInput[], active: number, storedFiles: Set<string>) {
  try {
    let total = 0;
    const keep: SessionTab[] = [];
    const toWrite: [string, Uint8Array][] = [];
    for (const t of tabs) {
      total += t.bytes.byteLength;
      // Very large documents aren't worth keeping copies of.
      if (t.bytes.byteLength > MAX_FILE || total > MAX_TOTAL) continue;
      const { bytes, ...meta } = t;
      keep.push(meta);
      if (!storedFiles.has(t.fileId)) toWrite.push([t.fileId, bytes]);
    }
    const ids = new Set(keep.map((t) => t.fileId));
    await run([META, DATA], 'readwrite', (tx) => {
      tx.objectStore(META).put({ id: KEY, tabs: keep, active: Math.min(active, keep.length - 1), savedAt: Date.now() });
      const data = tx.objectStore(DATA);
      for (const [id, bytes] of toWrite) data.put(bytes.slice(), id);
      // Drop files for tabs that are gone.
      const all = data.getAllKeys();
      all.onsuccess = () => {
        for (const key of all.result as string[]) if (!ids.has(key)) data.delete(key);
      };
    });
    toWrite.forEach(([id]) => storedFiles.add(id));
  } catch {
    /* storage unavailable or full: the session just isn't remembered */
  }
}

export async function clearSession() {
  await run([META, DATA], 'readwrite', (t) => {
    t.objectStore(META).clear();
    t.objectStore(DATA).clear();
  }).catch(() => undefined);
}
