import { PDFDocument, EncryptedPDFError, type PDFPage } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip from 'jszip';
import { askPassword } from './ui';

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
      throw new Error(`Page range “${part.trim()}” is outside 1–${pageCount}.`);
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
