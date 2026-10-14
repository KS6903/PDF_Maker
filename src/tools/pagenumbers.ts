import { Hash } from 'lucide';
import { degrees, rgb, type PDFDocument } from '@cantoo/pdf-lib';
import { h, field, select, numberInput, textInput } from '../lib/ui';
import { loadLib, parseRanges, pdfOutput, baseName, hexToRgb01, visualFrame } from '../lib/pdf';
import { FontCache, FONT_OPTIONS, safeText, type FontFamily } from '../lib/fonts';
import { simpleTool, panel, type Tool } from './common';

export type NumberPosition = 'bl' | 'bc' | 'br' | 'tl' | 'tc' | 'tr';

export interface PageNumberOptions {
  /** {n} is the page number, {total} the page count. */
  format: string;
  position: NumberPosition;
  start: number;
  size: number;
  /** Distance from the edge, in points. */
  margin: number;
  family: FontFamily;
  color: string;
  /** Page ranges; empty for all pages. */
  pages: string;
}

/** Number the chosen pages. Shared with guided actions. */
export async function addPageNumbers(doc: PDFDocument, o: PageNumberOptions) {
  const font = await new FontCache(doc).get(o.family);
  const s = o.size || 11;
  const [r, g, b] = hexToRgb01(o.color);
  const selected = [...new Set(parseRanges(o.pages, doc.getPageCount()))].sort((a, b) => a - b);
  const total = selected.length;
  selected.forEach((pageIndex, k) => {
    const page = doc.getPage(pageIndex);
    const frame = visualFrame(page);
    const text = safeText(font, o.format.replace(/\{n\}/g, String(k + o.start)).replace(/\{total\}/g, String(total + (o.start || 1) - 1)));
    const tw = font.widthOfTextAtSize(text, s);
    const vx = o.position[1] === 'l' ? o.margin : o.position[1] === 'r' ? frame.width - o.margin - tw : (frame.width - tw) / 2;
    const vy = o.position[0] === 't' ? o.margin + s * 0.8 : frame.height - o.margin; // baseline, measured from top
    const p = frame.toPdf(vx, vy);
    page.drawText(text, { x: p.x, y: p.y, size: s, font, color: rgb(r, g, b), rotate: degrees(frame.rotation) });
  });
}

export const pageNumbersTool: Tool = {
  id: 'page-numbers',
  title: 'Page numbers & headers',
  blurb: 'Add page numbers, headers or footers like “Page 3 of 10”.',
  icon: Hash,
  group: 'Edit & sign',
  acceptsPdf: true,
  mount(el, ctx) {
    const format = textInput('{n}', '{n} = page number, {total} = page count');
    const presets = select<string>(
      [
        ['{n}', '1'],
        ['Page {n}', 'Page 1'],
        ['Page {n} of {total}', 'Page 1 of 10'],
        ['{n} / {total}', '1 / 10'],
        ['- {n} -', '- 1 -'],
      ],
      '{n}',
      (v) => (format.value = v),
    );
    const position = select<NumberPosition>(
      [
        ['bc', 'Bottom center'],
        ['br', 'Bottom right'],
        ['bl', 'Bottom left'],
        ['tc', 'Top center'],
        ['tr', 'Top right'],
        ['tl', 'Top left'],
      ],
      'bc',
    );
    const start = numberInput(1, { min: -9999, max: 99999 });
    const size = numberInput(11, { min: 4, max: 96 });
    const margin = numberInput(28, { min: 0, max: 300 });
    const family = select<FontFamily>(FONT_OPTIONS, 'helvetica');
    const color = h('input', { type: 'color', value: '#333333' }) as HTMLInputElement;
    const pages = textInput('', 'All pages (e.g. 2-last)');

    simpleTool(el, ctx, {
      actionLabel: 'Add numbers',
      busyLabel: 'Numbering pages…',
      options: () =>
        panel(
          h(
            'div',
            { class: 'grid' },
            field('Preset', presets),
            field('Text', format, 'Use {n} for the number and {total} for the page count'),
            field('Position', position),
            field('Start at', start),
            field('Font', family),
            field('Font size (pt)', size),
            field('Distance from edge (pt)', margin),
            field('Color', color),
            field('Pages', pages, 'Tip: “2-last” skips a cover page'),
          ),
        ),
      run: async (src) => {
        const doc = await loadLib(src);
        await addPageNumbers(doc, {
          format: format.value,
          position: position.value as NumberPosition,
          start: +start.value || 0,
          size: +size.value || 11,
          margin: +margin.value,
          family: family.value as FontFamily,
          color: color.value,
          pages: pages.value,
        });
        return [pdfOutput(`${baseName(src.name)}-numbered`, await doc.save())];
      },
    });
  },
};
