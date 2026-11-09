/**
 * The PDFs that are open right now, shared by the whole app.
 *
 * A file you open stays open, in its tab at the top, until you close it. Every
 * tool works on the active tab, so you can compress, watermark or reorganize
 * the file you are editing without picking it again, and put the result back
 * into the same tab.
 */

import { confirmDiscard } from './ui';
import { setUnsavedGuard } from './unsaved';
import type { PdfSource } from './pdf';

export interface OpenDoc {
  id: string;
  /** The file as last loaded or applied. Editor marks are kept separately until saved. */
  src: PdfSource;
  /** Has changes that have not been saved to disk. */
  dirty: boolean;
  /** Bumped whenever the file's content is replaced, so views know to reload. */
  version: number;
}

const docs: OpenDoc[] = [];
let activeId: string | null = null;
let seq = 0;
const events = new EventTarget();

/**
 * The editor keeps its marks (text, drawings, signatures) beside the file
 * until they are saved. It registers this so other tools, saving and printing
 * get the file with those marks drawn in.
 */
type Baker = (id: string) => Promise<Uint8Array | null>;
let baker: Baker | null = null;
export function setBaker(fn: Baker) {
  baker = fn;
}

export function listDocs(): readonly OpenDoc[] {
  return docs;
}
export function getDoc(id: string | null | undefined) {
  return id ? docs.find((d) => d.id === id) ?? null : null;
}
export function activeDoc() {
  return getDoc(activeId);
}

export function onDocsChange(fn: () => void) {
  events.addEventListener('change', fn);
  return () => events.removeEventListener('change', fn);
}
function emit() {
  events.dispatchEvent(new Event('change'));
}

/** Open a file in a new tab and make it the active one. The same file twice just switches to it. */
export function openDocument(src: PdfSource): OpenDoc {
  const same = docs.find((d) => d.src.name === src.name && d.src.bytes.byteLength === src.bytes.byteLength);
  if (same) {
    activeId = same.id;
    emit();
    return same;
  }
  const d: OpenDoc = { id: `doc${++seq}`, src: plain(src), dirty: false, version: 1 };
  docs.push(d);
  activeId = d.id;
  emit();
  return d;
}

/** A source without the tab it was handed out from. */
function plain(src: PdfSource): PdfSource {
  const copy = { ...src };
  delete copy.docId;
  return copy;
}

export function setActive(id: string) {
  if (activeId === id || !getDoc(id)) return;
  activeId = id;
  emit();
}

export function setDirty(id: string, dirty: boolean) {
  const d = getDoc(id);
  if (!d || d.dirty === dirty) return;
  d.dirty = dirty;
  emit();
}

/** Put a tool's result into the tab, in place of what was there. */
export function replaceDocument(id: string, src: PdfSource) {
  const d = getDoc(id);
  if (!d) return;
  d.src = { ...plain(src), name: d.src.name };
  d.version++;
  d.dirty = true;
  emit();
}

/** Close a tab, asking first if it has unsaved changes. Resolves false if kept open. */
export async function closeDocument(id: string): Promise<boolean> {
  const d = getDoc(id);
  if (!d) return true;
  if (
    d.dirty &&
    !(await confirmDiscard({
      title: 'Unsaved changes',
      message: `“${d.src.name}” has changes that haven’t been saved yet.`,
      detail: 'Keep it open and use Save to keep them.',
      confirm: 'Close without saving',
      cancel: 'Keep open',
    }))
  )
    return false;
  const i = docs.indexOf(d);
  docs.splice(i, 1);
  if (activeId === id) activeId = docs[Math.min(i, docs.length - 1)]?.id ?? null;
  emit();
  return true;
}

/** The file as it is now, editor marks included. Carries `docId` so results can be applied back. */
export async function currentSource(id: string): Promise<PdfSource | null> {
  const d = getDoc(id);
  if (!d) return null;
  const baked = baker ? await baker(id) : null;
  return { ...d.src, bytes: baked ?? d.src.bytes, docId: d.id };
}

setUnsavedGuard({ names: () => docs.filter((d) => d.dirty).map((d) => d.src.name) });
window.addEventListener('beforeunload', (e) => {
  if (docs.some((d) => d.dirty)) e.preventDefault();
});
