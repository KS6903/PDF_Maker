import { Minimize2 } from 'lucide';
import { PDFDocument } from '@cantoo/pdf-lib';
import { h, field, select, numberInput, formatBytes } from '../lib/ui';
import { loadLib, loadJs, rasterizePage, canvasToBlob, pdfOutput, baseName } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';

type Mode = 'lossless' | 'balanced' | 'strong' | 'custom';

const PRESETS: Record<Exclude<Mode, 'lossless' | 'custom'>, { dpi: number; quality: number }> = {
  balanced: { dpi: 150, quality: 0.72 },
  strong: { dpi: 96, quality: 0.55 },
};

export const compressTool: Tool = {
  id: 'compress',
  title: 'Compress',
  blurb: 'Shrink a PDF so it is easier to email or upload.',
  icon: Minimize2,
  group: 'Organize',
  acceptsPdf: true,
  mount(el, ctx) {
    const dpi = numberInput(150, { min: 36, max: 600 });
    const quality = numberInput(72, { min: 10, max: 100 });
    const custom = h('div', { class: 'grid', hidden: true }, field('Resolution (DPI)', dpi), field('JPEG quality (%)', quality));
    const explain = h('p', { class: 'muted' });
    const mode = select<Mode>(
      [
        ['balanced', 'Balanced — good quality, much smaller'],
        ['strong', 'Strong — smallest file, lower quality'],
        ['lossless', 'Lossless — keep text selectable, modest savings'],
        ['custom', 'Custom resolution & quality'],
      ],
      'balanced',
      (m) => update(m),
    );
    function update(m: Mode) {
      custom.hidden = m !== 'custom';
      explain.textContent =
        m === 'lossless'
          ? 'Rewrites the file structure compactly. Nothing about how it looks changes, and text stays searchable.'
          : 'Re-renders each page as an optimized image. Great for scans and photo-heavy files, but text will no longer be selectable.';
    }
    update('balanced');

    simpleTool(el, ctx, {
      actionLabel: 'Compress PDF',
      busyLabel: 'Compressing…',
      options: () => panel(field('Compression', mode), custom, explain),
      run: async (src, progress) => {
        const m = mode.value as Mode;
        let out: Uint8Array;
        if (m === 'lossless') {
          const doc = await loadLib(src);
          out = await doc.save({ useObjectStreams: true });
        } else {
          const { dpi: d, quality: q } = m === 'custom' ? { dpi: +dpi.value || 150, quality: (+quality.value || 72) / 100 } : PRESETS[m];
          const js = await loadJs(src);
          const doc = await PDFDocument.create();
          for (let i = 1; i <= js.numPages; i++) {
            progress(`Compressing page ${i} of ${js.numPages}…`);
            const page = await js.getPage(i);
            const vp = page.getViewport({ scale: 1 });
            const canvas = await rasterizePage(page, d / 72);
            const jpg = await doc.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', q)).arrayBuffer()));
            const p = doc.addPage([vp.width, vp.height]);
            p.drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height });
            canvas.width = canvas.height = 0;
            page.cleanup();
          }
          await js.loadingTask.destroy();
          out = await doc.save({ useObjectStreams: true });
        }
        const before = src.bytes.byteLength;
        const after = out.byteLength;
        const pct = Math.round((1 - after / before) * 100);
        const note =
          after < before
            ? `${formatBytes(before)} → ${formatBytes(after)} (${pct}% smaller)`
            : `${formatBytes(before)} → ${formatBytes(after)}. This file was already well optimized — try a stronger setting.`;
        return { files: [pdfOutput(`${baseName(src.name)}-compressed`, out)], note };
      },
    });
  },
};
