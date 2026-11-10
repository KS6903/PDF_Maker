/**
 * Turning picture files into something a PDF page can hold. JPEG and PNG go
 * in as they are; everything the browser can decode (WebP, GIF, BMP, ICO,
 * AVIF, SVG) goes through a canvas; TIFF is decoded with UTIF; HEIC (iPhone
 * photos) with libheif, which ships as its own file and loads only when needed.
 */
import UTIF from 'utif';
import { degrees, type PDFDocument, type PDFImage } from '@cantoo/pdf-lib';
import { canvasToBlob, PAGE_SIZES } from './pdf';

export interface PageImage {
  bytes: Uint8Array;
  type: 'jpg' | 'png';
}

export type ImageKind = 'jpg' | 'png' | 'gif' | 'webp' | 'bmp' | 'ico' | 'tiff' | 'heic' | 'avif' | 'svg';

/** What kind of picture the bytes really are, whatever the file is called. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (at(0, 0, 0, 1, 0)) return 'ico';
  if (at(0, 0x49, 0x49, 0x2a, 0) || at(0, 0x4d, 0x4d, 0, 0x2a)) return 'tiff';
  if (ascii(4, 4) === 'ftyp') {
    const brands = ascii(8, Math.min(32, b.length - 8));
    if (/avi[fs]/.test(brands)) return 'avif';
    if (/hei[cxms]|hev[cx]|mif1|msf1/.test(brands)) return 'heic';
  }
  const head = new TextDecoder().decode(b.subarray(0, 1024)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

const KIND_BY_EXT: Record<string, ImageKind> = { heic: 'heic', heif: 'heic', svg: 'svg' };

/**
 * A picture's kind from its contents, falling back on the name only for the
 * formats that can't be told apart by their first bytes. Null for anything
 * that isn't a picture, however it is named.
 */
export function pictureKind(bytes: Uint8Array, name: string): ImageKind | null {
  return sniffImage(bytes) ?? KIND_BY_EXT[name.toLowerCase().split('.').pop() ?? ''] ?? null;
}

/** EXIF orientation of a JPEG (1 = upright), so phone photos aren't sideways. */
function jpegOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 8)) === 'Exif') {
      const t = i + 10;
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o: number) => (le ? u16(o) | (u16(o + 2) << 16) : (u16(o) << 16) | u16(o + 2));
      const ifd = u32(4);
      const count = u16(ifd);
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 1;
}

async function canvasToImage(c: HTMLCanvasElement | OffscreenCanvas, photo: boolean): Promise<PageImage> {
  const canvas = c as HTMLCanvasElement;
  // Photos keep their size as JPEG; graphics and anything transparent stay sharp as PNG.
  const blob = await canvasToBlob(canvas, photo ? 'image/jpeg' : 'image/png', 0.92);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: photo ? 'jpg' : 'png' };
}

function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('unreadable'));
    el.src = url;
  });
}

/** Decode with the browser itself. EXIF rotation is applied on the way. */
async function viaBrowser(bytes: Uint8Array, mime: string, photo: boolean): Promise<PageImage> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const img = await loadImage(url);
    // SVGs without a size of their own get a sensible one.
    const w = img.naturalWidth || 1200;
    const h = img.naturalHeight || Math.round(w * 0.75);
    const c = canvasOf(w, h);
    const g = c.getContext('2d')!;
    if (photo) {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
    }
    g.drawImage(img, 0, 0, w, h);
    return canvasToImage(c, photo);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function viaTiff(bytes: Uint8Array): Promise<PageImage[]> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ifds = UTIF.decode(buf);
  const pages = ifds.filter((ifd: Record<string, unknown>) => ifd.t256 && ifd.t257);
  return Promise.all(
    pages.map(async (ifd: Record<string, unknown> & { width: number; height: number }) => {
      UTIF.decodeImage(buf, ifd);
      const rgba = UTIF.toRGBA8(ifd);
      const c = canvasOf(ifd.width, ifd.height);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, ifd.width * ifd.height * 4), ifd.width, ifd.height), 0, 0);
      return canvasToImage(c, true);
    }),
  );
}

/* ---------- HEIC, loaded on first use ---------- */

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, cb: (d: ImageData | null) => void): void;
}
interface Libheif {
  HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[] };
}
let heif: Promise<Libheif> | null = null;

function loadHeif(): Promise<Libheif> {
  heif ??= new Promise<Libheif>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('heic/libheif-bundle.js', document.baseURI).href;
    script.onload = async () => {
      try {
        const factory = (window as unknown as { libheif: () => Libheif | Promise<Libheif> & { ready?: Promise<unknown> } }).libheif;
        const made = factory();
        resolve(await made);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error('The HEIC decoder could not be loaded.'));
    document.head.append(script);
  }).catch((err) => {
    heif = null;
    throw err;
  });
  return heif;
}

async function viaHeif(bytes: Uint8Array): Promise<PageImage[]> {
  const lib = await loadHeif();
  const images = new lib.HeifDecoder().decode(bytes);
  if (!images.length) throw new Error('No pictures found in this HEIC file.');
  // A HEIC can hold a burst or a live photo; the first image is the one people mean.
  const img = images[0];
  const w = img.get_width();
  const h = img.get_height();
  const data = await new Promise<ImageData>((resolve, reject) =>
    img.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (d) => (d ? resolve(d) : reject(new Error('This HEIC picture could not be decoded.')))),
  );
  const c = canvasOf(w, h);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data.data), w, h), 0, 0);
  return [await canvasToImage(c, true)];
}

const MIME: Record<ImageKind, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  heic: 'image/heic',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** Every picture in the file, ready to embed. Multi-page TIFFs give one per page. */
export async function decodeImage(bytes: Uint8Array, kind: ImageKind): Promise<PageImage[]> {
  try {
    switch (kind) {
      case 'jpg':
        // Upright photos go in untouched; rotated ones are redrawn the right way up.
        return jpegOrientation(bytes) > 1 ? [await viaBrowser(bytes, MIME.jpg, true)] : [{ bytes, type: 'jpg' }];
      case 'png':
        return [{ bytes, type: 'png' }];
      case 'tiff':
        return await viaTiff(bytes);
      case 'heic':
        // Some systems can decode HEIC themselves; otherwise use libheif.
        return await viaBrowser(bytes, MIME.heic, true).then((i) => [i], () => viaHeif(bytes));
      default:
        return [await viaBrowser(bytes, MIME[kind], kind === 'webp' || kind === 'avif')];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    throw new Error(msg && msg !== 'unreadable' ? msg : `This ${kind.toUpperCase()} picture could not be read. It may be damaged.`);
  }
}

export async function embedPageImage(doc: PDFDocument, img: PageImage): Promise<PDFImage> {
  try {
    return img.type === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
  } catch {
    // Unusual encodings (CMYK, 16-bit, progressive quirks): let the browser redraw it.
    const redrawn = await viaBrowser(img.bytes, img.type === 'jpg' ? MIME.jpg : MIME.png, img.type === 'jpg');
    return redrawn.type === 'jpg' ? doc.embedJpg(redrawn.bytes) : doc.embedPng(redrawn.bytes);
  }
}

export interface ImagePageOptions {
  /** A key of PAGE_SIZES, or 'fit' for a page the size of the picture. */
  size: string;
  orientation: 'auto' | 'portrait' | 'landscape';
  margin: number;
  placement: 'fit' | 'fill';
}

/** Quarter turns clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * Where someone put a picture on its page by hand. `scale` is relative to the
 * picture fitting inside the margins (1 = fits exactly), and the centre is a
 * fraction of the page from the top left, so the choice survives a change of
 * page size or margin.
 */
export interface Placement {
  scale: number;
  cx: number;
  cy: number;
  /** Height over width compared with the picture's own shape. Unset keeps its shape. */
  stretch?: number;
}

/** How much is cut off each side, as fractions of the upright picture before it is turned. */
export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface PictureAdjust {
  rotate?: Rotation;
  /** Unset means the page-wide fit or fill choice. */
  placement?: Placement;
  crop?: Crop;
}

export const isCropped = (c?: Crop): c is Crop => !!c && c.l + c.t + c.r + c.b > 1e-4;

/** The page and the picture's box on it, in points from the top left. */
export interface PictureLayout {
  pw: number;
  ph: number;
  /** The picture's bounding box as it appears (after turning). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The scale at which the picture just fits inside the margins. */
  fit: number;
}

/** The picture's own size in points, cropped and then turned, before any stretching. */
export function pictureSize(px: number, py: number, adjust: PictureAdjust = {}) {
  const c = adjust.crop;
  const cw = px * (1 - (c?.l ?? 0) - (c?.r ?? 0));
  const ch = py * (1 - (c?.t ?? 0) - (c?.b ?? 0));
  const turned = adjust.rotate === 90 || adjust.rotate === 270;
  return { iw: (turned ? ch : cw) * 0.75, ih: (turned ? cw : ch) * 0.75 }; // px → pt at 96 dpi
}

/** The page for a picture of this shape. Stretching doesn't change it, so a drag never flips the page. */
function pageFor(o: ImagePageOptions, iw: number, ih: number) {
  let pw: number, ph: number;
  if (o.size === 'fit' || !PAGE_SIZES[o.size]) {
    [pw, ph] = [iw + o.margin * 2, ih + o.margin * 2];
  } else {
    [pw, ph] = PAGE_SIZES[o.size];
    const land = o.orientation === 'landscape' || (o.orientation === 'auto' && iw > ih);
    if (land) [pw, ph] = [ph, pw];
  }
  return { pw, ph, bw: Math.max(1, pw - o.margin * 2), bh: Math.max(1, ph - o.margin * 2) };
}

/** Lay out one picture of `px`×`py` pixels on its page. Shared by the preview and the PDF. */
export function layoutPicture(o: ImagePageOptions, px: number, py: number, adjust: PictureAdjust = {}): PictureLayout {
  const { iw, ih: own } = pictureSize(px, py, adjust);
  const { pw, ph, bw, bh } = pageFor(o, iw, own);
  const p = adjust.placement;
  const ih = own * (p?.stretch ?? 1);
  const fit = Math.min(bw / iw, bh / ih);
  const k = p ? fit * p.scale : o.placement === 'fill' ? Math.max(bw / iw, bh / ih) : fit;
  const w = iw * k;
  const h = ih * k;
  const cx = p ? p.cx * pw : o.margin + bw / 2;
  const cy = p ? p.cy * ph : o.margin + bh / 2;
  return { pw, ph, x: cx - w / 2, y: cy - h / 2, w, h, fit };
}

/** The placement that puts the (cropped, turned) picture exactly in `r`, in points from the page's top left. */
export function placementFor(o: ImagePageOptions, px: number, py: number, adjust: PictureAdjust, r: { x: number; y: number; w: number; h: number }): Placement {
  const { iw, ih: own } = pictureSize(px, py, adjust);
  const { pw, ph, bw, bh } = pageFor(o, iw, own);
  const stretch = r.h / r.w / (own / iw);
  const fit = Math.min(bw / iw, bh / (own * stretch));
  const p: Placement = { scale: r.w / (iw * fit), cx: (r.x + r.w / 2) / pw, cy: (r.y + r.h / 2) / ph };
  if (Math.abs(stretch - 1) > 1e-3) p.stretch = stretch;
  return p;
}

/** How much bigger than "fits inside the margins" the picture must be to cover that area. */
export function fillScale(o: ImagePageOptions, px: number, py: number, adjust: PictureAdjust) {
  const { iw, ih: own } = pictureSize(px, py, adjust);
  const { bw, bh } = pageFor(o, iw, own);
  const ih = own * (adjust.placement?.stretch ?? 1);
  return Math.max(bw / iw, bh / ih) / Math.min(bw / iw, bh / ih);
}

/**
 * Cut the cropped-off edges out of the picture itself, so they aren't hidden
 * in the PDF where someone could pull them back out.
 */
export async function cropPageImage(img: PageImage, crop?: Crop): Promise<PageImage> {
  if (!isCropped(crop)) return img;
  const url = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type === 'jpg' ? 'image/jpeg' : 'image/png' }));
  try {
    const el = await loadImage(url);
    const W = el.naturalWidth;
    const H = el.naturalHeight;
    const sx = Math.round(crop.l * W);
    const sy = Math.round(crop.t * H);
    const sw = Math.max(1, Math.round(W * (1 - crop.l - crop.r)));
    const sh = Math.max(1, Math.round(H * (1 - crop.t - crop.b)));
    const c = canvasOf(sw, sh);
    c.getContext('2d')!.drawImage(el, sx, sy, sw, sh, 0, 0, sw, sh);
    return await canvasToImage(c, img.type === 'jpg');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * One page holding the picture, laid out the way Images → PDF does it. A crop
 * in `adjust` must already be applied to `img` (see cropPageImage).
 */
export function addImagePage(doc: PDFDocument, img: PDFImage, o: ImagePageOptions, adjust: PictureAdjust = {}) {
  const l = layoutPicture(o, img.width, img.height, { ...adjust, crop: undefined });
  const page = doc.addPage([l.pw, l.ph]);
  // PDF space runs bottom up, and pdf-lib turns a picture about its own bottom-left corner.
  const bx = l.x;
  const by = l.ph - l.y - l.h;
  switch (adjust.rotate ?? 0) {
    case 0:
      page.drawImage(img, { x: bx, y: by, width: l.w, height: l.h });
      break;
    case 90:
      page.drawImage(img, { x: bx, y: by + l.h, width: l.h, height: l.w, rotate: degrees(-90) });
      break;
    case 180:
      page.drawImage(img, { x: bx + l.w, y: by + l.h, width: l.w, height: l.h, rotate: degrees(180) });
      break;
    case 270:
      page.drawImage(img, { x: bx + l.w, y: by, width: l.h, height: l.w, rotate: degrees(90) });
      break;
  }
  return page;
}
