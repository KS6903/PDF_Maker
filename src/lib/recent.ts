/**
 * Recently opened files, kept in IndexedDB on this computer only (never
 * uploaded) so they can be reopened with one click from the home screen.
 *
 * Metadata and file bytes live in separate stores, so listing the recent files
 * never loads the documents themselves into memory.
 */

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  openedAt: number;
}

const DB = 'pdfmaker';
const META = 'recentMeta';
const DATA = 'recentData';
const MAX_FILES = 8;
const MAX_BYTES = 25 * 1024 * 1024; // don't keep copies of huge files

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 kept metadata and bytes together; start clean.
      if (db.objectStoreNames.contains('recent')) db.deleteObjectStore('recent');
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => {
          db.close();
          resolve(req ? req.result : undefined);
        };
        t.onerror = () => reject(t.error);
      }),
  );
}

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
