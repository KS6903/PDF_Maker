import { Printer } from 'lucide';
import {
  StandardFonts,
  cmyk,
  clip,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { h, field, numberInput, checkbox, select, textInput } from '../lib/ui';
import { loadLib, loadJs, rasterizePage, pdfOutput, baseName, parseRanges } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';

const MM = 72 / 25.4;
/** Printer's marks print on every plate, so they use all four inks at full strength. */
const REGISTRATION = cmyk(1, 1, 1, 1);

interface MarkOptions {
  bleed: number;
  crop: boolean;
  registration: boolean;
  bars: boolean;
  info: boolean;
  fileName: string;
}

/** Room around the bleed for the marks themselves. */
const MARK_AREA = 30;

function addMarks(doc: PDFDocument, page: PDFPage, index: number, font: PDFFont, o: MarkOptions) {
  const trim = page.getTrimBox();
  const bleed = { x: trim.x - o.bleed, y: trim.y - o.bleed, width: trim.width + o.bleed * 2, height: trim.height + o.bleed * 2 };
  const pad = o.bleed + MARK_AREA;
  const media = { x: trim.x - pad, y: trim.y - pad, width: trim.width + pad * 2, height: trim.height + pad * 2 };

  // Clip the existing artwork to the bleed so nothing spills into the marks.
  const start = doc.context.register(doc.context.contentStream([pushGraphicsState(), rectangle(bleed.x, bleed.y, bleed.width, bleed.height), clip(), endPath()]));
  const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);

  page.setMediaBox(media.x, media.y, media.width, media.height);
  page.setCropBox(media.x, media.y, media.width, media.height);
  page.setBleedBox(bleed.x, bleed.y, bleed.width, bleed.height);
  page.setTrimBox(trim.x, trim.y, trim.width, trim.height);

  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.25, color: REGISTRATION });

  if (o.crop) {
    const gap = o.bleed + 3;
    const len = 18;
    const xs = [trim.x, trim.x + trim.width];
    const ys = [trim.y, trim.y + trim.height];
    for (const x of xs) {
      for (const y of ys) {
        const dx = x === trim.x ? -1 : 1;
        const dy = y === trim.y ? -1 : 1;
        line(x + dx * gap, y, x + dx * (gap + len), y);
        line(x, y + dy * gap, x, y + dy * (gap + len));
      }
    }
  }

  if (o.registration) {
    const r = 5;
    const target = (cx: number, cy: number) => {
      page.drawCircle({ x: cx, y: cy, size: r, borderColor: REGISTRATION, borderWidth: 0.25 });
      page.drawCircle({ x: cx, y: cy, size: r / 2, color: REGISTRATION });
      line(cx - r * 1.6, cy, cx + r * 1.6, cy);
      line(cx, cy - r * 1.6, cx, cy + r * 1.6);
    };
    const mid = pad - MARK_AREA / 2;
    target(trim.x + trim.width / 2, trim.y - mid);
    target(trim.x + trim.width / 2, trim.y + trim.height + mid);
    target(trim.x - mid, trim.y + trim.height / 2);
    target(trim.x + trim.width + mid, trim.y + trim.height / 2);
  }

  if (o.bars) {
    const size = 8;
    const patches = [
      cmyk(1, 0, 0, 0),
      cmyk(0, 1, 0, 0),
      cmyk(0, 0, 1, 0),
      cmyk(0, 0, 0, 1),
      cmyk(0, 1, 1, 0),
      cmyk(1, 0, 1, 0),
      cmyk(1, 1, 0, 0),
      ...[0.1, 0.25, 0.5, 0.75].map((t) => cmyk(0, 0, 0, t)),
    ];
    const y = trim.y + trim.height + o.bleed + (MARK_AREA - size) / 2;
    let x = trim.x + 30;
    for (const c of patches) {
      if (x + size > trim.x + trim.width / 2 - 14) break;
      page.drawRectangle({ x, y, width: size, height: size, color: c });
      x += size;
    }
  }

  if (o.info) {
    const text = `${o.fileName}   Page ${index + 1}   ${new Date().toLocaleString()}`.replace(/[^\x20-\x7e]/g, '?');
    page.drawText(text, { x: trim.x + 30, y: trim.y - o.bleed - MARK_AREA / 2 - 2, size: 6, font, color: cmyk(0, 0, 0, 1) });
  }
}

/** Approximate ink plates from the rendered page (screen colours, no colour profile). */
async function separations(js: PDFDocumentProxy, n: number) {
  const page = await js.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const canvas = await rasterizePage(page, 220 / base.width);
  const { width, height } = canvas;
  const src = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const plates = ['Cyan', 'Magenta', 'Yellow', 'Black'].map(() => new ImageData(width, height));
  const coverage = [0, 0, 0, 0];
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i] / 255;
    const g = src[i + 1] / 255;
    const b = src[i + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    const ink = k >= 1 ? [0, 0, 0, 1] : [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
    ink.forEach((v, p) => {
      coverage[p] += v;
      const d = plates[p].data;
      const light = Math.round(255 * (1 - v));
      // Each plate shows its own ink on white.
      d[i] = p === 0 ? light : p === 3 ? light : 255;
      d[i + 1] = p === 1 ? light : p === 3 ? light : 255;
      d[i + 2] = p === 2 ? light : p === 3 ? light : 255;
      d[i + 3] = 255;
    });
  }
  page.cleanup();
  const pixels = width * height;
  const out = [{ name: 'Composite', canvas, share: null as number | null }];
  plates.forEach((img, p) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    out.push({ name: ['Cyan', 'Magenta', 'Yellow', 'Black'][p], canvas: c, share: coverage[p] / pixels });
  });
  return out;
}

export const printProductionTool: Tool = {
  id: 'print-production',
  title: 'Use print production',
  blurb: 'Add crop marks, registration marks, colour bars and bleed for a print shop, and preview ink plates.',
  icon: Printer,
  group: 'Convert',
  acceptsPdf: true,
  mount(el, ctx) {
    const bleed = numberInput(3, { min: 0, max: 20 });
    bleed.step = '0.5';
    const crop = checkbox('Crop marks', true);
    const registration = checkbox('Registration marks', true);
    const bars = checkbox('Colour bars', true);
    const info = checkbox('Page information', true);
    const pages = textInput('', 'All pages (e.g. 1-3, 7)');
    let js: PDFDocumentProxy | null = null;

    simpleTool(el, ctx, {
      actionLabel: 'Add printer’s marks',
      actionIcon: Printer,
      busyLabel: 'Adding marks…',
      options: async (src) => {
        void js?.loadingTask.destroy();
        js = await loadJs(src);
        const doc = js;
        const plates = h('div', { class: 'plates' });
        const pagePick = select<string>(
          Array.from({ length: doc.numPages }, (_, i): [string, string] => [String(i + 1), `Page ${i + 1}`]),
          '1',
          (v) => void showPlates(+v),
        );
        async function showPlates(n: number) {
          plates.replaceChildren(h('p', { class: 'muted small' }, 'Rendering…'));
          const list = await separations(doc, n);
          plates.replaceChildren(
            ...list.map((p) =>
              h('figure', { class: 'plate' }, p.canvas, h('figcaption', null, p.name, p.share !== null ? h('span', { class: 'muted' }, ` ${Math.round(p.share * 100)}%`) : null)),
            ),
          );
        }
        void showPlates(1);
        return h(
          'div',
          { class: 'stack' },
          panel(
            h('h3', null, 'Marks and bleed'),
            h('div', { class: 'checks' }, crop.el, registration.el, bars.el, info.el),
            h('div', { class: 'grid' }, field('Bleed (mm)', bleed, 'How far artwork may run past the trim edge'), field('Pages', pages)),
            h('p', { class: 'muted small' }, 'Each page grows to make room for the marks. The finished size is recorded as the trim box and the bleed as the bleed box, which is what print shops read.'),
          ),
          panel(
            h('div', { class: 'row between' }, h('h3', null, 'Separations preview'), pagePick),
            h('p', { class: 'muted small' }, 'Approximate ink plates worked out from the page’s screen colours, without a colour profile. The percentage is each ink’s average coverage.'),
            plates,
          ),
        );
      },
      run: async (src) => {
        const doc = await loadLib(src);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const o: MarkOptions = {
          bleed: Math.max(0, +bleed.value || 0) * MM,
          crop: crop.input.checked,
          registration: registration.input.checked,
          bars: bars.input.checked,
          info: info.input.checked,
          fileName: src.name,
        };
        const chosen = [...new Set(parseRanges(pages.value, doc.getPageCount()))];
        for (const i of chosen) addMarks(doc, doc.getPage(i), i, font, o);
        return { files: [pdfOutput(`${baseName(src.name)}-print`, await doc.save())], note: `Marks added to ${chosen.length} page${chosen.length === 1 ? '' : 's'}.` };
      },
    });
    return () => void js?.loadingTask.destroy();
  },
};
