import {
  PDFDocument,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFImage,
  type PDFObject,
  type PDFPage,
  type PDFRawStream,
} from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip from 'jszip';
import { askPassword } from './ui';
import { addRecent } from './recent';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

const asset = (path: string) => new URL(`pdfjs/${path}/`, document.baseURI).href;

/** getDocument() parameters, wired to the bundled offline assets. */
export function docParams(data: Uint8Array, password?: string) {
  return {
    data,
    password,
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    iccUrl: asset('iccs'),
  };
}

/** A PDF the user opened, plus the password needed to read it (if any). */
export interface PdfSource {
  name: string;
  bytes: Uint8Array;
  password?: string;
  pageCount: number;
}

export async function readFile(file: File) {
  return new Uint8Array(await file.arrayBuffer());
}

export function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '');
}

/**
 * Opens a PDF with pdf.js (which verifies passwords reliably), prompting for a
 * password if needed. Returns null when the user cancels the prompt.
 */
export async function openPdf(file: File | { name: string; bytes: Uint8Array }): Promise<PdfSource | null> {
  const bytes = file instanceof File ? await readFile(file) : file.bytes;
  let password: string | undefined;
  let retry = false;
  for (;;) {
    try {
      const doc = await pdfjs.getDocument(docParams(bytes.slice(), password)).promise;
      const src: PdfSource = { name: file.name, bytes, password, pageCount: doc.numPages };
      await doc.loadingTask.destroy();
      // Files the user picked themselves show up under "Recent" on the home screen.
      if (file instanceof File) void addRecent(file.name, bytes, doc.numPages);
      return src;
    } catch (err) {
      if ((err as { name?: string }).name !== 'PasswordException') throw err;
      const pw = await askPassword(file.name, retry);
      if (pw === null) return null;
      password = pw;
      retry = true;
    }
  }
}

/** Load a source into pdf-lib for editing. Encrypted files are decrypted in memory. */
export async function loadLib(src: PdfSource): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(src.bytes, { password: src.password, updateMetadata: false });
  } catch (err) {
    // Owner-password-only PDFs open in viewers without a password; decrypt with the empty user password.
    if (err instanceof EncryptedPDFError && src.password === undefined) {
      return PDFDocument.load(src.bytes, { password: '', updateMetadata: false });
    }
    throw err;
  }
}

export function loadJs(src: PdfSource): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument(docParams(src.bytes.slice(), src.password)).promise;
}

/** Render a page into a new canvas at the given scale (1 = 72 dpi). */
export async function renderPage(page: PDFPageProxy, scale: number, canvas = document.createElement('canvas')) {
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  await page.render({
    canvas,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
  }).promise;
  return canvas;
}

/** Render a page to an exact pixel scale (no devicePixelRatio), for exporting images. */
export async function rasterizePage(page: PDFPageProxy, scale: number, background = '#ffffff') {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas, viewport, background }).promise;
  return canvas;
}

/** Thumbnail of a given width in CSS px. */
export async function thumbnail(doc: PDFDocumentProxy, pageNumber: number, width = 150) {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  return renderPage(page, width / base.width);
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
  );
}

/**
 * Parse page ranges like "1-3, 5, 8-" into zero-based indices (in order, duplicates kept).
 * Empty input means all pages.
 */
export function parseRanges(input: string, pageCount: number): number[] {
  const text = input.trim();
  if (!text) return [...Array(pageCount).keys()];
  const out: number[] = [];
  for (const part of text.split(/[,;]+/)) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    const m = p.match(/^(\d*|last)\s*(?:-\s*(\d*|last))?$/);
    if (!m) throw new Error(`Couldn't understand the page range “${part.trim()}”.`);
    const num = (s: string, dflt: number) => (s === 'last' ? pageCount : s === '' ? dflt : parseInt(s, 10));
    const a = num(m[1], 1);
    const b = m[2] === undefined ? a : num(m[2], pageCount);
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) {
      throw new Error(`Page range “${part.trim()}” is outside 1-${pageCount}.`);
    }
    const step = a <= b ? 1 : -1;
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i - 1);
  }
  if (!out.length) throw new Error('No pages selected.');
  return out;
}

/** Split a range list into groups: "1-3, 4-6" → [[0,1,2],[3,4,5]]. */
export function parseRangeGroups(input: string, pageCount: number): number[][] {
  return input
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseRanges(s, pageCount));
}

/* ---------- outputs ---------- */

export interface OutputFile {
  name: string;
  data: Uint8Array | Blob;
  type: string;
}

export function pdfOutput(name: string, data: Uint8Array): OutputFile {
  return { name: name.endsWith('.pdf') ? name : `${name}.pdf`, data, type: 'application/pdf' };
}

export function toBlob(file: OutputFile) {
  return file.data instanceof Blob ? file.data : new Blob([file.data as BlobPart], { type: file.type });
}

export function download(file: OutputFile) {
  const url = URL.createObjectURL(toBlob(file));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function zipOutputs(files: OutputFile[], zipName: string): Promise<OutputFile> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const f of files) {
    let name = f.name;
    for (let i = 2; used.has(name); i++) name = f.name.replace(/(\.[^.]+)?$/, ` (${i})$1`);
    used.add(name);
    zip.file(name, f.data);
  }
  const data = await zip.generateAsync({ type: 'uint8array' });
  return { name: zipName.endsWith('.zip') ? zipName : `${zipName}.zip`, data, type: 'application/zip' };
}

export function fileSize(file: OutputFile) {
  return file.data instanceof Blob ? file.data.size : file.data.byteLength;
}

/* ---------- page sizes ---------- */

export const PAGE_SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
};

export const PAGE_SIZE_OPTIONS: [string, string][] = [
  ['a4', 'A4 (210 × 297 mm)'],
  ['letter', 'US Letter (8.5 × 11 in)'],
  ['legal', 'US Legal (8.5 × 14 in)'],
  ['a3', 'A3 (297 × 420 mm)'],
  ['a5', 'A5 (148 × 210 mm)'],
];

export function hexToRgb01(hex: string): [number, number, number] {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/**
 * The page as the reader sees it (after /Rotate), with a mapper from visual
 * coordinates (origin top-left, y down, in points) to PDF user space.
 * Text drawn with `rotate: degrees(rotation)` reads upright on screen.
 */
export function visualFrame(page: PDFPage) {
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const box = page.getCropBox();
  const { x: x0, y: y0, width: w, height: hgt } = box;
  const sideways = rotation === 90 || rotation === 270;
  const toPdf = (vx: number, vy: number) => {
    switch (rotation) {
      case 90:
        return { x: x0 + vy, y: y0 + vx };
      case 180:
        return { x: x0 + w - vx, y: y0 + vy };
      case 270:
        return { x: x0 + w - vy, y: y0 + hgt - vx };
      default:
        return { x: x0 + vx, y: y0 + hgt - vy };
    }
  };
  return { width: sideways ? hgt : w, height: sideways ? w : hgt, rotation, toPdf };
}

/**
 * Matrix for an annotation appearance drawn upright as the reader sees the
 * page, on a page with the given /Rotate. Readers map the rotated box onto
 * the annotation's rectangle, so the box keeps its on-screen width and height.
 */
export function uprightMatrix(rotation: 0 | 90 | 180 | 270) {
  return { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] }[rotation];
}

/** A rectangle given in visual coordinates (top-left origin), as a PDF /Rect. */
export function visualRect(page: PDFPage, x: number, y: number, w: number, h: number) {
  const frame = visualFrame(page);
  const a = frame.toPdf(x, y);
  const b = frame.toPdf(x + w, y + h);
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

/* ---------- low-level object helpers ---------- */

/** Text held in a PDF string, hex string or text stream, or '' for anything else. */
export function textOf(obj: PDFObject | undefined): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFStream) {
    const bytes = decodePDFRawStream(obj as PDFRawStream).decode();
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    return new TextDecoder('latin1').decode(bytes);
  }
  return '';
}

/**
 * Replace a page's content with a single picture of it, in place, so links to
 * the page (bookmarks, the page tree) keep working. The old content, fonts and
 * annotations are dropped from the page; call pruneUnreachable() before saving
 * so they are dropped from the file too.
 */
export function replacePageWithImage(page: PDFPage, image: PDFImage, width: number, height: number) {
  const node = page.node;
  for (const key of ['Annots', 'Contents', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Group', 'Thumb', 'PieceInfo', 'Metadata', 'StructParents', 'Tabs', 'AA']) {
    node.delete(PDFName.of(key));
  }
  // Empty but complete: once pdf-lib has normalized a page (removing a form
  // field does that) it expects these three dictionaries to be there.
  node.set(PDFName.of('Resources'), node.context.obj({ Font: {}, XObject: {}, ExtGState: {} }));
  node.set(PDFName.of('MediaBox'), node.context.obj([0, 0, width, height]));
  node.set(PDFName.of('Rotate'), node.context.obj(0));
  page.drawImage(image, { x: 0, y: 0, width, height });
}

/**
 * pdf-lib writes every object it parsed, even ones nothing points at any more.
 * After removing content (redaction, flattening), delete what can no longer be
 * reached from the document so it does not linger inside the saved file.
 */
export function pruneUnreachable(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: (PDFObject | undefined)[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) continue;
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue;
      seen.add(obj.tag);
      stack.push(ctx.lookup(obj));
    } else if (obj instanceof PDFDict) {
      stack.push(...obj.values());
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}
