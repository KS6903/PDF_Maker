import { FilePlus2, FileUp, FileText } from 'lucide';
import mammoth from 'mammoth';
import { h, button, dropzone, withBusy, field, select, numberInput, textInput, toast } from '../lib/ui';
import { blocksToPdf, markdownToBlocks, plainTextToBlocks, htmlToBlocks, type Block } from '../lib/layout';
import { FONT_OPTIONS, type FontFamily } from '../lib/fonts';
import { pdfOutput, pdfjs, docParams, renderPage, PAGE_SIZES, PAGE_SIZE_OPTIONS, baseName } from '../lib/pdf';
import { resultsPanel, panel, type Tool } from './common';

type Format = 'markdown' | 'text' | 'html';

const SAMPLE = `# My document

Write here using **Markdown** — or just type plain text. The preview updates as you type.

## What you can use

- **Bold**, *italic*, \`code\` and [links](https://example.com)
- Numbered and bulleted lists
- Tables, quotes and code blocks

> Tip: import a Word (.docx), HTML, Markdown or text file to convert it straight to PDF.

| Item | Qty | Price |
| ---- | --- | ----- |
| Apples | 3 | $1.50 |
| Coffee | 1 | $9.00 |

---

Add a page break with \`<!-- pagebreak -->\` on its own line.
`;

export const createTool: Tool = {
  id: 'create',
  title: 'Create PDF',
  blurb: 'Write a document, or convert Word, HTML, Markdown and text files to PDF.',
  icon: FilePlus2,
  group: 'Convert',
  mount(el, ctx) {
    let imported: { name: string; blocks: Block[] } | null = null;
    const results = resultsPanel(ctx);

    const format = select<Format>(
      [
        ['markdown', 'Markdown (formatted)'],
        ['text', 'Plain text (as typed)'],
        ['html', 'HTML'],
      ],
      'markdown',
      () => schedule(),
    );
    const editor = h('textarea', { class: 'doc-editor', spellcheck: true, oninput: () => schedule() }) as HTMLTextAreaElement;
    editor.value = SAMPLE;

    const pageSize = select<string>(PAGE_SIZE_OPTIONS, 'a4', () => schedule());
    const orientation = select<'portrait' | 'landscape'>(
      [
        ['portrait', 'Portrait'],
        ['landscape', 'Landscape'],
      ],
      'portrait',
      () => schedule(),
    );
    const family = select<FontFamily>(FONT_OPTIONS, 'helvetica', () => schedule());
    const fontSize = numberInput(11, { min: 6, max: 36, step: 0.5 });
    const margin = numberInput(56, { min: 0, max: 200 });
    const lineHeight = select<string>(
      [
        ['1.2', 'Tight'],
        ['1.4', 'Normal'],
        ['1.7', 'Relaxed'],
        ['2', 'Double'],
      ],
      '1.4',
      () => schedule(),
    );
    const title = textInput('document', 'File name');
    for (const i of [fontSize, margin]) i.addEventListener('input', () => schedule());

    const importInfo = h('div', { class: 'import-info', hidden: true });
    const zone = dropzone({
      accept: '.docx,.md,.markdown,.txt,.html,.htm,.csv,.json,.log',
      title: 'Import a file',
      hint: 'Word (.docx), HTML, Markdown or text',
      icon: FileUp,
      compact: true,
      onFiles: ([f]) => importFile(f),
    });

    const preview = h('div', { class: 'preview-pages' });
    const previewNote = h('span', { class: 'muted small' });

    async function importFile(f: File) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      const res = await withBusy(`Reading ${f.name}…`, async () => {
        if (ext === 'docx') {
          const r = await mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() });
          return htmlToBlocks(r.value);
        }
        const text = await f.text();
        if (ext === 'html' || ext === 'htm') return htmlToBlocks(text);
        if (ext === 'md' || ext === 'markdown') return markdownToBlocks(text);
        return plainTextToBlocks(text);
      });
      if (!res) return;
      imported = { name: f.name, blocks: res };
      title.value = baseName(f.name);
      importInfo.hidden = false;
      importInfo.replaceChildren(
        h('span', null, 'Converting ', h('strong', null, f.name), ext === 'docx' ? ' (text, headings, lists, tables and images are kept)' : ''),
        button('Back to editor', () => {
          imported = null;
          importInfo.hidden = true;
          editor.hidden = false;
          schedule();
        }, { kind: 'ghost' }),
      );
      editor.hidden = true;
      schedule();
    }

    function blocks(): Block[] {
      if (imported) return imported.blocks;
      const text = editor.value;
      if (format.value === 'text') return plainTextToBlocks(text);
      if (format.value === 'html') return htmlToBlocks(text);
      return markdownToBlocks(text);
    }

    function options() {
      let [w, hgt] = PAGE_SIZES[pageSize.value];
      if (orientation.value === 'landscape') [w, hgt] = [hgt, w];
      return {
        pageSize: [w, hgt] as [number, number],
        margin: Math.max(0, +margin.value || 0),
        family: family.value as FontFamily,
        fontSize: Math.max(4, +fontSize.value || 11),
        lineHeight: +lineHeight.value,
        title: title.value,
      };
    }

    let timer = 0;
    let seq = 0;
    function schedule() {
      clearTimeout(timer);
      timer = window.setTimeout(updatePreview, 400);
    }
    async function updatePreview() {
      const my = ++seq;
      try {
        const bytes = await blocksToPdf(blocks(), options());
        const doc = await pdfjs.getDocument(docParams(bytes)).promise;
        const count = Math.min(doc.numPages, 6);
        const canvases: HTMLCanvasElement[] = [];
        for (let i = 1; i <= count; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          canvases.push(await renderPage(page, 300 / vp.width));
        }
        if (my !== seq) return;
        preview.replaceChildren(...canvases.map((c) => h('div', { class: 'preview-page' }, c)));
        previewNote.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}${doc.numPages > count ? ` · previewing first ${count}` : ''}`;
        await doc.loadingTask.destroy();
      } catch (err) {
        console.error(err);
        if (my === seq) previewNote.textContent = 'Preview unavailable';
      }
    }

    async function make() {
      if (!editor.value.trim() && !imported) return toast('Write something first.', 'error');
      const out = await withBusy('Creating PDF…', () => blocksToPdf(blocks(), options()));
      if (!out) return;
      results.show([pdfOutput(title.value.trim() || 'document', out)]);
    }

    el.append(
      h(
        'div',
        { class: 'create-layout' },
        h(
          'div',
          { class: 'stack' },
          zone,
          importInfo,
          h('div', { class: 'row' }, field('Format', format)),
          editor,
          panel(
            h(
              'div',
              { class: 'grid' },
              field('Page size', pageSize),
              field('Orientation', orientation),
              field('Font', family),
              field('Font size (pt)', fontSize),
              field('Margins (pt)', margin),
              field('Line spacing', lineHeight),
              field('File name', title),
            ),
          ),
          h('div', { class: 'actions' }, button('Create PDF', () => make(), { icon: FileText, kind: 'primary' })),
          results.el,
        ),
        h('aside', { class: 'preview' }, h('div', { class: 'preview-head' }, h('strong', null, 'Preview'), previewNote), preview),
      ),
    );
    schedule();
    return () => clearTimeout(timer);
  },
};
