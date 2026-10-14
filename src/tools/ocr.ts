import { ScanText } from 'lucide';
import { h, field, select, textInput, checkbox } from '../lib/ui';
import { loadLib, loadJs, parseRanges, pdfOutput, baseName } from '../lib/pdf';
import { ocrDocument } from '../lib/ocr';
import { simpleTool, panel, type Tool } from './common';

export const ocrTool: Tool = {
  id: 'ocr',
  title: 'Scan & OCR',
  blurb: 'Make scanned pages searchable and copyable by recognising their text.',
  icon: ScanText,
  group: 'Convert',
  acceptsPdf: true,
  mount(el, ctx) {
    const pages = textInput('', 'All pages (e.g. 1-3, 7)');
    const dpi = select<string>(
      [
        ['200', 'Standard (200 DPI)'],
        ['300', 'Fine print (300 DPI, slower)'],
        ['150', 'Fast (150 DPI)'],
      ],
      '200',
    );
    const skip = checkbox('Skip pages that already have text', true);

    simpleTool(el, ctx, {
      actionLabel: 'Recognize text',
      actionIcon: ScanText,
      busyLabel: 'Starting text recognition…',
      options: () =>
        panel(
          h('div', { class: 'grid' }, field('Pages', pages, 'Leave empty for all pages'), field('Detail', dpi)),
          skip.el,
          h(
            'p',
            { class: 'muted small' },
            'The pages keep their exact look. Recognised text is laid invisibly on top, so you can search, select and copy it. English text, recognised on this computer.',
          ),
        ),
      run: async (src, progress) => {
        const doc = await loadLib(src);
        const js = await loadJs(src);
        try {
          const res = await ocrDocument(doc, js, {
            pages: [...new Set(parseRanges(pages.value, doc.getPageCount()))],
            dpi: +dpi.value,
            skipText: skip.input.checked,
            progress,
          });
          if (!res.done) throw new Error(res.skipped ? 'Every selected page already has text, so there was nothing to recognise.' : 'No pages were recognised.');
          progress('Saving…');
          const note =
            `Recognised ${res.words.toLocaleString()} word${res.words === 1 ? '' : 's'} on ${res.done} page${res.done === 1 ? '' : 's'}.` +
            (res.skipped ? ` ${res.skipped} page${res.skipped === 1 ? '' : 's'} already had text and were left as they were.` : '');
          return { files: [pdfOutput(`${baseName(src.name)}-searchable`, await doc.save())], note };
        } finally {
          await js.loadingTask.destroy();
        }
      },
    });
  },
};
