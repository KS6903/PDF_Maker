import { Combine, ChevronUp, ChevronDown, X, FilePlus } from 'lucide';
import { PDFDocument } from '@cantoo/pdf-lib';
import { h, button, dropzone, withBusy, textInput, toast } from '../lib/ui';
import { openPdf, loadLib, loadJs, thumbnail, parseRanges, pdfOutput, type PdfSource } from '../lib/pdf';
import { resultsPanel, type Tool } from './common';

interface Item {
  src: PdfSource;
  range: HTMLInputElement;
  thumb?: HTMLCanvasElement;
}

export const mergeTool: Tool = {
  id: 'merge',
  title: 'Merge PDFs',
  blurb: 'Combine several PDFs into one, in the order you choose.',
  icon: Combine,
  group: 'Organize',
  acceptsPdf: true,
  mount(el, ctx) {
    const items: Item[] = [];
    const list = h('div', { class: 'file-list' });
    const results = resultsPanel(ctx);
    const mergeBtn = button('Merge PDFs', () => merge(), { icon: Combine, kind: 'primary', disabled: true });
    const zone = dropzone({
      accept: 'application/pdf,.pdf',
      multiple: true,
      title: 'Add PDFs to merge',
      hint: 'Pick several at once or drop them here',
      icon: FilePlus,
      onFiles: (files) => add(files),
    });

    async function add(files: (File | PdfSource)[]) {
      await withBusy('Opening files…', async (p) => {
        for (const [i, f] of files.entries()) {
          p(`Opening ${i + 1} of ${files.length}…`);
          const src = f instanceof File || !f.pageCount ? await openPdf(f) : f;
          if (!src) continue;
          const item: Item = { src, range: textInput('', `All ${src.pageCount} pages`) };
          try {
            const js = await loadJs(src);
            item.thumb = await thumbnail(js, 1, 56);
            await js.loadingTask.destroy();
          } catch {
            /* thumbnail is optional */
          }
          items.push(item);
        }
      });
      render();
    }

    function render() {
      list.replaceChildren(
        ...items.map((it, i) =>
          h(
            'div',
            { class: 'file-item' },
            h('div', { class: 'file-thumb' }, it.thumb ?? null),
            h('div', { class: 'file-meta' }, h('strong', null, it.src.name), h('span', null, `${it.src.pageCount} pages`)),
            h('label', { class: 'range' }, h('span', null, 'Pages'), it.range),
            h(
              'div',
              { class: 'file-actions' },
              button(null, () => move(i, -1), { icon: ChevronUp, title: 'Move up', kind: 'ghost', disabled: i === 0 }),
              button(null, () => move(i, 1), { icon: ChevronDown, title: 'Move down', kind: 'ghost', disabled: i === items.length - 1 }),
              button(null, () => (items.splice(i, 1), render()), { icon: X, title: 'Remove', kind: 'ghost' }),
            ),
          ),
        ),
      );
      mergeBtn.disabled = items.length < 1;
      zone.classList.toggle('compact', items.length > 0);
    }

    function move(i: number, d: number) {
      const [it] = items.splice(i, 1);
      items.splice(i + d, 0, it);
      render();
    }

    async function merge() {
      if (items.length < 2 && !items[0]?.range.value.trim()) toast('Tip: add at least two files to merge.', 'info');
      const out = await withBusy('Merging…', async (p) => {
        const doc = await PDFDocument.create();
        for (const [i, it] of items.entries()) {
          p(`Adding ${it.src.name} (${i + 1}/${items.length})…`);
          const src = await loadLib(it.src);
          const pages = await doc.copyPages(src, parseRanges(it.range.value, src.getPageCount()));
          pages.forEach((pg) => doc.addPage(pg));
        }
        return doc.save({ useObjectStreams: true });
      });
      if (out) results.show([pdfOutput('merged', out)]);
    }

    el.append(zone, list, h('div', { class: 'actions' }, mergeBtn), results.el);
    const handed = ctx.takeIncomingFiles();
    const incoming = ctx.takeIncoming();
    if (handed?.length) void add(handed);
    else if (incoming) void add([incoming]);
  },
};
