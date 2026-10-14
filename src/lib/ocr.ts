/**
 * Text recognition for scanned pages, with Tesseract running in a worker. The
 * engine, its English model and the worker script ship with the app (see
 * scripts/copy-assets.mjs), so nothing is downloaded and no page leaves the
 * computer.
 */
import { createWorker, OEM } from 'tesseract.js';
import {
  StandardFonts,
  TextRenderingMode,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setTextRenderingMode,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from '@cantoo/pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { rasterizePage, visualFrame } from './pdf';
import { safeText } from './fonts';

const asset = (path: string) => new URL(`ocr/${path}`, document.baseURI).href;

/** A recognised word, in pixels of the image it was read from. */
export interface OcrWord {
  text: string;
  x: number;
  width: number;
  /** Where the text sits, measured from the top of the image. */
  baseline: number;
  /** Height of the line the word is on. */
  lineHeight: number;
}

export interface OcrEngine {
  recognize(canvas: HTMLCanvasElement, dpi: number): Promise<{ words: OcrWord[]; text: string }>;
  terminate(): Promise<void>;
}

/** Start the engine. Takes a second or two, so start it once per batch. */
export async function startOcr(onProgress?: (fraction: number) => void): Promise<OcrEngine> {
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: asset('worker.min.js'),
    // A folder: Tesseract picks the build that suits this processor.
    corePath: asset('core/'),
    langPath: asset('lang'),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
  return {
    async recognize(canvas, dpi) {
      await worker.setParameters({ user_defined_dpi: String(Math.round(dpi)) });
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      const words: OcrWord[] = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            const lineHeight = line.bbox.y1 - line.bbox.y0;
            const { x0, y0, x1, y1 } = line.baseline;
            for (const w of line.words) {
              const text = w.text.trim();
              if (!text || w.confidence < 20) continue;
              const mid = (w.bbox.x0 + w.bbox.x1) / 2;
              const t = x1 !== x0 ? (mid - x0) / (x1 - x0) : 0;
              const baseline = x1 !== x0 ? y0 + (y1 - y0) * t : w.bbox.y1;
              words.push({ text, x: w.bbox.x0, width: w.bbox.x1 - w.bbox.x0, baseline, lineHeight });
            }
          }
        }
      }
      return { words, text: data.text ?? '' };
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}

/**
 * Lay recognised words over a page as invisible text, so it can be searched,
 * selected and copied while the page still looks exactly like the scan.
 * `scale` is image pixels per page point.
 */
export function addTextLayer(page: PDFPage, font: PDFFont, words: OcrWord[], scale: number) {
  const frame = visualFrame(page);
  for (const w of words) {
    const text = safeText(font, w.text);
    const size = Math.max(2, (w.lineHeight / scale) * 0.78);
    const natural = font.widthOfTextAtSize(text, size);
    if (!natural) continue;
    const squeeze = Math.min(500, Math.max(10, ((w.width / scale) / natural) * 100));
    const p = frame.toPdf(w.x / scale, w.baseline / scale);
    // Rendering mode and horizontal scaling are graphics state, so they apply
    // to the text drawn inside this save/restore pair and nothing after it.
    page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(squeeze));
    page.drawText(text, { x: p.x, y: p.y, size, font, rotate: degrees(frame.rotation) });
    page.pushOperators(popGraphicsState());
  }
}

/** Whether pdf.js finds any real text on the page. */
export async function pageHasText(page: PDFPageProxy) {
  const content = await page.getTextContent();
  return content.items.some((it) => 'str' in it && it.str.trim().length > 0);
}

/**
 * OCR the given pages (zero-based) and add a text layer to each. Pages that
 * already have text are left alone when `skipText` is set.
 */
export async function ocrDocument(
  doc: PDFDocument,
  js: PDFDocumentProxy,
  opts: { pages: number[]; dpi: number; skipText: boolean; progress: (t: string) => void },
) {
  let fraction = 0;
  let label = '';
  const engine = await startOcr((f) => {
    fraction = f;
    opts.progress(`${label} ${Math.round(fraction * 100)}%`);
  });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let done = 0;
  let skipped = 0;
  let words = 0;
  try {
    for (const [k, i] of opts.pages.entries()) {
      label = `Reading page ${i + 1} (${k + 1} of ${opts.pages.length})…`;
      opts.progress(label);
      const pjs = await js.getPage(i + 1);
      if (opts.skipText && (await pageHasText(pjs))) {
        skipped++;
        continue;
      }
      const canvas = await rasterizePage(pjs, opts.dpi / 72);
      const res = await engine.recognize(canvas, opts.dpi);
      addTextLayer(doc.getPage(i), font, res.words, opts.dpi / 72);
      words += res.words.length;
      done++;
      canvas.width = canvas.height = 0;
      pjs.cleanup();
    }
  } finally {
    await engine.terminate();
  }
  return { done, skipped, words };
}
