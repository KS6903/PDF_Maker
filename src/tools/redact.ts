import { SquareSlash, Eraser, Search, Trash2 } from 'lucide';
import { PDFName, StandardFonts, type PDFRef } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { h, button, field, select, checkbox, withBusy, toast } from '../lib/ui';
import { loadLib, loadJs, rasterizePage, canvasToBlob, pdfOutput, baseName, replacePageWithImage, pruneUnreachable, type PdfSource } from '../lib/pdf';
import { pageStage, svg, type PageStage } from '../lib/viewer';
import { startOcr, addTextLayer } from '../lib/ocr';
import { pdfInput, resultsPanel, type Tool } from './common';

/** An area to black out, in page points from the top left of the page as displayed. */
interface Mark {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;

let measureCtx: CanvasRenderingContext2D | null = null;
/** Share of a string's width taken by its first `i` characters, in a typical sans font. */
function widthShare(str: string, i: number) {
  if (i <= 0) return 0;
  if (i >= str.length) return 1;
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = '100px Arial, sans-serif';
  const total = measureCtx.measureText(str).width;
  return total ? measureCtx.measureText(str.slice(0, i)).width / total : i / str.length;
}

/** Box around characters [a, b) of a text item, in displayed page points. */
function charBox(it: TextItem, a: number, b: number, toView: (x: number, y: number) => number[]) {
  const [ta, tb, tc, td, te, tf] = it.transform;
  const size = Math.hypot(tc, td) || Math.hypot(ta, tb) || 10;
  const len = Math.hypot(ta, tb) || 1;
  const ux = ta / len;
  const uy = tb / len;
  const from = widthShare(it.str, a) * it.width;
  const to = widthShare(it.str, b) * it.width;
  // Below the baseline for descenders, above it for capitals and accents.
  const corners = [
    [from, -0.28],
    [to, -0.28],
    [to, 1.02],
    [from, 1.02],
  ].map(([along, up]) => toView(te + ux * along - uy * up * size, tf + uy * along + ux * up * size));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  // A little extra on every side: character widths are estimated, and a sliver
  // of a letter left showing is a failed redaction.
  const pad = size * 0.12;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** Find every match of the patterns on one page and return boxes around them. */
interface Pattern {
  re: RegExp;
  /** Extra test a match must pass, for patterns a regular expression can't pin down. */
  keep?: (match: string) => boolean;
}

async function findOnPage(js: PDFDocumentProxy, n: number, patterns: Pattern[]): Promise<Mark[]> {
  const page = await js.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  // One string for the whole page, remembering which item each character came from.
  let text = '';
  const spans: { start: number; it: TextItem }[] = [];
  let last: TextItem | null = null;
  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str) continue;
    const it = raw as TextItem;
    if (last) {
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      const sameLine = Math.abs(it.transform[5] - last.transform[5]) < size * 0.5;
      const gap = it.transform[4] - (last.transform[4] + last.width);
      if (!sameLine || last.hasEOL) text += '\n';
      else if (gap > size * 0.15 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
    }
    spans.push({ start: text.length, it });
    text += it.str;
    last = it;
  }
  const marks: Mark[] = [];
  const toView = (x: number, y: number) => vp.convertToViewportPoint(x, y);
  for (const { re, keep } of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0].trim() || (keep && !keep(m[0]))) continue;
      const a = m.index;
      const b = a + m[0].length;
      for (const s of spans) {
        const end = s.start + s.it.str.length;
        if (end <= a || s.start >= b) continue;
        const box = charBox(s.it, Math.max(0, a - s.start), Math.min(s.it.str.length, b - s.start), toView);
        marks.push({ page: n, ...box });
      }
    }
  }
  page.cleanup();
  return marks;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const redactTool: Tool = {
  id: 'redact',
  title: 'Redact a PDF',
  blurb: 'Black out text and areas, and remove what is underneath from the file.',
  icon: SquareSlash,
  group: 'Edit & sign',
  acceptsPdf: true,
  mount(el, ctx) {
    const results = resultsPanel(ctx);
    const work = h('div', { class: 'stack', hidden: true });
    let js: PDFDocumentProxy | null = null;
    let source: PdfSource | null = null;
    let stage: PageStage | null = null;
    let marks: Mark[] = [];

    const terms = h('textarea', { rows: 4, placeholder: 'Words or phrases, one per line', 'aria-label': 'Text to redact' }) as HTMLTextAreaElement;
    const matchCase = checkbox('Match case');
    const wholeWords = checkbox('Whole words only', true);
    const emails = checkbox('Email addresses');
    const phones = checkbox('Phone numbers');
    const summary = h('p', { class: 'muted small' });
    const color = select<string>(
      [
        ['#000000', 'Black'],
        ['#ffffff', 'White'],
      ],
      '#000000',
    );
    const dpi = select<string>(
      [
        ['200', 'Standard (200 DPI)'],
        ['300', 'High (300 DPI)'],
        ['150', 'Small file (150 DPI)'],
      ],
      '200',
    );
    const strip = checkbox('Remove document properties and hidden metadata', true);
    const searchable = checkbox('Make redacted pages searchable again (OCR)');

    function paint() {
      if (!stage) return;
      const n = stage.page();
      stage.overlay.replaceChildren(
        ...marks
          .map((m, i) => [m, i] as const)
          .filter(([m]) => m.page === n)
          .map(([m, i]) => {
            const r = svg('rect', { class: 'redact-mark', x: m.x, y: m.y, width: m.w, height: m.h });
            r.append(svg('title', {}, 'Click to remove'));
            r.addEventListener('pointerdown', (e) => {
              e.stopPropagation();
              marks.splice(i, 1);
              paint();
            });
            return r;
          }),
      );
      const pages = new Set(marks.map((m) => m.page)).size;
      summary.textContent = marks.length
        ? `${marks.length} area${marks.length === 1 ? '' : 's'} marked on ${pages} page${pages === 1 ? '' : 's'}.`
        : 'Nothing marked yet.';
    }

    function wireDrawing(s: PageStage) {
      let start: { x: number; y: number } | null = null;
      let draft: SVGRectElement | null = null;
      s.overlay.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        start = s.point(e);
        draft = svg('rect', { class: 'redact-mark draft', x: start.x, y: start.y, width: 0, height: 0 });
        s.overlay.append(draft);
        s.overlay.setPointerCapture(e.pointerId);
      });
      s.overlay.addEventListener('pointermove', (e) => {
        if (!start || !draft) return;
        const p = s.point(e);
        draft.setAttribute('x', String(Math.min(start.x, p.x)));
        draft.setAttribute('y', String(Math.min(start.y, p.y)));
        draft.setAttribute('width', String(Math.abs(p.x - start.x)));
        draft.setAttribute('height', String(Math.abs(p.y - start.y)));
      });
      s.overlay.addEventListener('pointerup', (e) => {
        if (!start) return;
        const p = s.point(e);
        const m = { page: s.page(), x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
        start = null;
        draft = null;
        if (m.w > 2 && m.h > 2) marks.push(m);
        paint();
      });
    }

    async function markMatches() {
      if (!js) return;
      const flags = matchCase.input.checked ? 'g' : 'gi';
      const patterns: Pattern[] = terms.value
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => ({ re: new RegExp(wholeWords.input.checked ? `(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])` : escapeRe(t), `${flags}u`) }));
      if (emails.input.checked) patterns.push({ re: new RegExp(EMAIL.source, 'gi') });
      if (phones.input.checked) {
        // Long enough to be a phone number, short enough not to be an account number.
        const digits = (s: string) => s.replace(/\D/g, '').length;
        patterns.push({ re: new RegExp(PHONE.source, 'g'), keep: (s) => digits(s) >= 7 && digits(s) <= 15 });
      }
      if (!patterns.length) return toast('Type something to find, or tick email addresses or phone numbers.', 'info');
      const doc = js;
      const found = await withBusy('Searching…', async (progress) => {
        const all: Mark[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          progress(`Searching page ${n} of ${doc.numPages}…`);
          all.push(...(await findOnPage(doc, n, patterns)));
        }
        return all;
      });
      if (!found) return;
      if (!found.length) return toast('No matches found. Scanned pages have no text to search; mark those areas by hand.', 'info');
      marks.push(...found);
      paint();
      const pages = new Set(found.map((m) => m.page)).size;
      toast(`Marked ${found.length} match${found.length === 1 ? '' : 'es'} on ${pages} page${pages === 1 ? '' : 's'}. Check them before applying.`, 'success');
    }

    async function apply() {
      if (!source || !js) return;
      if (!marks.length) return toast('Mark at least one area first.', 'info');
      const src = source;
      const doc0 = js;
      const out = await withBusy('Redacting…', async (progress) => {
        const doc = await loadLib(src);
        const scale = +dpi.value / 72;
        const pages = [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);

        // Form fields on a redacted page would keep their values in the file.
        const doomed = new Set<string>();
        for (const n of pages) for (const ref of doc.getPage(n - 1).node.Annots()?.asArray() ?? []) doomed.add(String(ref));
        const form = doc.getForm();
        for (const f of form.getFields()) {
          const onPage = f.acroField.getWidgets().some((w) => {
            const ref: PDFRef | undefined = doc.context.getObjectRef(w.dict);
            return ref && doomed.has(String(ref));
          });
          if (onPage) {
            try {
              form.removeField(f);
            } catch {
              /* widgets go with the page content below either way */
            }
          }
        }

        const engine = searchable.input.checked ? await startOcr() : null;
        const font = engine ? await doc.embedFont(StandardFonts.Helvetica) : null;
        try {
          for (const [k, n] of pages.entries()) {
            progress(`Redacting page ${n} (${k + 1} of ${pages.length})…`);
            const pjs = await doc0.getPage(n);
            const vp = pjs.getViewport({ scale: 1 });
            const canvas = await rasterizePage(pjs, scale);
            const c2d = canvas.getContext('2d')!;
            c2d.fillStyle = color.value;
            for (const m of marks.filter((m) => m.page === n)) c2d.fillRect(Math.floor(m.x * scale), Math.floor(m.y * scale), Math.ceil(m.w * scale) + 1, Math.ceil(m.h * scale) + 1);
            const jpg = await doc.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer()));
            const page = doc.getPage(n - 1);
            replacePageWithImage(page, jpg, vp.width, vp.height);
            if (engine && font) {
              progress(`Reading page ${n} again…`);
              addTextLayer(page, font, (await engine.recognize(canvas, +dpi.value)).words, scale);
            }
            canvas.width = canvas.height = 0;
            pjs.cleanup();
          }
        } finally {
          await engine?.terminate();
        }

        // Tags can repeat page text (alternate text, actual text), and no longer match the pages.
        doc.catalog.delete(PDFName.of('StructTreeRoot'));
        if (strip.input.checked) {
          doc.setTitle('');
          doc.setAuthor('');
          doc.setSubject('');
          doc.setKeywords([]);
          doc.setCreator('');
          doc.setProducer('');
          doc.catalog.delete(PDFName.of('Metadata'));
        }
        progress('Removing what was underneath…');
        pruneUnreachable(doc);
        return { bytes: await doc.save(), pages: pages.length };
      });
      if (!out) return;
      results.show(
        [pdfOutput(`${baseName(src.name)}-redacted`, out.bytes)],
        `${marks.length} area${marks.length === 1 ? '' : 's'} redacted on ${out.pages} page${out.pages === 1 ? '' : 's'}. Those pages are now flattened images, so nothing under the boxes is left in the file. Other pages are unchanged.`,
      );
    }

    const input = pdfInput(ctx, async (src) => {
      results.hide();
      marks = [];
      void js?.loadingTask.destroy();
      js = null;
      source = src;
      work.replaceChildren();
      work.hidden = !src;
      if (!src) return;
      js = await loadJs(src);
      stage = pageStage(js, paint);
      wireDrawing(stage);
      stage.bar.append(
        h('span', { class: 'spacer' }),
        button('Clear page', () => {
          marks = marks.filter((m) => m.page !== stage!.page());
          paint();
        }, { icon: Eraser, kind: 'ghost' }),
      );
      const side = h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'panel' },
          h('h3', null, 'Find text'),
          terms,
          h('div', { class: 'checks' }, matchCase.el, wholeWords.el, emails.el, phones.el),
          button('Mark matches', () => void markMatches(), { icon: Search }),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h3', null, 'Marked areas'),
          h('p', { class: 'small' }, 'Drag on the page to mark an area. Click a mark to remove it.'),
          summary,
          button('Clear all', () => ((marks = []), paint()), { icon: Trash2, kind: 'ghost' }),
        ),
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'grid' }, field('Box colour', color), field('Page detail', dpi)),
          strip.el,
          searchable.el,
          h('p', { class: 'muted small' }, 'Pages with redactions are flattened into images, so text and drawings under the boxes are removed for good, not just covered.'),
          button('Apply redactions', () => void apply(), { icon: SquareSlash, kind: 'primary' }),
        ),
      );
      work.append(h('div', { class: 'split-layout' }, stage.el, side));
      await stage.show(1);
    });
    el.append(input.el, work, results.el);
    return () => void js?.loadingTask.destroy();
  },
};
