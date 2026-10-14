/**
 * The full-text search index: the text of each page of the PDFs added to it,
 * and a copy of each file so a result can be reopened. Kept in IndexedDB on
 * this computer only.
 */
import { STORES, run } from './db';

export interface IndexedDoc {
  id: string;
  name: string;
  size: number;
  pages: number;
  addedAt: number;
}

const META = STORES.searchMeta;
const TEXT = STORES.searchText;
const DATA = STORES.searchData;

export async function listIndexed(): Promise<IndexedDoc[]> {
  const rows = (await run<IndexedDoc[]>([META], 'readonly', (t) => t.objectStore(META).getAll())) ?? [];
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function addToIndex(name: string, bytes: Uint8Array, pages: string[]) {
  const id = `${name}:${bytes.byteLength}`;
  const meta: IndexedDoc = { id, name, size: bytes.byteLength, pages: pages.length, addedAt: Date.now() };
  await run([META, TEXT, DATA], 'readwrite', (t) => {
    t.objectStore(META).put(meta);
    t.objectStore(TEXT).put(pages, id);
    t.objectStore(DATA).put(bytes.slice(), id);
  });
  return meta;
}

export async function indexedText(id: string) {
  return (await run<string[]>([TEXT], 'readonly', (t) => t.objectStore(TEXT).get(id))) ?? [];
}

export function indexedBytes(id: string) {
  return run<Uint8Array>([DATA], 'readonly', (t) => t.objectStore(DATA).get(id));
}

export async function removeIndexed(id: string) {
  await run([META, TEXT, DATA], 'readwrite', (t) => {
    t.objectStore(META).delete(id);
    t.objectStore(TEXT).delete(id);
    t.objectStore(DATA).delete(id);
  });
}

export async function clearIndex() {
  await run([META, TEXT, DATA], 'readwrite', (t) => {
    t.objectStore(META).clear();
    t.objectStore(TEXT).clear();
    t.objectStore(DATA).clear();
  });
}
