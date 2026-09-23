/**
 * The app's local database (IndexedDB). It holds recent files and the editor's
 * open documents. Everything in it stays on this computer and is never uploaded.
 */

const NAME = 'pdfmaker';
const VERSION = 3;

export const STORES = {
  recentMeta: 'recentMeta',
  recentData: 'recentData',
  session: 'session',
  sessionData: 'sessionData',
} as const;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 kept recent metadata and bytes in one store; start clean.
      if (db.objectStoreNames.contains('recent')) db.deleteObjectStore('recent');
      if (!db.objectStoreNames.contains(STORES.recentMeta)) db.createObjectStore(STORES.recentMeta, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.recentData)) db.createObjectStore(STORES.recentData);
      if (!db.objectStoreNames.contains(STORES.session)) db.createObjectStore(STORES.session, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.sessionData)) db.createObjectStore(STORES.sessionData);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run one transaction; resolves with the request's result once it commits. */
export function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => {
          db.close();
          resolve(req ? req.result : undefined);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}
