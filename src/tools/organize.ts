import { LayoutGrid, RotateCcw, RotateCw, Trash2, FilePlus, File as FileIcon, ArrowDownUp, Save, Copy, CheckSquare } from 'lucide';
import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { h, button, icon, withBusy, toast } from '../lib/ui';
import { openPdf, loadLib, loadJs, renderPage, pdfOutput, baseName, type PdfSource } from '../lib/pdf';
import { pdfInput, resultsPanel, type Tool } from './common';

interface PageRef {
  id: number;
  src: number; // index into sources, or -1 for a blank page
  index: number;
  rotate: number; // extra rotation applied on top of the page's own
  size?: [number, number];
}

export const organizeTool: Tool = {
  id: 'organize',
  title: 'Organize pages',
  blurb: 'Reorder, rotate, delete, duplicate and insert pages visually.',
  icon: LayoutGrid,
  group: 'Organize',
  acceptsPdf: true,
  mount(el, ctx) {
    const sources: PdfSource[] = [];
    const jsDocs: PDFDocumentProxy[] = [];
    let pages: PageRef[] = [];
    const selected = new Set<number>();
    let nextId = 1;
    let dragId: number | null = null;
    const thumbCache = new Map<string, HTMLCanvasElement>();

    const grid = h('div', { class: 'page-grid' });
    const status = h('span', { class: 'muted' });
    const results = resultsPanel(ctx);
    const addInput = h('input', {
      type: 'file',
      accept: 'application/pdf,.pdf',
      multiple: true,
      hidden: true,
      onchange: async () => {
        const files = [...(addInput.files ?? [])];
        addInput.value = '';
        for (const f of files) {
          const src = await withBusy('Opening PDF…', () => openPdf(f));
          if (src) await addSource(src);
        }
      },
    }) as HTMLInputElement;

    const toolbar = h(
      'div',
      { class: 'toolbar sticky' },
      button('Select all', () => {
        if (selected.size === pages.length) selected.clear();
        else pages.forEach((p) => selected.add(p.id));
        render();
      }, { icon: CheckSquare, kind: 'ghost' }),
      button(null, () => rotateSel(-90), { icon: RotateCcw, title: 'Rotate selected left', kind: 'ghost' }),
      button(null, () => rotateSel(90), { icon: RotateCw, title: 'Rotate selected right', kind: 'ghost' }),
      button(null, () => duplicateSel(), { icon: Copy, title: 'Duplicate selected', kind: 'ghost' }),
      button(null, () => deleteSel(), { icon: Trash2, title: 'Delete selected', kind: 'ghost' }),
      h('span', { class: 'sep' }),
      button('Blank page', () => insertBlank(), { icon: FileIcon, kind: 'ghost', title: 'Insert a blank page after the selection' }),
      button('Add PDF', () => addInput.click(), { icon: FilePlus, kind: 'ghost', title: 'Append pages from another PDF' }),
      button('Reverse', () => ((pages = pages.reverse()), render()), { icon: ArrowDownUp, kind: 'ghost' }),
      h('span', { class: 'spacer' }),
      status,
      button('Save PDF', () => save(), { icon: Save, kind: 'primary' }),
      addInput,
    );
    const workspace = h('div', { class: 'stack', hidden: true }, toolbar, h('p', { class: 'muted small' }, 'Click pages to select them. Drag to reorder.'), grid, results.el);

    const input = pdfInput(ctx, async (src) => {
      sources.length = 0;
      jsDocs.forEach((d) => d.loadingTask.destroy());
      jsDocs.length = 0;
      pages = [];
      selected.clear();
      thumbCache.clear();
      results.hide();
      workspace.hidden = !src;
      if (src) await addSource(src);
    });

    async function addSource(src: PdfSource) {
      const js = await loadJs(src);
      sources.push(src);
      jsDocs.push(js);
      const s = sources.length - 1;
      for (let i = 0; i < js.numPages; i++) pages.push({ id: nextId++, src: s, index: i, rotate: 0 });
      render();
    }

    function targets() {
      return selected.size ? pages.filter((p) => selected.has(p.id)) : [];
    }
    function needSelection() {
      if (!selected.size) toast('Select one or more pages first.');
      return !selected.size;
    }
    function rotateSel(d: number) {
      if (needSelection()) return;
      targets().forEach((p) => (p.rotate = (p.rotate + d + 360) % 360));
      render();
    }
    function deleteSel() {
      if (needSelection()) return;
      if (selected.size === pages.length) return toast('A PDF needs at least one page.', 'error');
      pages = pages.filter((p) => !selected.has(p.id));
      selected.clear();
      render();
    }
    function duplicateSel() {
      if (needSelection()) return;
      const out: PageRef[] = [];
      for (const p of pages) {
        out.push(p);
        if (selected.has(p.id)) out.push({ ...p, id: nextId++ });
      }
      pages = out;
      render();
    }
    function insertBlank() {
      const lastSel = pages.map((p) => selected.has(p.id)).lastIndexOf(true);
      const at = lastSel >= 0 ? lastSel + 1 : pages.length;
      const ref = pages[Math.max(0, at - 1)];
      const size: [number, number] = ref && ref.src >= 0 ? [0, 0] : [595.28, 841.89];
      pages.splice(at, 0, { id: nextId++, src: -1, index: ref?.src ?? 0, rotate: 0, size });
      render();
    }

    function thumbFor(p: PageRef): HTMLElement {
      if (p.src < 0) return h('div', { class: 'blank-page' }, 'Blank');
      const key = `${p.src}:${p.index}`;
      const holder = h('div', { class: 'thumb-holder' });
      const cached = thumbCache.get(key);
      if (cached) {
        const c = document.createElement('canvas');
        c.width = cached.width;
        c.height = cached.height;
        c.style.cssText = cached.style.cssText;
        c.getContext('2d')!.drawImage(cached, 0, 0);
        holder.append(c);
      } else {
        void jsDocs[p.src]
          .getPage(p.index + 1)
          .then((page) => {
            const vp = page.getViewport({ scale: 1 });
            return renderPage(page, 130 / Math.max(vp.width, vp.height));
          })
          .then((c) => {
            thumbCache.set(key, c);
            const copy = c.cloneNode() as HTMLCanvasElement;
            copy.getContext('2d')!.drawImage(c, 0, 0);
            holder.append(copy);
          });
      }
      return holder;
    }

    function render() {
      grid.replaceChildren(
        ...pages.map((p, i) => {
          const card = h(
            'div',
            {
              class: `page-card${selected.has(p.id) ? ' selected' : ''}`,
              draggable: 'true',
              tabindex: 0,
              role: 'checkbox',
              'aria-checked': String(selected.has(p.id)),
              'aria-label': `Page ${i + 1}`,
              onclick: () => {
                if (selected.has(p.id)) selected.delete(p.id);
                else selected.add(p.id);
                render();
              },
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).click();
                } else if (e.key === 'Delete') {
                  selected.add(p.id);
                  deleteSel();
                }
              },
              ondragstart: (e: DragEvent) => {
                dragId = p.id;
                e.dataTransfer?.setData('text/plain', String(p.id));
                card.classList.add('dragging');
              },
              ondragend: () => card.classList.remove('dragging'),
              ondragover: (e: DragEvent) => {
                e.preventDefault();
                const r = card.getBoundingClientRect();
                const after = e.clientX > r.left + r.width / 2;
                card.classList.toggle('drop-before', !after);
                card.classList.toggle('drop-after', after);
              },
              ondragleave: () => card.classList.remove('drop-before', 'drop-after'),
              ondrop: (e: DragEvent) => {
                e.preventDefault();
                const after = card.classList.contains('drop-after');
                card.classList.remove('drop-before', 'drop-after');
                if (dragId === null || dragId === p.id) return;
                const from = pages.findIndex((x) => x.id === dragId);
                const [moved] = pages.splice(from, 1);
                let to = pages.findIndex((x) => x.id === p.id);
                if (after) to++;
                pages.splice(to, 0, moved);
                dragId = null;
                render();
              },
            },
            h('div', { class: 'page-visual', style: `transform: rotate(${p.rotate}deg)` }, thumbFor(p)),
            h(
              'div',
              { class: 'page-foot' },
              h('span', null, String(i + 1)),
              sources.length > 1 && p.src >= 0 ? h('span', { class: 'muted small', title: sources[p.src].name }, `file ${p.src + 1}`) : null,
              h(
                'span',
                { class: 'page-mini' },
                miniBtn(RotateCw, 'Rotate', () => ((p.rotate = (p.rotate + 90) % 360), render())),
                miniBtn(Trash2, 'Delete', () => {
                  if (pages.length === 1) return toast('A PDF needs at least one page.', 'error');
                  pages = pages.filter((x) => x.id !== p.id);
                  selected.delete(p.id);
                  render();
                }),
              ),
            ),
          );
          return card;
        }),
      );
      status.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}${selected.size ? ` · ${selected.size} selected` : ''}`;
    }

    function miniBtn(ic: Parameters<typeof icon>[0], title: string, fn: () => void) {
      return h(
        'button',
        {
          type: 'button',
          class: 'mini',
          title,
          'aria-label': title,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            fn();
          },
        },
        icon(ic, 14),
      );
    }

    async function save() {
      const out = await withBusy('Building PDF…', async () => {
        const libs = await Promise.all(sources.map((s) => loadLib(s)));
        const doc = await PDFDocument.create();
        // Copy each source's pages in one batch so shared fonts/images are embedded once.
        const copies = new Map<string, import('@cantoo/pdf-lib').PDFPage[]>();
        for (let s = 0; s < libs.length; s++) {
          const wanted = [...new Set(pages.filter((p) => p.src === s).map((p) => p.index))];
          const copied = await doc.copyPages(libs[s], wanted);
          wanted.forEach((idx, k) => copies.set(`${s}:${idx}`, [copied[k]]));
        }
        for (const p of pages) {
          if (p.src < 0) {
            // Blank pages match the size of the page before them.
            const prev = libs[p.index]?.getPage(0);
            const size: [number, number] = p.size && p.size[0] ? p.size : prev ? [prev.getWidth(), prev.getHeight()] : [595.28, 841.89];
            doc.addPage(size).setRotation(degrees(p.rotate));
            continue;
          }
          // Duplicated pages need their own copy; a page object can only appear once.
          const copied = copies.get(`${p.src}:${p.index}`)?.pop() ?? (await doc.copyPages(libs[p.src], [p.index]))[0];
          copied.setRotation(degrees((copied.getRotation().angle + p.rotate) % 360));
          doc.addPage(copied);
        }
        return doc.save({ useObjectStreams: true });
      });
      if (out) results.show([pdfOutput(`${baseName(sources[0]?.name ?? 'document')}-organized`, out)]);
    }

    el.append(input.el, workspace);
    return () => jsDocs.forEach((d) => d.loadingTask.destroy());
  },
};
