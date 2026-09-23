/**
 * Recently opened files, kept in IndexedDB on this computer only (never
 * uploaded) so they can be reopened with one click from the home screen.
 *
 * Metadata and file bytes live in separate stores, so listing the recent files
 * never loads the documents themselves into memory.
 */

import { STORES, run } from './db';

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  openedAt: number;
}

const META = STORES.recentMeta;
const DATA = STORES.recentData;
const MAX_FILES = 8;
const MAX_BYTES = 25 * 1024 * 1024; // don't keep copies of huge files

/** List recent files, newest first. Reads metadata only. */
export async function listRecent(): Promise<RecentFile[]> {
  try {
    const rows = (await run<RecentFile[]>([META], 'readonly', (t) => t.objectStore(META).getAll())) ?? [];
    return rows.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export async function addRecent(name: string, bytes: Uint8Array, pages: number) {
  if (bytes.byteLength > MAX_BYTES) return;
  try {
    // One entry per file name + size, refreshed when reopened.
    const id = `${name}:${bytes.byteLength}`;
    const meta: RecentFile = { id, name, size: bytes.byteLength, pages, openedAt: Date.now() };
    await run([META, DATA], 'readwrite', (t) => {
      t.objectStore(META).put(meta);
      t.objectStore(DATA).put(bytes.slice(), id);
    });
    const rows = await listRecent();
    for (const old of rows.slice(MAX_FILES)) await removeRecent(old.id);
  } catch {
    /* storage unavailable (private mode, quota): recent files are optional */
  }
}

export async function getRecentBytes(id: string): Promise<Uint8Array | undefined> {
  try {
    return await run<Uint8Array>([DATA], 'readonly', (t) => t.objectStore(DATA).get(id));
  } catch {
    return undefined;
  }
}

export async function removeRecent(id: string) {
  await run([META, DATA], 'readwrite', (t) => {
    t.objectStore(META).delete(id);
    t.objectStore(DATA).delete(id);
  }).catch(() => undefined);
}

export async function clearRecent() {
  await run([META, DATA], 'readwrite', (t) => {
    t.objectStore(META).clear();
    t.objectStore(DATA).clear();
  }).catch(() => undefined);
}
