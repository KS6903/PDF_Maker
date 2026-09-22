import { Scissors } from 'lucide';
import { PDFDocument } from '@cantoo/pdf-lib';
import { h, field, select, numberInput, textInput } from '../lib/ui';
import { loadLib, parseRanges, parseRangeGroups, pdfOutput, baseName, type OutputFile } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';

type Mode = 'extract' | 'ranges' | 'every' | 'single';

export const splitTool: Tool = {
  id: 'split',
  title: 'Split & extract',
  blurb: 'Pull out specific pages, or split one PDF into several files.',
  icon: Scissors,
  group: 'Organize',
  acceptsPdf: true,
  mount(el, ctx) {
    const pages = textInput('', 'e.g. 1-3, 5, 8-last');
    const ranges = textInput('', 'e.g. 1-3, 4-9, 10-last');
    const every = numberInput(1, { min: 1 });
    const pagesField = field('Pages to keep', pages, 'All selected pages go into one new PDF');
    const rangesField = field('Ranges', ranges, 'Each range becomes its own PDF');
    const everyField = field('Pages per file', every);
    const mode = select<Mode>(
      [
        ['extract', 'Extract pages into one PDF'],
        ['ranges', 'Split by custom ranges'],
        ['every', 'Split every N pages'],
        ['single', 'Every page as a separate PDF'],
      ],
      'extract',
      (m) => update(m),
    );
    function update(m: Mode) {
      pagesField.hidden = m !== 'extract';
      rangesField.hidden = m !== 'ranges';
      everyField.hidden = m !== 'every';
    }
    update('extract');

    simpleTool(el, ctx, {
      actionLabel: 'Split PDF',
      actionIcon: Scissors,
      busyLabel: 'Splitting…',
      options: () => panel(h('div', { class: 'grid' }, field('Mode', mode), pagesField, rangesField, everyField)),
      run: async (src, progress) => {
        const doc = await loadLib(src);
        const n = doc.getPageCount();
        const name = baseName(src.name);
        const m = mode.value as Mode;
        let groups: number[][];
        if (m === 'extract') groups = [parseRanges(pages.value, n)];
        else if (m === 'ranges') {
          if (!ranges.value.trim()) throw new Error('Enter at least one range, like 1-3, 4-6.');
          groups = parseRangeGroups(ranges.value, n);
        } else {
          const size = m === 'single' ? 1 : Math.max(1, +every.value || 1);
          groups = [];
          for (let i = 0; i < n; i += size) groups.push([...Array(Math.min(size, n - i)).keys()].map((k) => i + k));
        }
        const files: OutputFile[] = [];
        for (const [gi, g] of groups.entries()) {
          progress(`Creating file ${gi + 1} of ${groups.length}…`);
          const out = await PDFDocument.create();
          (await out.copyPages(doc, g)).forEach((p) => out.addPage(p));
          const label = g.length === 1 ? `page-${g[0] + 1}` : `pages-${g[0] + 1}-${g[g.length - 1] + 1}`;
          files.push(pdfOutput(m === 'extract' ? `${name}-extract` : `${name}-${label}`, await out.save({ useObjectStreams: true })));
        }
        return files;
      },
    });
  },
};
