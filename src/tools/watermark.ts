import { Stamp } from 'lucide';
import { degrees, rgb } from '@cantoo/pdf-lib';
import { h, field, select, numberInput, textInput } from '../lib/ui';
import { loadLib, parseRanges, pdfOutput, baseName, hexToRgb01, visualFrame } from '../lib/pdf';
import { FontCache, FONT_OPTIONS, safeText, type FontFamily } from '../lib/fonts';
import { simpleTool, panel, type Tool } from './common';

export const watermarkTool: Tool = {
  id: 'watermark',
  title: 'Watermark',
  blurb: 'Stamp text like CONFIDENTIAL or DRAFT across your pages.',
  icon: Stamp,
  group: 'Edit & sign',
  acceptsPdf: true,
  mount(el, ctx) {
    const text = textInput('CONFIDENTIAL', 'Watermark text');
    const family = select<FontFamily>(FONT_OPTIONS, 'helvetica');
    const size = numberInput(64, { min: 6, max: 400 });
    const color = h('input', { type: 'color', value: '#d23a2a' }) as HTMLInputElement;
    const opacity = numberInput(25, { min: 1, max: 100 });
    const rotation = numberInput(45, { min: -180, max: 180 });
    const layout = select<'center' | 'tile' | 'top' | 'bottom'>(
      [
        ['center', 'Once, centered'],
        ['tile', 'Tiled across the page'],
        ['top', 'Top of page'],
        ['bottom', 'Bottom of page'],
      ],
      'center',
    );
    const pages = textInput('', 'All pages (e.g. 1-3, 7)');

    simpleTool(el, ctx, {
      actionLabel: 'Add watermark',
      busyLabel: 'Adding watermark…',
      options: () =>
        panel(
          h(
            'div',
            { class: 'grid' },
            field('Text', text),
            field('Font', family),
            field('Font size (pt)', size),
            field('Color', color),
            field('Opacity (%)', opacity),
            field('Rotation (°)', rotation),
            field('Placement', layout),
            field('Pages', pages, 'Leave empty for all pages'),
          ),
        ),
      run: async (src) => {
        const doc = await loadLib(src);
        const fonts = new FontCache(doc);
        const font = await fonts.get(family.value as FontFamily, true);
        const t = safeText(font, text.value || ' ');
        const s = +size.value || 48;
        const [r, g, b] = hexToRgb01(color.value);
        const opts = { font, size: s, color: rgb(r, g, b), opacity: Math.min(1, Math.max(0.01, +opacity.value / 100)) };
        const tw = font.widthOfTextAtSize(t, s);
        const th = font.heightAtSize(s, { descender: false });

        for (const i of new Set(parseRanges(pages.value, doc.getPageCount()))) {
          const page = doc.getPage(i);
          const frame = visualFrame(page);
          const { width, height } = frame;
          // Work in visual space (y up from the bottom), then map to PDF space.
          const rot = (+rotation.value || 0) + frame.rotation;
          const rad = (rot * Math.PI) / 180;
          const draw = (cx: number, cy: number) => {
            const c = frame.toPdf(cx, height - cy);
            // Offset so the text's center lands on the point after rotation around its origin.
            page.drawText(t, {
              ...opts,
              x: c.x - (tw / 2) * Math.cos(rad) + (th / 2) * Math.sin(rad),
              y: c.y - (tw / 2) * Math.sin(rad) - (th / 2) * Math.cos(rad),
              rotate: degrees(rot),
            });
          };
          const vRad = ((+rotation.value || 0) * Math.PI) / 180;
          const mode = layout.value;
          if (mode === 'center') draw(width / 2, height / 2);
          else if (mode === 'top') draw(width / 2, height - s);
          else if (mode === 'bottom') draw(width / 2, s);
          else {
            const stepX = tw * Math.abs(Math.cos(vRad)) + s * 2.5;
            const stepY = tw * Math.abs(Math.sin(vRad)) + s * 2.5;
            for (let y = stepY / 2, row = 0; y < height + stepY; y += stepY, row++) {
              for (let x = (row % 2 ? stepX / 2 : 0) + stepX / 4; x < width + stepX; x += stepX) draw(x, y);
            }
          }
        }
        return [pdfOutput(`${baseName(src.name)}-watermarked`, await doc.save())];
      },
    });
  },
};
