import type { IconNode } from 'lucide';
import { Download, FileText, RefreshCw, ArrowRight, FileArchive, Image as ImageIcon } from 'lucide';
import { h, button, dropzone, icon, withBusy, formatBytes, select, toast } from '../lib/ui';
import { openPdf, download, zipOutputs, fileSize, type OutputFile, type PdfSource } from '../lib/pdf';

export type ToolGroup = 'Edit & sign' | 'Organize' | 'Convert' | 'Secure & info';

export interface AppContext {
  /** Switch to another tool, optionally handing it a PDF to start with. */
  openTool(id: string, file?: PdfSource): void;
  /** A PDF handed over from another tool (consumed on mount). */
  takeIncoming(): PdfSource | undefined;
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
  /** Whether this tool takes a single PDF as its input (enables "Continue with…"). */
  acceptsPdf?: boolean;
  mount(el: HTMLElement, ctx: AppContext): void | (() => void);
}

/** Shows produced files with download buttons and a "continue with another tool" picker. */
export function resultsPanel(ctx: AppContext) {
  const el = h('section', { class: 'results', hidden: true });

  function show(files: OutputFile[], note?: string) {
    el.replaceChildren();
    el.hidden = false;
    const list = h('div', { class: 'result-list' });
    for (const f of files) list.append(resultRow(f, ctx));
    const header = h(
      'div',
      { class: 'results-head' },
      h('h3', null, files.length === 1 ? 'Your file is ready' : `${files.length} files ready`),
      files.length > 1
        ? button(
            'Download all (.zip)',
            async () => {
              const zip = await withBusy('Zipping…', () => zipOutputs(files, 'pdf-maker-files'));
              if (zip) download(zip);
            },
            { icon: FileArchive, kind: 'primary' },
          )
        : null,
    );
    el.append(header);
    if (note) el.append(h('p', { class: 'muted' }, note));
    el.append(list);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  return { el, show, hide: () => (el.hidden = true) };
}

function resultRow(f: OutputFile, ctx: AppContext) {
  const isPdf = f.type === 'application/pdf';
  const isImage = f.type.startsWith('image/');
  const row = h(
    'div',
    { class: 'result-row' },
    icon(isPdf ? FileText : isImage ? ImageIcon : FileArchive, 20),
    h('div', { class: 'result-name' }, h('strong', null, f.name), h('span', null, formatBytes(fileSize(f)))),
  );
  if (isPdf) {
    const next = ctx.tools.filter((t) => t.acceptsPdf);
    const pick = select<string>([['', 'Continue with…'], ...next.map((t): [string, string] => [t.id, t.title])], '', async (id) => {
      if (!id) return;
      const bytes = f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data;
      ctx.openTool(id, { name: f.name, bytes, pageCount: 0 });
    });
    pick.classList.add('continue');
    pick.setAttribute('aria-label', 'Continue with another tool');
    row.append(pick);
  }
  row.append(button('Download', () => download(f), { icon: Download, kind: 'primary' }));
  return row;
}

/**
 * Single-PDF input: a drop zone that turns into a file chip once loaded.
 * Picks up a PDF handed over from another tool automatically.
 */
export function pdfInput(ctx: AppContext, onLoad: (src: PdfSource | null) => void) {
  const el = h('div', { class: 'pdf-input' });
  let current: PdfSource | null = null;

  const zone = dropzone({
    accept: 'application/pdf,.pdf',
    title: 'Choose a PDF or drop it here',
    hint: 'Files never leave your computer',
    icon: FileText,
    onFiles: ([file]) => load(file),
  });

  async function load(file: File | { name: string; bytes: Uint8Array }) {
    const src = await withBusy('Opening PDF…', () => openPdf(file));
    if (!src) return;
    set(src);
  }

  function set(src: PdfSource | null) {
    current = src;
    el.replaceChildren();
    if (!src) {
      el.append(zone);
    } else {
      el.append(
        h(
          'div',
          { class: 'file-chip' },
          icon(FileText, 20),
          h('div', null, h('strong', null, src.name), h('span', null, `${src.pageCount} page${src.pageCount === 1 ? '' : 's'} · ${formatBytes(src.bytes.byteLength)}`)),
          button('Change file', () => set(null), { icon: RefreshCw, kind: 'ghost' }),
        ),
      );
    }
    onLoad(src);
  }

  set(null);
  const incoming = ctx.takeIncoming();
  if (incoming) {
    if (incoming.pageCount) set(incoming);
    else void load(incoming);
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
