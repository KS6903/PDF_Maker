/**
 * Saved signatures and initials. Stored in IndexedDB on this computer only
 * (the app can't reach the network), with no limit on how many are kept.
 */

export interface SavedSignature {
  id: string;
  dataUrl: string; // transparent PNG
  createdAt: number;
}

const DB = 'pdfmaker-signatures';
const STORE = 'signatures';
const LEGACY_KEY = 'pdfmaker.signature'; // single signature kept by 1.0.0

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(req ? req.result : undefined);
    };
    t.onerror = () => reject(t.error);
  });
}

async function migrateLegacy() {
  try {
    const old = localStorage.getItem(LEGACY_KEY);
    if (!old) return;
    await saveSignature(old);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function listSignatures(): Promise<SavedSignature[]> {
  try {
    await migrateLegacy();
    const rows = (await run<SavedSignature[]>('readonly', (s) => s.getAll())) ?? [];
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveSignature(dataUrl: string) {
  try {
    const existing = (await run<SavedSignature[]>('readonly', (s) => s.getAll())) ?? [];
    if (existing.some((e) => e.dataUrl === dataUrl)) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await run('readwrite', (s) => void s.put({ id, dataUrl, createdAt: Date.now() } satisfies SavedSignature));
  } catch {
    /* storage unavailable: the signature is still inserted, just not remembered */
  }
}

export async function deleteSignature(id: string) {
  await run('readwrite', (s) => void s.delete(id)).catch(() => undefined);
}
