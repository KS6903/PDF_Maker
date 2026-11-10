import { FilePlus2, FileUp, FileText, ImagePlus, X, Trash, Scaling, AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, type IconNode } from 'lucide';
import mammoth from 'mammoth';
import { h, icon, button, dropzone, withBusy, field, select, numberInput, textInput, toast, errorMessage } from '../lib/ui';
import { blocksToPdf, markdownToBlocks, plainTextToBlocks, htmlToBlocks, type Block, type PlacedImage } from '../lib/layout';
import { FONT_OPTIONS, type FontFamily } from '../lib/fonts';
import { pdfOutput, pdfjs, docParams, renderPage, PAGE_SIZES, PAGE_SIZE_OPTIONS, baseName } from '../lib/pdf';
import { pictureKind, decodeImage } from '../lib/images';
import { resultsPanel, panel, type Tool } from './common';

type Format = 'markdown' | 'text' | 'html';
type Align = 'left' | 'center' | 'right';

/** A picture in the document. The text refers to it as `picture:<id>`, so its size lives here, not in the text. */
interface DocPicture {
  name: string;
  /** PNG or JPEG data URL. */
  src: string;
  /** Share of the text width; unset means the picture's own size. */
  width?: number;
  align: Align;
}

const REF = 'picture:';
const PREVIEW_W = 300;

const SAMPLE = `# My document

Write here using **Markdown**, or just type plain text. The preview updates as you type.

## What you can use

- **Bold**, *italic*, \`code\` and [links](https://example.com)
- Numbered and bulleted lists
- Tables, quotes and code blocks
- Pictures: press **Insert picture**, then click the picture in the preview to resize or align it

> Tip: import a Word (.docx), HTML, Markdown or text file to convert it straight to PDF.

| Item | Qty | Price |
| ---- | --- | ----- |
| Apples | 3 | $1.50 |
| Coffee | 1 | $9.00 |

---

Add a page break with \`<!-- pagebreak -->\` on its own line.
`;

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error('Could not read the picture.'));
    r.readAsDataURL(blob);
  });
}

/** Read a picture file into something the layout can embed. Null if the file isn't a picture. */
async function readPicture(file: File): Promise<DocPicture | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = pictureKind(bytes, file.name);
  if (!kind) return null;
  const [img] = await decodeImage(bytes, kind);
  const src = await blobToDataUrl(new Blob([img.bytes as BlobPart], { type: img.type === 'jpg' ? 'image/jpeg' : 'image/png' }));
  return { name: file.name, src, align: 'center' };
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const createTool: Tool = {
  id: 'create',
  title: 'Create PDF',
  blurb: 'Write a document with pictures, or convert Word, HTML, Markdown and text files to PDF.',
  icon: FilePlus2,
  group: 'Convert',
  mount(el, ctx) {
    let imported: { name: string; blocks: Block[] } | null = null;
    const pictures = new Map<string, DocPicture>();
    let picSeq = 0;
    let selected: string | null = null;
    const results = resultsPanel(ctx);

    const format = select<Format>(
      [
        ['markdown', 'Markdown (formatted)'],
        ['text', 'Plain text (as typed)'],
        ['html', 'HTML'],
      ],
      'markdown',
      () => {
        syncInsert();
        schedule();
      },
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
      accept: '.docx,.md,.markdown,.txt,.html,.htm,.csv,.json,.log,image/*,.heic,.heif,.tif,.tiff',
      title: 'Import a file',
      hint: 'Word (.docx), HTML, Markdown or text. A picture opens in Images → PDF',
      icon: FileUp,
      compact: true,
      onFiles: ([f]) => importFile(f),
    });

    /* ---------- pictures ---------- */

    const pictureInput = h('input', {
      type: 'file',
      accept: 'image/*,.heic,.heif,.tif,.tiff,.avif,.svg',
      multiple: true,
      hidden: true,
      onchange: () => {
        const files = [...(pictureInput.files ?? [])];
        pictureInput.value = '';
        if (files.length) void insertPictures(files);
      },
    }) as HTMLInputElement;
    const insertBtn = button('Insert picture', () => pictureInput.click(), { icon: ImagePlus, title: 'Put a picture in the document where the cursor is' });

    function syncInsert() {
      const plain = !imported && format.value === 'text';
      insertBtn.disabled = plain;
      insertBtn.title = plain ? 'Pictures need the Markdown or HTML format' : imported ? 'Add a picture at the end of the document' : 'Put a picture in the document where the cursor is';
    }

    function register(p: DocPicture) {
      const id = String(++picSeq);
      pictures.set(id, p);
      return id;
    }

    async function insertPictures(files: File[]) {
      const read = await withBusy('Reading pictures…', async () => {
        const out: DocPicture[] = [];
        for (const f of files) {
          try {
            const p = await readPicture(f);
            if (p) out.push(p);
            else toast(`${f.name} isn’t a picture.`, 'error');
          } catch (err) {
            toast(`${f.name}: ${errorMessage(err)}`, 'error');
          }
        }
        return out;
      });
      if (!read?.length) return;
      const ids = read.map(register);
      if (imported) {
        for (const id of ids) imported.blocks.push({ kind: 'image', src: REF + id, alt: pictures.get(id)!.name });
      } else {
        const refs = ids.map((id) => {
          const alt = baseName(pictures.get(id)!.name);
          return format.value === 'html' ? `<img src="${REF}${id}" alt="${escapeAttr(alt)}">` : `![${alt.replace(/[[\]\\]/g, '')}](${REF}${id})`;
        });
        // Each picture goes on its own line, as its own paragraph.
        const s = editor.selectionStart;
        const before = editor.value.slice(0, s);
        const after = editor.value.slice(editor.selectionEnd);
        const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        const tail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
        editor.setRangeText(lead + refs.join('\n\n') + tail, s, editor.selectionEnd, 'end');
      }
      selected = ids[ids.length - 1];
      void updatePreview();
    }

    /** Take the picture out of the text (or the imported document) altogether. */
    function removePicture(id: string) {
      if (imported) {
        imported.blocks = imported.blocks.filter((b) => !(b.kind === 'image' && b.src === REF + id));
      } else {
        const md = new RegExp(`\\n?!\\[[^\\]]*\\]\\(${REF}${id}(?:\\s+"[^"]*")?\\)\\n?`, 'g');
        const html = new RegExp(`\\n?<img\\b[^>]*\\bsrc=["']${REF}${id}["'][^>]*>\\n?`, 'gi');
        editor.value = editor.value.replace(md, '\n').replace(html, '\n');
      }
      pictures.delete(id);
      selected = null;
      void updatePreview();
    }

    /* The bar for the selected picture: size, alignment, removal. */
    const widthInput = h('input', { type: 'number', min: 5, max: 100, step: 1, class: 'pic-size-num', 'aria-label': 'Width, percent of the text width' }) as HTMLInputElement;
    const picName = h('strong', { class: 'pic-bar-name' });
    const alignBtns = new Map<Align, HTMLButtonElement>();
    const alignBtn = (a: Align, ic: IconNode, label: string) => {
      const b = h('button', { type: 'button', class: 'btn ghost icon-only', title: label, 'aria-label': label, onclick: () => setPic({ align: a }) }, icon(ic, 16));
      alignBtns.set(a, b);
      return b;
    };
    const picBar = h(
      'div',
      { class: 'pic-bar', hidden: true },
      h('div', { class: 'pic-bar-head' }, picName, button(null, () => choosePicture(null), { icon: X, title: 'Done with this picture', kind: 'ghost' })),
      h(
        'div',
        { class: 'pic-bar-row' },
        h('label', { class: 'pic-bar-width' }, h('span', { class: 'muted small' }, 'Width'), widthInput, h('span', { class: 'muted small' }, '%')),
        h('div', { class: 'pic-bar-group', role: 'group', 'aria-label': 'Alignment' }, alignBtn('left', AlignHorizontalJustifyStart, 'Align left'), alignBtn('center', AlignHorizontalJustifyCenter, 'Centre'), alignBtn('right', AlignHorizontalJustifyEnd, 'Align right')),
        button(null, () => setPic({ width: undefined }), { icon: Scaling, title: 'Back to the picture’s own size', kind: 'ghost' }),
        button(null, () => selected && removePicture(selected), { icon: Trash, title: 'Remove this picture from the document', kind: 'ghost' }),
      ),
      h('p', { class: 'muted small' }, 'Drag a corner of the picture to resize it.'),
    );
    widthInput.addEventListener('change', () => {
      const v = +widthInput.value;
      if (v > 0) setPic({ width: Math.min(100, Math.max(5, v)) / 100 });
    });

    /** Where each picture landed in the last preview, for the width readout. */
    let placed: PlacedImage[] = [];

    function setPic(change: Partial<Pick<DocPicture, 'width' | 'align'>>) {
      const p = selected ? pictures.get(selected) : undefined;
      if (!p) return;
      Object.assign(p, change);
      if ('width' in change && change.width === undefined) delete p.width;
      void updatePreview();
    }

    function choosePicture(id: string | null) {
      selected = id;
      syncBar();
      for (const o of preview.querySelectorAll<HTMLElement>('.doc-pic')) o.classList.toggle('selected', o.dataset.key === id);
    }

    function syncBar() {
      const p = selected ? pictures.get(selected) : undefined;
      picBar.hidden = !p;
      if (!p) return;
      picName.textContent = baseName(p.name);
      picName.title = p.name;
      const at = placed.find((q) => q.key === selected);
      const share = p.width ?? (at ? at.w / at.maxW : 1);
      if (document.activeElement !== widthInput) widthInput.value = String(Math.round(share * 100));
      for (const [a, b] of alignBtns) b.setAttribute('aria-pressed', String(p.align === a));
    }

    /** Clickable boxes over the pictures in a preview page, with corner handles on the selected one. */
    function overlays(pageIndex: number, k: number) {
      return placed
        .filter((p) => p.page === pageIndex && p.key && pictures.has(p.key))
        .map((p) => {
          const key = p.key!;
          const box = h(
            'div',
            {
              class: `doc-pic${key === selected ? ' selected' : ''}`,
              'data-key': key,
              tabindex: 0,
              role: 'button',
              'aria-label': `Picture ${baseName(pictures.get(key)!.name)}. Press Enter to resize or align it.`,
              title: 'Click to resize or align',
              style: `left:${p.x * k}px;top:${p.y * k}px;width:${p.w * k}px;height:${p.h * k}px`,
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  choosePicture(key);
                  widthInput.focus();
                }
              },
            },
            (['nw', 'ne', 'sw', 'se'] as const).map((c) => h('div', { class: `sel-handle ${c}`, 'data-handle': c })),
          );
          let drag: { sx: number; sy: number; x: number; y: number; w: number; h: number } | null = null;
          box.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const handle = (e.target as HTMLElement).closest<HTMLElement>('.sel-handle');
            if (!handle || selected !== key) {
              choosePicture(key);
              return;
            }
            e.preventDefault();
            const c = handle.dataset.handle ?? 'se';
            drag = { sx: c.includes('e') ? 1 : -1, sy: c.includes('s') ? 1 : -1, x: e.clientX, y: e.clientY, w: p.w * k, h: p.h * k };
            box.setPointerCapture(e.pointerId);
          });
          let newW = 0;
          box.addEventListener('pointermove', (e) => {
            if (!drag) return;
            // Proportional, along the diagonal; the opposite corner stays put while dragging.
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            const grow = 1 + (drag.sx * dx * drag.w + drag.sy * dy * drag.h) / (drag.w * drag.w + drag.h * drag.h);
            newW = Math.max(16, Math.min(p.maxW * k, drag.w * grow));
            const newH = (newW * drag.h) / drag.w;
            box.style.width = `${newW}px`;
            box.style.height = `${newH}px`;
            box.style.left = `${drag.sx > 0 ? p.x * k : p.x * k + drag.w - newW}px`;
            box.style.top = `${drag.sy > 0 ? p.y * k : p.y * k + drag.h - newH}px`;
            widthInput.value = String(Math.round((newW / (p.maxW * k)) * 100));
          });
          const end = () => {
            if (!drag) return;
            drag = null;
            if (newW) setPic({ width: Math.max(0.05, Math.min(1, newW / (p.maxW * k))) });
            newW = 0;
          };
          box.addEventListener('pointerup', end);
          box.addEventListener('pointercancel', end);
          return box;
        });
    }

    /* ---------- import ---------- */

    const preview = h('div', { class: 'preview-pages', onpointerdown: () => choosePicture(null) });
    const previewNote = h('span', { class: 'muted small' });

    async function importFile(f: File) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      // A picture on its own is better served by Images → PDF, where it can be sized and placed on its page.
      const head = new Uint8Array(await f.slice(0, 1024).arrayBuffer());
      if (pictureKind(head, f.name)) {
        toast(`${f.name} is a picture, so it opened in Images → PDF, where you can size and place it on the page.`, 'info');
        ctx.openTool('images-to-pdf', undefined, [f]);
        return;
      }
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
      // Pictures that came with the document can be resized like inserted ones.
      let n = 0;
      const blocks = res.map((b): Block => {
        if (b.kind !== 'image' || !b.src.startsWith('data:')) return b;
        const id = register({ name: b.alt || `Picture ${++n}`, src: b.src, align: 'left' });
        return { ...b, src: REF + id };
      });
      imported = { name: f.name, blocks };
      selected = null;
      title.value = baseName(f.name);
      importInfo.hidden = false;
      importInfo.replaceChildren(
        h('span', null, 'Converting ', h('strong', null, f.name), ext === 'docx' ? ' (text, headings, lists, tables and images are kept)' : ''),
        button('Back to editor', () => {
          imported = null;
          selected = null;
          importInfo.hidden = true;
          editor.hidden = false;
          syncInsert();
          schedule();
        }, { kind: 'ghost' }),
      );
      editor.hidden = true;
      syncInsert();
      schedule();
    }

    function blocks(): Block[] {
      if (imported) return imported.blocks;
      const text = editor.value;
      if (format.value === 'text') return plainTextToBlocks(text);
      if (format.value === 'html') return htmlToBlocks(text);
      return markdownToBlocks(text);
    }

    /** The blocks with each `picture:` reference swapped for the picture and its chosen size. */
    function resolved(): Block[] {
      return blocks().map((b) => {
        if (b.kind !== 'image' || !b.src.startsWith(REF)) return b;
        const id = b.src.slice(REF.length);
        const p = pictures.get(id);
        return p ? { ...b, src: p.src, width: p.width, align: p.align, key: id } : b;
      });
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
      clearTimeout(timer);
      const my = ++seq;
      try {
        const found: PlacedImage[] = [];
        const bytes = await blocksToPdf(resolved(), { ...options(), onImage: (p) => found.push(p) });
        const doc = await pdfjs.getDocument(docParams(bytes)).promise;
        const count = Math.min(doc.numPages, 6);
        const pages: { canvas: HTMLCanvasElement; k: number }[] = [];
        for (let i = 1; i <= count; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const k = PREVIEW_W / vp.width;
          pages.push({ canvas: await renderPage(page, k), k });
        }
        if (my !== seq) return;
        placed = found;
        if (selected && !found.some((p) => p.key === selected) && !pictures.has(selected)) selected = null;
        preview.replaceChildren(...pages.map(({ canvas, k }, i) => h('div', { class: 'preview-page' }, canvas, overlays(i, k))));
        syncBar();
        const pics = found.some((p) => p.key);
        previewNote.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}${doc.numPages > count ? ` · previewing first ${count}` : ''}${pics && !selected ? ' · click a picture to resize it' : ''}`;
        await doc.loadingTask.destroy();
      } catch (err) {
        console.error(err);
        if (my === seq) previewNote.textContent = 'Preview unavailable';
      }
    }

    async function make() {
      if (!editor.value.trim() && !imported) return toast('Write something first.', 'error');
      const out = await withBusy('Creating PDF…', () => blocksToPdf(resolved(), options()));
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
          h('div', { class: 'row create-toolbar' }, field('Format', format), insertBtn, pictureInput),
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
        h('aside', { class: 'preview' }, h('div', { class: 'preview-head' }, h('strong', null, 'Preview'), previewNote), picBar, preview),
      ),
    );
    syncInsert();
    const handed = ctx.takeIncomingFiles();
    if (handed?.length) void importFile(handed[0]);
    schedule();
    return () => clearTimeout(timer);
  },
};
