import type { IconNode } from 'lucide';
import { Download, FileText, RefreshCw, ArrowRight, FileArchive, Image as ImageIcon, Check, ExternalLink } from 'lucide';
import { h, button, dropzone, icon, withBusy, formatBytes, toast } from '../lib/ui';
import { openPdf, download, zipOutputs, fileSize, type OutputFile, type PdfSource } from '../lib/pdf';
import { activeDoc, currentSource, getDoc, openDocument, replaceDocument, type OpenDoc } from '../lib/documents';

export type ToolGroup = 'Edit & sign' | 'Organize' | 'Convert' | 'Secure & info';

export interface AppContext {
  /**
   * Switch to another tool, optionally handing it a PDF (which also opens in a
   * tab) or plain files it picks up with takeIncomingFiles.
   */
  openTool(id: string, file?: PdfSource, files?: File[]): void;
  /** A PDF handed over from another tool (consumed on mount). */
  takeIncoming(): PdfSource | undefined;
  /** Is a specific PDF waiting to be opened? Does not consume it. */
  hasIncoming(): boolean;
  /** Files handed over from outside the app, e.g. a File Explorer right-click. */
  takeIncomingFiles(): File[] | undefined;
  /** The open tab this tool is working on, so its result can be applied back. */
  bindDoc(id: string | null): void;
  boundDoc(): string | null;
  tools: Tool[];
}

export interface Tool {
  id: string;
  title: string;
  blurb: string;
  icon: IconNode;
  group: ToolGroup;
  /** Full-bleed tools (like the editor) get the whole main area. */
  wide?: boolean;
  /** Whether this tool can take a PDF handed to it. */
  acceptsPdf?: boolean;
  /**
   * Mounted once and kept while you visit other tools, so its state survives.
   * Its element gets a `tool-show` event each time it comes back on screen.
   */
  keepAlive?: boolean;
  mount(el: HTMLElement, ctx: AppContext): void | (() => void);
}

/** Shows produced files with download buttons, and lets a PDF go back into its tab or a new one. */
export function resultsPanel(ctx: AppContext) {
  const el = h('section', { class: 'results', hidden: true });

  function show(files: OutputFile[], note?: string) {
    el.replaceChildren();
    el.hidden = false;
    const list = h('div', { class: 'result-list' });
    // A single PDF made from an open tab can replace that tab's file.
    const target = files.length === 1 && files[0].type === 'application/pdf' ? getDoc(ctx.boundDoc()) : null;
    for (const f of files) list.append(resultRow(f, target));
    const header = h(
      'div',
      { class: 'results-head' },
      h('h3', null, files.length === 1 ? 'Your file is ready' : `${files.length} files ready`),
      files.length > 1
        ? button(
            'Download all (.zip)',
            async () => {
              const zip = await withBusy('Zipping…', () => zipOutputs(files, 'folio-files'));
              if (zip) download(zip);
            },
            { icon: FileArchive, kind: 'primary' },
          )
        : null,
    );
    el.append(header);
    if (note) el.append(h('p', { class: 'muted' }, note));
    if (target) {
      el.append(
        h(
          'p',
          { class: 'muted small' },
          `Apply puts this into the open “${target.src.name}” tab so you can keep working on it. Nothing is written to disk until you press Save.`,
        ),
      );
    }
    el.append(list);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  return { el, show, hide: () => (el.hidden = true) };
}

function resultRow(f: OutputFile, target: OpenDoc | null) {
  const isPdf = f.type === 'application/pdf';
  const isImage = f.type.startsWith('image/');
  const row = h(
    'div',
    { class: 'result-row' },
    icon(isPdf ? FileText : isImage ? ImageIcon : FileArchive, 20),
    h('div', { class: 'result-name' }, h('strong', null, f.name), h('span', null, formatBytes(fileSize(f)))),
  );
  const bytesOf = async () => (f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data);
  if (isPdf && target) {
    row.append(
      button(
        'Apply',
        async () => {
          const src = await withBusy('Applying…', async () => openPdf({ name: target.src.name, bytes: await bytesOf() }));
          if (!src || !getDoc(target.id)) return;
          replaceDocument(target.id, src);
          toast(`Applied to “${target.src.name}”. Press Save when you want to keep it.`, 'success');
        },
        { icon: Check, kind: 'primary', title: `Replace the file in the “${target.src.name}” tab with this result` },
      ),
    );
  }
  if (isPdf) {
    row.append(
      button(
        'Open in new tab',
        async () => {
          const src = await withBusy('Opening…', async () => openPdf({ name: f.name, bytes: await bytesOf() }));
          if (!src) return;
          openDocument(src);
          location.hash = '#/editor';
        },
        { icon: ExternalLink, kind: 'ghost' },
      ),
    );
  }
  row.append(button('Download', () => download(f), { icon: Download, kind: isPdf && target ? 'default' : 'primary' }));
  return row;
}

export interface PdfInputOptions {
  /** Start with the file in the active tab. Default true. */
  useOpen?: boolean;
  /** A file picked here also opens in a tab. Default true. */
  addToTabs?: boolean;
  /** Results from this tool can be applied back to the tab. Default true. */
  bind?: boolean;
}

/**
 * Single-PDF input. Starts with the file in the active tab, so a tool works on
 * the document you have open; a file picked here opens in a tab of its own.
 */
export function pdfInput(ctx: AppContext, onLoad: (src: PdfSource | null) => void, opts: PdfInputOptions = {}) {
  const { useOpen = true, addToTabs = true, bind = true } = opts;
  const el = h('div', { class: 'pdf-input' });
  let current: PdfSource | null = null;

  const zone = dropzone({
    accept: 'application/pdf,.pdf',
    title: 'Choose a PDF or drop it here',
    hint: addToTabs ? 'It opens in a tab at the top. Files never leave your computer.' : 'Files never leave your computer',
    icon: FileText,
    onFiles: ([file]) => load(file),
  });

  async function load(file: File | { name: string; bytes: Uint8Array }) {
    const src = await withBusy('Opening PDF…', () => openPdf(file));
    if (!src) return;
    if (!addToTabs) return set(src);
    const d = openDocument(src);
    // Opening a tab can swap this whole tool for a fresh one that already has it.
    if (!el.isConnected) return;
    const cur = await currentSource(d.id);
    if (bind) ctx.bindDoc(d.id);
    set(cur);
  }

  function set(src: PdfSource | null) {
    current = src;
    el.replaceChildren();
    if (!src) {
      el.append(zone);
    } else {
      const tab = getDoc(src.docId);
      const meta = `${src.pageCount} page${src.pageCount === 1 ? '' : 's'} · ${formatBytes(src.bytes.byteLength)}`;
      el.append(
        h(
          'div',
          { class: 'file-chip' },
          icon(FileText, 20),
          h(
            'div',
            null,
            h('strong', null, src.name),
            h('span', null, tab ? `${meta} · from your open tab${tab.dirty ? ', unsaved changes included' : ''}` : meta),
          ),
          button('Use a different file', () => set(null), { icon: RefreshCw, kind: 'ghost' }),
        ),
      );
    }
    onLoad(src);
  }

  set(null);
  // A hand-off is an open tab by now; don't leave it for a later tool to find.
  ctx.takeIncoming();
  const handed = ctx.takeIncomingFiles();
  const open = activeDoc();
  if (handed?.length) {
    queueMicrotask(() => void load(handed[0]));
  } else if (useOpen && open) {
    if (bind) ctx.bindDoc(open.id);
    // After the tool has finished mounting, so its own setup runs first.
    queueMicrotask(async () => {
      const cur = await withBusy('Opening PDF…', () => currentSource(open.id));
      if (cur && el.isConnected) set(cur);
    });
  }
  return { el, get: () => current, set };
}

/**
 * The common "one PDF in → options → run → files out" layout.
 * `options` builds the settings panel for the loaded file; `run` produces the output.
 */
export function simpleTool(
  el: HTMLElement,
  ctx: AppContext,
  spec: {
    actionLabel: string;
    actionIcon?: IconNode;
    options: (src: PdfSource) => HTMLElement | Promise<HTMLElement>;
    run: (src: PdfSource, progress: (t: string) => void) => Promise<OutputFile[] | { files: OutputFile[]; note?: string }>;
    busyLabel?: string;
  },
) {
  const results = resultsPanel(ctx);
  const body = h('div', { class: 'tool-body', hidden: true });
  const input = pdfInput(ctx, async (src) => {
    results.hide();
    body.replaceChildren();
    body.hidden = !src;
    if (!src) return;
    const opts = await spec.options(src);
    body.append(
      opts,
      h(
        'div',
        { class: 'actions' },
        button(
          spec.actionLabel,
          async () => {
            const out = await withBusy(spec.busyLabel ?? 'Working…', (p) => spec.run(src, p));
            if (!out) return;
            const res = Array.isArray(out) ? { files: out } : out;
            if (!res.files.length) return toast('Nothing to output.', 'error');
            results.show(res.files, res.note);
          },
          { icon: spec.actionIcon ?? ArrowRight, kind: 'primary' },
        ),
      ),
    );
  });
  el.append(input.el, body, results.el);
}

export function panel(...children: (Node | null | false)[]) {
  return h('div', { class: 'panel' }, children);
}

export function row(...children: (Node | null | false)[]) {
  return h('div', { class: 'row' }, children);
}
