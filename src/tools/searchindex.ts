import { Search, FileText, Trash2, X, FolderSearch } from 'lucide';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { h, icon, button, checkbox, dropzone, withBusy, formatBytes, toast } from '../lib/ui';
import { openPdf, loadJs, rasterizePage } from '../lib/pdf';
import { startOcr, pageHasText } from '../lib/ocr';
import { listIndexed, addToIndex, indexedText, indexedBytes, removeIndexed, clearIndex, type IndexedDoc } from '../lib/searchindex';
import { openInEditor } from '../home';
import { panel, type Tool } from './common';

/** Case- and accent-insensitive form used for matching. */
function fold(s: string) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Words and "quoted phrases" from the search box. */
function terms(q: string) {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = fold((m[1] ?? m[2]).trim());
    if (t) out.push(t);
  }
  return out;
}

async function pageTexts(file: File, ocr: boolean, progress: (t: string) => void) {
  const src = await openPdf(file);
  if (!src) return null;
  const js = await loadJs(src);
  const engine = ocr ? await startOcr() : null;
  const texts: string[] = [];
  try {
    for (let n = 1; n <= js.numPages; n++) {
      progress(`${file.name}: page ${n} of ${js.numPages}…`);
      const page = await js.getPage(n);
      let text = '';
      if (engine && !(await pageHasText(page))) {
        const canvas = await rasterizePage(page, 200 / 72);
        text = (await engine.recognize(canvas, 200)).text;
        canvas.width = canvas.height = 0;
      } else {
        const content = await page.getTextContent();
        text = content.items.map((it) => ('str' in it ? (it as TextItem).str + ((it as TextItem).hasEOL ? '\n' : ' ') : '')).join('');
      }
      texts.push(text.replace(/[ \t]+/g, ' ').trim());
      page.cleanup();
    }
  } finally {
    await engine?.terminate();
    await js.loadingTask.destroy();
  }
  return { bytes: src.bytes, texts };
}

export const searchIndexTool: Tool = {
  id: 'search-index',
  title: 'Add search index',
  blurb: 'Search the text of many PDFs at once, and jump straight to the page.',
  icon: FolderSearch,
  group: 'Organize',
  acceptsPdf: true,
  mount(el, ctx) {
    let docs: IndexedDoc[] = [];
    const texts = new Map<string, { raw: string[]; folded: string[] }>();
    const query = h('input', { type: 'search', class: 'index-search', placeholder: 'Search every indexed PDF', 'aria-label': 'Search the index' }) as HTMLInputElement;
    const hits = h('div', { class: 'index-hits' });
    const listEl = h('div', { class: 'stack' });
    const ocr = checkbox('Read scanned pages with OCR (slower)');
    const countEl = h('h3');

    async function refresh() {
      try {
        docs = await listIndexed();
      } catch {
        docs = [];
        toast('The search index could not be opened on this computer.', 'error');
      }
      for (const d of docs) {
        if (texts.has(d.id)) continue;
        const raw = await indexedText(d.id);
        texts.set(d.id, { raw, folded: raw.map(fold) });
      }
      countEl.textContent = `Indexed documents (${docs.length})`;
      listEl.replaceChildren(
        ...(docs.length
          ? docs.map((d) =>
              h(
                'div',
                { class: 'file-chip' },
                icon(FileText, 18),
                h('div', null, h('strong', null, d.name), h('span', null, `${d.pages} page${d.pages === 1 ? '' : 's'} · ${formatBytes(d.size)}`)),
                button(null, async () => {
                  await removeIndexed(d.id);
                  texts.delete(d.id);
                  await refresh();
                  search();
                }, { icon: X, kind: 'ghost', title: `Remove ${d.name} from the index` }),
              ),
            )
          : [h('p', { class: 'muted' }, 'Nothing indexed yet. Add PDFs below.')]),
      );
    }

    function snippet(raw: string, needle: string) {
      const folded = fold(raw);
      const at = folded.indexOf(needle);
      // Folding can change lengths, so map back by proportion; close enough for a preview.
      const start = Math.max(0, Math.round((at / Math.max(1, folded.length)) * raw.length) - 70);
      const piece = raw.slice(start, start + 220);
      const out = h('p', { class: 'hit-text' }, start > 0 ? '…' : '');
      const fp = fold(piece);
      let i = 0;
      for (;;) {
        const j = fp.indexOf(needle, i);
        if (j < 0 || needle.length === 0) break;
        out.append(piece.slice(i, j), h('mark', null, piece.slice(j, j + needle.length)));
        i = j + needle.length;
      }
      out.append(piece.slice(i), start + 220 < raw.length ? '…' : '');
      return out;
    }

    function search() {
      const q = terms(query.value);
      if (!q.length) return hits.replaceChildren();
      const groups: HTMLElement[] = [];
      let total = 0;
      for (const d of docs) {
        const t = texts.get(d.id);
        if (!t) continue;
        const pages = t.folded.map((p, i) => [p, i] as const).filter(([p]) => q.every((w) => p.includes(w)));
        if (!pages.length) continue;
        total += pages.length;
        groups.push(
          h(
            'div',
            { class: 'hit-group' },
            h('div', { class: 'hit-doc' }, icon(FileText, 16), h('strong', null, d.name), h('span', { class: 'muted' }, ` · ${pages.length} page${pages.length === 1 ? '' : 's'}`)),
            pages.slice(0, 50).map(([, i]) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'hit',
                  title: `Open ${d.name}`,
                  onclick: async () => {
                    const bytes = await indexedBytes(d.id);
                    if (!bytes) return toast('That file is no longer in the index.', 'error');
                    await openInEditor(ctx, { name: d.name, bytes });
                    toast(`Found on page ${i + 1}.`, 'info');
                  },
                },
                h('span', { class: 'hit-page' }, `Page ${i + 1}`),
                snippet(t.raw[i], q[0]),
              ),
            ),
          ),
        );
      }
      hits.replaceChildren(
        h('p', { class: 'muted small' }, total ? `${total} matching page${total === 1 ? '' : 's'} in ${groups.length} document${groups.length === 1 ? '' : 's'}.` : 'No matches.'),
        ...groups,
      );
    }
    query.addEventListener('input', search);

    async function add(files: File[]) {
      const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
      if (!pdfs.length) return;
      const done = await withBusy('Indexing…', async (progress) => {
        let n = 0;
        for (const f of pdfs) {
          const res = await pageTexts(f, ocr.input.checked, progress);
          if (!res) continue;
          const meta = await addToIndex(f.name, res.bytes, res.texts);
          texts.set(meta.id, { raw: res.texts, folded: res.texts.map(fold) });
          n++;
        }
        return n;
      });
      await refresh();
      search();
      if (done) toast(`Indexed ${done} file${done === 1 ? '' : 's'}.`, 'success');
    }

    const zone = dropzone({
      accept: 'application/pdf,.pdf',
      multiple: true,
      compact: true,
      title: 'Add PDFs to the index',
      hint: 'Their text and a copy are kept on this computer only',
      icon: FileText,
      onFiles: (f) => void add(f),
    });

    el.append(
      panel(h('div', { class: 'index-bar' }, icon(Search, 18), query), hits),
      panel(
        h('div', { class: 'row between' }, countEl, button('Clear index', async () => {
          await clearIndex();
          texts.clear();
          await refresh();
          search();
        }, { icon: Trash2, kind: 'ghost' })),
        listEl,
        zone,
        ocr.el,
      ),
    );
    void refresh().then(async () => {
      const handed = ctx.takeIncomingFiles();
      const incoming = ctx.takeIncoming();
      const files = [...(handed ?? []), ...(incoming ? [new File([incoming.bytes as BlobPart], incoming.name, { type: 'application/pdf' })] : [])];
      if (files.length) await add(files);
      query.focus();
    });
  },
};
