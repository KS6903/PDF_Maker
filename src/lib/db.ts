/**
 * The app's local database (IndexedDB). It holds recent files, the editor's
 * open documents and the search index. Everything in it stays on this computer
 * and is never uploaded.
 */

const NAME = 'pdfmaker';
const VERSION = 4;

export const STORES = {
  recentMeta: 'recentMeta',
  recentData: 'recentData',
  session: 'session',
  sessionData: 'sessionData',
  searchMeta: 'searchMeta',
  searchText: 'searchText',
  searchData: 'searchData',
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
      if (!db.objectStoreNames.contains(STORES.searchMeta)) db.createObjectStore(STORES.searchMeta, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.searchText)) db.createObjectStore(STORES.searchText);
      if (!db.objectStoreNames.contains(STORES.searchData)) db.createObjectStore(STORES.searchData);
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
