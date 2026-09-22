import { Hash } from 'lucide';
import { degrees, rgb } from '@cantoo/pdf-lib';
import { h, field, select, numberInput, textInput } from '../lib/ui';
import { loadLib, parseRanges, pdfOutput, baseName, hexToRgb01, visualFrame } from '../lib/pdf';
import { FontCache, FONT_OPTIONS, safeText, type FontFamily } from '../lib/fonts';
import { simpleTool, panel, type Tool } from './common';

type Pos = 'bl' | 'bc' | 'br' | 'tl' | 'tc' | 'tr';

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
    const position = select<Pos>(
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
        const font = await new FontCache(doc).get(family.value as FontFamily);
        const s = +size.value || 11;
        const m = +margin.value;
        const [r, g, b] = hexToRgb01(color.value);
        const selected = [...new Set(parseRanges(pages.value, doc.getPageCount()))].sort((a, b) => a - b);
        const total = selected.length;
        const pos = position.value as Pos;
        selected.forEach((pageIndex, k) => {
          const page = doc.getPage(pageIndex);
          const frame = visualFrame(page);
          const text = safeText(
            font,
            format.value.replace(/\{n\}/g, String(k + (+start.value || 0))).replace(/\{total\}/g, String(total + (+start.value || 1) - 1)),
          );
          const tw = font.widthOfTextAtSize(text, s);
          const vx = pos[1] === 'l' ? m : pos[1] === 'r' ? frame.width - m - tw : (frame.width - tw) / 2;
          const vy = pos[0] === 't' ? m + s * 0.8 : frame.height - m; // baseline, measured from top
          const p = frame.toPdf(vx, vy);
          page.drawText(text, { x: p.x, y: p.y, size: s, font, color: rgb(r, g, b), rotate: degrees(frame.rotation) });
        });
        return [pdfOutput(`${baseName(src.name)}-numbered`, await doc.save())];
      },
    });
  },
};
