import {
  FilePen,
  MousePointer2,
  Type,
  TextCursorInput,
  Pencil,
  Highlighter,
  Square,
  Eraser,
  MoveUpRight,
  Minus,
  Check,
  X,
  ImagePlus,
  Signature,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Save,
  Trash2,
  Bold,
  Italic,
  Sparkles,
  Copy,
  Plus,
  FileText,
} from 'lucide';
import { degrees, rgb, BlendMode, LineCapStyle, PDFTextField, PDFCheckBox, type PDFPage } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { h, button, icon, withBusy, toast, select, numberInput, confirmDiscard } from '../lib/ui';
import { setUnsavedGuard, clearUnsavedGuard, type UnsavedGuard } from '../lib/unsaved';
import { loadLib, loadJs, openPdf, renderPage, pdfOutput, baseName, hexToRgb01, visualFrame, pdfjs, type PdfSource } from '../lib/pdf';
import { FontCache, FONT_OPTIONS, CSS_FONT, baselineEm, safeText, type FontFamily } from '../lib/fonts';
import { signatureDialog } from './signature';
import { fromWidgets, fromText, fromCanvas, mergeSuggestions, overlap, type Suggestion } from '../lib/detect';
import { rememberEntry, suggestEntries, forgetEntry, forgetAll } from '../lib/autofill';
import { loadSession, saveSession, getSessionFile, clearSession, type SessionTab, type SessionInput } from '../lib/session';
import { pdfInput, resultsPanel, type Tool } from './common';

/* ---------- annotation model (visual page coordinates, points, origin top-left) ---------- */

interface Base {
  id: number;
  page: number;
}
interface TextAnn extends Base {
  type: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  /** Real form field this text fills (saved into the field, not drawn). */
  field?: string;
  /** Label next to it ("name"), used to remember entries for autofill. */
  label?: string;
}
interface RectAnn extends Base {
  type: 'rect';
  mode: 'highlight' | 'whiteout' | 'box';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  width: number;
}
interface InkAnn extends Base {
  type: 'ink';
  paths: [number, number][][];
  color: string;
  width: number;
  arrow?: boolean;
  /** Set on the stamped marks, so Size and Thickness can be changed after the fact. */
  shape?: 'check' | 'cross';
  /** Nominal size of a stamped mark, kept in step with its paths. */
  size?: number;
  /** Checkbox form field this check mark ticks. */
  field?: string;
}
interface ImageAnn extends Base {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src: string; // data URL (png or jpeg)
}
type Ann = TextAnn | RectAnn | InkAnn | ImageAnn;

type ToolId = 'select' | 'text' | 'edittext' | 'draw' | 'highlight' | 'whiteout' | 'box' | 'line' | 'arrow' | 'check' | 'cross';

const TOOLS: { id: ToolId; label: string; icon: Parameters<typeof icon>[0]; key?: string }[] = [
  { id: 'select', label: 'Select & move (V)', icon: MousePointer2, key: 'v' },
  { id: 'text', label: 'Add text (T)', icon: Type, key: 't' },
  { id: 'edittext', label: 'Edit existing text (E)', icon: TextCursorInput, key: 'e' },
  { id: 'draw', label: 'Draw (D)', icon: Pencil, key: 'd' },
  { id: 'highlight', label: 'Highlight (H)', icon: Highlighter, key: 'h' },
  { id: 'whiteout', label: 'White-out / erase (W)', icon: Eraser, key: 'w' },
  { id: 'box', label: 'Rectangle (R)', icon: Square, key: 'r' },
  { id: 'line', label: 'Line (L)', icon: Minus, key: 'l' },
  { id: 'arrow', label: 'Arrow (A)', icon: MoveUpRight, key: 'a' },
  { id: 'check', label: 'Check mark', icon: Check },
  { id: 'cross', label: 'Cross mark', icon: X },
];

interface Style {
  color: string;
  size: number;
  /** Stroke weight of the stamped marks, set apart from their size. */
  weight: number;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

/** How thick a mark's stroke may get, as a share of its size. */
const MIN_WEIGHT = 0.04;
const MAX_WEIGHT = 0.3;

const clampWeight = (w: number) => Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w || MIN_WEIGHT));

/** The strokes of a check or cross mark, centred on (cx, cy) at the given size. */
function shapePaths(shape: 'check' | 'cross', cx: number, cy: number, size: number): [number, number][][] {
  const s = size;
  return shape === 'check'
    ? [[[cx - s * 0.5, cy], [cx - s * 0.15, cy + s * 0.35], [cx + s * 0.5, cy - s * 0.4]]]
    : [
        [[cx - s * 0.4, cy - s * 0.4], [cx + s * 0.4, cy + s * 0.4]],
        [[cx - s * 0.4, cy + s * 0.4], [cx + s * 0.4, cy - s * 0.4]],
      ];
}

const DEFAULT_STYLE: Record<string, Partial<Style>> = {
  text: { color: '#111111', size: 14 },
  edittext: { color: '#111111', size: 14 },
  draw: { color: '#1f4fd1', size: 2 },
  highlight: { color: '#ffe14d' },
  whiteout: { color: '#ffffff' },
  box: { color: '#d9342b', size: 2 },
  line: { color: '#d9342b', size: 2 },
  arrow: { color: '#d9342b', size: 2 },
  check: { color: '#1a7f37', size: 18, weight: 0.125 },
  cross: { color: '#d9342b', size: 18, weight: 0.125 },
};

/** pdf.js builds and owns the selectable text spans; we only hold on to it. */
type TextLayerInstance = InstanceType<typeof pdfjs.TextLayer>;

interface PageView {
  index: number;
  proxy: PDFPageProxy;
  width: number; // visual size in points
  height: number;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  layer: HTMLElement;
  /** Invisible copy of the page's own text, so it can be selected and copied. */
  text: HTMLElement;
  textLayer: TextLayerInstance | null;
  renderedZoom: number;
  rendering: boolean;
  textItems?: { x: number; y: number; w: number; size: number; str: string; family: FontFamily }[];
  suggestions?: Suggestion[];
  detecting?: boolean;
}

export const editorTool: Tool = {
  id: 'editor',
  title: 'Edit & sign',
  blurb: 'Add or change text, draw, highlight, white-out, insert images and sign.',
  icon: FilePen,
  group: 'Edit & sign',
  wide: true,
  acceptsPdf: true,
  mount(root, ctx) {
    let src: PdfSource | null = null;
    let pages: PageView[] = [];
    let anns: Ann[] = [];
    let nextId = 1;
    let tool: ToolId = 'select';
    let selectedId: number | null = null;
    let editingId: number | null = null;
    let zoom = 1;
    let dirty = false;
    let undoStack: Ann[][] = [];
    let redoStack: Ann[][] = [];
    const styles: Record<string, Style> = {};
    const styleFor = (t: string): Style => (styles[t] ??= { color: '#111111', size: 14, weight: 0.125, family: 'helvetica', bold: false, italic: false, ...DEFAULT_STYLE[t] });

    const results = resultsPanel(ctx);
    const scroller = h('div', { class: 'ed-scroll' });
    let pagesEl: HTMLElement = h('div', { class: 'ed-pages' });
    let observer: IntersectionObserver | null = null;

    /* ---------- toolbar ---------- */
    const toolButtons = new Map<ToolId, HTMLButtonElement>();
    const toolGroup = h(
      'div',
      { class: 'ed-tools', role: 'toolbar', 'aria-label': 'Editing tools' },
      TOOLS.map((t) => {
        const b = h('button', { type: 'button', class: 'tool-btn', title: t.label, 'aria-label': t.label, onclick: () => setTool(t.id) }, icon(t.icon, 18));
        toolButtons.set(t.id, b);
        return b;
      }),
      h('span', { class: 'sep' }),
      h('button', { type: 'button', class: 'tool-btn', title: 'Insert image', 'aria-label': 'Insert image', onclick: () => imageInput.click() }, icon(ImagePlus, 18)),
      h('button', { type: 'button', class: 'tool-btn', title: 'Add signature', 'aria-label': 'Add signature', onclick: () => addSignature() }, icon(Signature, 18)),
    );
    const imageInput = h('input', {
      type: 'file',
      accept: 'image/*',
      hidden: true,
      onchange: async () => {
        const f = imageInput.files?.[0];
        imageInput.value = '';
        if (f) placeImage(await fileToPngOrJpegDataUrl(f));
      },
    }) as HTMLInputElement;

    // Property controls (apply to the selected annotation, or to the next one created).
    const colorInput = h('input', { type: 'color', value: '#111111', title: 'Color', 'aria-label': 'Color' }) as HTMLInputElement;
    const sizeInput = numberInput(14, { min: 1, max: 200 });
    sizeInput.title = 'Size';
    sizeInput.setAttribute('aria-label', 'Size');
    const familySel = select<FontFamily>(FONT_OPTIONS, 'helvetica');
    familySel.setAttribute('aria-label', 'Font');
    const boldBtn = h('button', { type: 'button', class: 'tool-btn', title: 'Bold', 'aria-label': 'Bold', 'aria-pressed': 'false' }, icon(Bold, 16));
    const italicBtn = h('button', { type: 'button', class: 'tool-btn', title: 'Italic', 'aria-label': 'Italic', 'aria-pressed': 'false' }, icon(Italic, 16));
    const sizeLabel = h('span', { class: 'muted small ed-size-label' }, 'Size');
    // Stroke weight of a check or cross, kept apart from its size so a big mark
    // can still be drawn fine and a small one bold.
    const thickInput = h('input', {
      type: 'range',
      class: 'ed-thick',
      min: String(MIN_WEIGHT),
      max: String(MAX_WEIGHT),
      step: '0.005',
      value: '0.125',
      title: 'Thickness',
      'aria-label': 'Thickness',
    }) as HTMLInputElement;
    const thickLabel = h('span', { class: 'muted small ed-size-label' }, 'Thickness');
    const textProps = h('span', { class: 'ed-textprops' }, familySel, boldBtn, italicBtn);
    const deleteBtn = button(null, () => deleteSelected(), { icon: Trash2, title: 'Delete selected (Del)', kind: 'ghost', disabled: true });
    const allPagesBtn = button('All pages', () => copyToAllPages(), { icon: Copy, kind: 'ghost', title: 'Add the selected item to every page (e.g. initials)' });
    allPagesBtn.hidden = true;
    const props = h('div', { class: 'ed-props' }, colorInput, sizeLabel, sizeInput, thickLabel, thickInput, textProps, allPagesBtn, deleteBtn);

    const suggestBtn = h('button', {
      type: 'button',
      class: 'tool-btn suggest-btn',
      title: 'Show fill-in suggestions',
      'aria-label': 'Show fill-in suggestions',
      'aria-pressed': 'true',
      onclick: () => {
        showSuggestions = !showSuggestions;
        suggestBtn.setAttribute('aria-pressed', String(showSuggestions));
        pages.forEach(renderLayer);
      },
    });
    const undoBtn = button(null, () => undo(), { icon: Undo2, title: 'Undo (Ctrl+Z)', kind: 'ghost', disabled: true });
    const redoBtn = button(null, () => redo(), { icon: Redo2, title: 'Redo (Ctrl+Y)', kind: 'ghost', disabled: true });
    const zoomLabel = h('span', { class: 'zoom-label' }, '100%');
    const pageLabel = h('span', { class: 'muted small' });
    const bar = h(
      'div',
      { class: 'ed-bar' },
      toolGroup,
      props,
      h('span', { class: 'spacer' }),
      undoBtn,
      redoBtn,
      button('Save PDF', () => save(), { icon: Save, kind: 'primary' }),
      imageInput,
    );
    const viewPill = h(
      'div',
      { class: 'ed-view' },
      pageLabel,
      h('span', { class: 'sep' }),
      button(null, () => setZoom(zoom / 1.2), { icon: ZoomOut, title: 'Zoom out', kind: 'ghost' }),
      zoomLabel,
      button(null, () => setZoom(zoom * 1.2), { icon: ZoomIn, title: 'Zoom in', kind: 'ghost' }),
      button('Fit', () => fitWidth(), { kind: 'ghost', title: 'Fit to width' }),
    );
    const tabsEl = h('div', { class: 'ed-tabs', role: 'tablist', 'aria-label': 'Open documents' });
    const tabInput = h('input', {
      type: 'file',
      accept: 'application/pdf,.pdf',
      multiple: true,
      hidden: true,
      onchange: async () => {
        const files = [...(tabInput.files ?? [])];
        tabInput.value = '';
        for (const file of files) {
          const opened = await withBusy('Opening PDF…', () => openPdf(file));
          if (opened) await openDoc(opened);
        }
      },
    }) as HTMLInputElement;

    const hintText = h('span');
    const hint = h('div', { class: 'ed-hint' }, hintText, h('span', { class: 'spacer' }), suggestBtn);
    const workspace = h('div', { class: 'ed-workspace', hidden: true }, tabsEl, bar, hint, h('div', { class: 'ed-stage' }, scroller, viewPill), h('div', { class: 'ed-results' }, results.el));

    const launchFiles = ctx.takeIncomingFiles();
    // Recent, Open file, a dropped PDF or an Explorer right-click all name a
    // document. Asking for one file should show that file, not last time's
    // tabs, so the saved ones are carried along unopened instead.
    const wantsOneFile = !!launchFiles?.length || ctx.hasIncoming();
    const input = pdfInput(ctx, (s) => void openDoc(s));
    void (async () => {
      if (wantsOneFile) await carrySession();
      else await restoreSession();
      for (const file of launchFiles ?? []) {
        const opened = await withBusy('Opening PDF…', () => openPdf(file));
        if (opened) await openDoc(opened);
      }
    })();
    const intro = h('div', { class: 'ed-intro' }, input.el);
    scroller.addEventListener('dragover', (e) => e.preventDefault());
    scroller.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const file of [...(e.dataTransfer?.files ?? [])].filter((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf')) {
        const opened = await withBusy('Opening PDF…', () => openPdf(file));
        if (opened) await openDoc(opened);
      }
    });
    root.append(intro, workspace);

    /* ---------- open documents (tabs) ---------- */

    /** One open document: its pages, edits, history and view state. */
    interface DocState {
      src: PdfSource;
      js: PDFDocumentProxy;
      pages: PageView[];
      anns: Ann[];
      nextId: number;
      selectedId: number | null;
      zoom: number;
      dirty: boolean;
      undoStack: Ann[][];
      redoStack: Ann[][];
      lastSnap: string;
      pagesEl: HTMLElement;
      observer: IntersectionObserver | null;
      scrollTop: number;
      fileId: string;
    }
    const docs: DocState[] = [];
    let activeDoc = -1;

    function renderTabs() {
      tabsEl.replaceChildren(
        ...docs.map((d, i) =>
          h(
            'div',
            {
              class: `ed-tab${i === activeDoc ? ' active' : ''}`,
              role: 'tab',
              tabindex: 0,
              'aria-selected': String(i === activeDoc),
              title: d.src.name,
              onclick: () => switchDoc(i),
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  switchDoc(i);
                }
              },
              onauxclick: (e: MouseEvent) => e.button === 1 && void closeDoc(i),
            },
            icon(FileText, 14),
            h('span', { class: 'ed-tab-name' }, d.src.name),
            d.dirty ? h('span', { class: 'ed-tab-dot', title: 'Unsaved edits' }) : null,
            h(
              'button',
              {
                type: 'button',
                class: 'ed-tab-close',
                title: 'Close',
                'aria-label': `Close ${d.src.name}`,
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  void closeDoc(i);
                },
              },
              icon(X, 13),
            ),
          ),
        ),
        h('button', { type: 'button', class: 'ed-tab-add', title: 'Open another PDF', 'aria-label': 'Open another PDF', onclick: () => tabInput.click() }, icon(Plus, 16)),
        tabInput,
      );
      tabsEl.hidden = !docs.length;
    }

    /** Copy the live editing state back into the active document. */
    function captureActive() {
      const d = docs[activeDoc];
      if (!d) return;
      finishEditing();
      Object.assign(d, { pages, anns, nextId, selectedId, zoom, dirty, undoStack, redoStack, lastSnap, pagesEl, observer, scrollTop: scroller.scrollTop });
    }

    function activate(i: number) {
      const d = docs[i];
      if (!d) return;
      activeDoc = i;
      src = d.src;
      pages = d.pages;
      anns = d.anns;
      nextId = d.nextId;
      selectedId = d.selectedId;
      zoom = d.zoom;
      dirty = d.dirty;
      undoStack = d.undoStack;
      redoStack = d.redoStack;
      lastSnap = d.lastSnap;
      observer = d.observer;
      pagesEl = d.pagesEl;
      docs.forEach((o) => (o.pagesEl.hidden = o !== d));
      editingId = null;
      editingEl = null;
      autofillEl = null;
      scroller.scrollTop = d.scrollTop;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      pages.forEach(layoutPage);
      pages.filter(isVisible).forEach((p) => void draw(p));
      pages.forEach(renderLayer);
      renderTabs();
      updateHistoryButtons();
      updateSuggestButton();
      updatePageLabel();
      syncProps();
      results.hide();
    }

    function switchDoc(i: number) {
      if (i === activeDoc || !docs[i]) return;
      captureActive();
      activate(i);
      void rememberSession();
    }

    /**
     * Tabs stay open until the user closes them: the open documents and their
     * unsaved edits are stored on this computer and restored on the next start.
     */
    const storedFiles = new Set<string>();
    let sessionTimer = 0;
    let restoring = false;
    /** Saved tabs this window deliberately did not open, kept so they survive. */
    let carriedTabs: SessionTab[] = [];

    /**
     * Remember the stored tabs without opening any of them, so writing the
     * session later adds to them rather than replacing them.
     */
    async function carrySession() {
      const saved = await loadSession();
      carriedTabs = saved?.tabs ?? [];
      // Their bytes are already on disk; never rewrite them.
      for (const t of carriedTabs) storedFiles.add(t.fileId);
    }
    /**
     * @param immediate write now instead of after the usual short delay
     * @param allowClear wipe the stored session when nothing is open; only the
     *   user closing the last tab may do this, never a reload or a tool switch
     */
    function rememberSession(immediate = false, allowClear = false) {
      clearTimeout(sessionTimer);
      if (restoring) return Promise.resolve();
      const write = () => {
        const live: SessionInput[] = docs.map((d, i) =>
          i === activeDoc
            ? { fileId: d.fileId, name: d.src.name, bytes: d.src.bytes, anns: anns as unknown[], nextId, zoom, scrollTop: scroller.scrollTop, dirty }
            : { fileId: d.fileId, name: d.src.name, bytes: d.src.bytes, anns: d.anns as unknown[], nextId: d.nextId, zoom: d.zoom, scrollTop: d.scrollTop, dirty: d.dirty },
        );
        // A carried tab the user has since opened would otherwise come back twice.
        const open = new Set(live.map((t) => t.name));
        const carried = carriedTabs.filter((t) => !open.has(t.name));
        if (live.length || carried.length) return saveSession([...live, ...carried], activeDoc, storedFiles);
        return allowClear ? clearSession() : Promise.resolve();
      };
      if (immediate) return write();
      sessionTimer = window.setTimeout(() => void write(), 700);
      return Promise.resolve();
    }

    /** Reopen the documents that were open last time. */
    async function restoreSession() {
      const saved = await loadSession();
      if (!saved) return;
      restoring = true;
      await withBusy('Restoring your documents…', async (progress) => {
        for (const [i, tab] of saved.tabs.entries()) {
          progress(`Restoring ${tab.name} (${i + 1} of ${saved.tabs.length})…`);
          const bytes = await getSessionFile(tab.fileId);
          if (!bytes) continue;
          const src = await openPdf({ name: tab.name, bytes });
          if (!src) continue; // password prompt cancelled
          storedFiles.add(tab.fileId);
          await openDoc(src, {
            fileId: tab.fileId,
            anns: tab.anns as Ann[],
            nextId: tab.nextId,
            zoom: tab.zoom,
            scrollTop: tab.scrollTop,
            dirty: tab.dirty,
          });
        }
      });
      restoring = false;
      if (docs[saved.active]) switchDoc(saved.active);
      void rememberSession(true);
    }

    async function openDoc(s: PdfSource | null, restore?: { fileId: string; anns: Ann[]; nextId: number; zoom: number; scrollTop: number; dirty: boolean }) {
      if (!s) return;
      // Opening a document that is already open switches to it, with its
      // unsaved edits intact, rather than stacking an identical tab.
      if (!restore) {
        const already = docs.findIndex((d) => d.src.name === s.name && d.src.bytes.byteLength === s.bytes.byteLength);
        if (already >= 0) {
          switchDoc(already);
          return;
        }
      }
      captureActive();
      const d: DocState = {
        src: s,
        js: null as unknown as PDFDocumentProxy,
        pages: [],
        anns: [],
        nextId: 1,
        selectedId: null,
        zoom: 1,
        dirty: false,
        undoStack: [],
        redoStack: [],
        lastSnap: JSON.stringify([]),
        pagesEl: h('div', { class: 'ed-pages' }),
        observer: null,
        scrollTop: 0,
        fileId: restore?.fileId ?? `f${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
      scroller.append(d.pagesEl);
      docs.push(d);
      const ok = await withBusy('Loading pages…', async () => {
        d.js = await loadJs(s);
        d.observer = new IntersectionObserver(
          (entries) => entries.forEach((e) => e.isIntersecting && void draw(d.pages[+(e.target as HTMLElement).dataset.index!])),
          { root: scroller, rootMargin: '800px 0px' },
        );
        for (let i = 0; i < d.js.numPages; i++) {
          const proxy = await d.js.getPage(i + 1);
          const vp = proxy.getViewport({ scale: 1 });
          const canvas = h('canvas');
          const layer = h('div', { class: 'ed-layer' });
          const text = h('div', { class: 'ed-text' });
          // Text sits under the annotation layer, which steps out of the way
          // (pointer-events: none) whenever the Select tool is active.
          const el = h('div', { class: 'ed-page', 'data-index': String(i) }, canvas, text, layer, h('span', { class: 'ed-pagenum' }, `${i + 1} / ${d.js.numPages}`));
          const pv: PageView = { index: i, proxy, width: vp.width, height: vp.height, el, canvas, layer, text, textLayer: null, renderedZoom: 0, rendering: false };
          d.pages.push(pv);
          d.pagesEl.append(el);
          d.observer.observe(el);
        }
        return true;
      });
      if (!ok) {
        // Loading failed: drop the half-open tab.
        d.pagesEl.remove();
        docs.splice(docs.indexOf(d), 1);
        renderTabs();
        return;
      }
      workspace.hidden = false;
      intro.hidden = true;
      activate(docs.indexOf(d));
      d.pages.forEach(bindLayer);
      if (restore) {
        anns = restore.anns;
        nextId = restore.nextId;
        dirty = restore.dirty;
        d.dirty = restore.dirty;
        lastSnap = JSON.stringify(anns);
        setZoom(restore.zoom);
        scroller.scrollTop = restore.scrollTop;
        pages.forEach(renderLayer);
        renderTabs();
      } else {
        fitWidth();
      }
      setTool('select');
      updatePageLabel();
      void rememberSession();
    }

    async function closeDoc(i: number) {
      const d = docs[i];
      if (!d) return;
      if (i === activeDoc) captureActive();
      if (
        d.dirty &&
        !(await confirmDiscard({
          title: 'Unsaved changes',
          message: `“${d.src.name}” has edits that haven’t been saved to a PDF yet.`,
          detail: 'Keep it open and use Save to write them out first.',
          confirm: 'Discard and close',
          cancel: 'Keep open',
        }))
      )
        return;
      for (const p of d.pages) p.textLayer?.cancel();
      await d.js?.loadingTask.destroy();
      d.observer?.disconnect();
      d.pagesEl.remove();
      docs.splice(i, 1);
      storedFiles.delete(d.fileId);
      void rememberSession(true, true);
      if (!docs.length) {
        activeDoc = -1;
        src = null;

        pages = [];
        anns = [];
        dirty = false;
        workspace.hidden = true;
        intro.hidden = false;
        input.set(null);
        renderTabs();
        return;
      }
      activate(Math.min(i, docs.length - 1));
    }

    /* ---------- fill-in suggestions (like Acrobat's Fill & Sign) ---------- */
    let showSuggestions = true;
    async function detectFields(p: PageView) {
      p.detecting = true;
      try {
        const items = await loadTextItems(p);
        const vp = p.proxy.getViewport({ scale: 1 });
        const annots = await p.proxy.getAnnotations().catch(() => []);
        p.suggestions = mergeSuggestions([
          ...fromWidgets(annots, (r) => [...vp.convertToViewportPoint(r[0], r[1]), ...vp.convertToViewportPoint(r[2], r[3])]),
          ...fromText(items, p.width),
          ...fromCanvas(p.canvas, p.width, items),
        ]);
      } catch (err) {
        console.warn('Field detection failed', err);
        p.suggestions = [];
      } finally {
        p.detecting = false;
      }
      renderLayer(p);
      updateSuggestButton();
    }

    /** Suggestions not yet filled in (nothing typed or ticked on top of them). */
    function openSuggestions(p: PageView) {
      const mine = anns.filter((a) => a.page === p.index && (a.type === 'text' || a.type === 'ink'));
      return (p.suggestions ?? []).filter((sg) => !mine.some((a) => overlap(sg, bbox(a)) > 0.2));
    }

    function fillSuggestion(p: PageView, sg: Suggestion) {
      finishEditing();
      const st = styleFor('text');
      if (sg.kind === 'check') {
        const sz = Math.max(6, Math.min(sg.w, sg.h)) * 0.75;
        const mark = styleFor('check');
        anns.push({
          id: nextId++,
          page: p.index,
          type: 'ink',
          shape: 'check',
          size: sz,
          paths: shapePaths('check', sg.x + sg.w / 2, sg.y + sg.h / 2, sz),
          color: '#111111',
          width: Math.max(0.5, sz * mark.weight),
          field: sg.field,
        });
        commit();
        renderLayer(p);
        return;
      }
      const size = Math.round(Math.max(7, Math.min(sg.baseline !== undefined ? 12 : sg.h * 0.62, 14)) * 2) / 2;
      const y = sg.baseline !== undefined ? sg.baseline - baselineEm(st.family) * size : sg.y + (sg.h - size * 1.2) / 2;
      const a: TextAnn = {
        id: nextId++,
        page: p.index,
        type: 'text',
        x: sg.x + 2,
        y,
        text: '',
        size,
        color: st.color,
        family: st.family,
        bold: st.bold,
        italic: st.italic,
        field: sg.field,
        label: sg.label,
      };
      anns.push(a);
      startEditing(a);
    }

    function updateSuggestButton() {
      const n = pages.reduce((sum, p) => sum + openSuggestions(p).length, 0);
      suggestBtn.replaceChildren(icon(Sparkles, 16), h('span', null, n ? `${n} to fill` : 'Fields'));
    }
    updateSuggestButton();

    function layoutPage(p: PageView) {
      p.el.style.width = `${p.width * zoom}px`;
      p.el.style.height = `${p.height * zoom}px`;
      p.layer.style.width = `${p.width}px`;
      p.layer.style.height = `${p.height}px`;
      p.layer.style.transform = `scale(${zoom})`;
      // The layer is scaled, so the selection chrome divides by this to keep a
      // steady size on screen whatever the zoom.
      p.layer.style.setProperty('--z', String(zoom));
      syncText(p);
    }

    /**
     * Keep the text layer at the current zoom. Always reads `zoom` rather than
     * a captured value: the canvas may still be rasterised at an older scale,
     * but the text has to line up with the page box as it is on screen now.
     */
    function syncText(p: PageView) {
      // pdf.js sizes the container off this and scales the spans with it.
      p.text.style.setProperty('--total-scale-factor', String(zoom));
      // update() re-measures every span against the new scale, which is what
      // keeps the selection boxes on the glyphs as the zoom changes.
      p.textLayer?.update({ viewport: p.proxy.getViewport({ scale: zoom }) });
    }

    const endOfContent = (p: PageView) => p.text.querySelector('.end-of-content');
    // A drag that ends outside the page still has to finish cleanly.
    const onPointerUp = () => {
      for (const d of docs) for (const p of d.pages) endOfContent(p)?.classList.remove('active');
    };
    document.addEventListener('pointerup', onPointerUp);

    /**
     * The page's own text, laid out invisibly over the canvas so it can be
     * selected and copied. Built once per page, then re-laid-out on zoom.
     */
    async function drawText(p: PageView) {
      if (p.textLayer) return syncText(p);
      p.text.style.setProperty('--total-scale-factor', String(zoom));
      try {
        const layer = new pdfjs.TextLayer({
          textContentSource: await p.proxy.getTextContent(),
          container: p.text,
          viewport: p.proxy.getViewport({ scale: zoom }),
        });
        p.textLayer = layer;
        await layer.render();
        p.text.append(h('div', { class: 'end-of-content' }));
        // The zoom may have moved on while the text was being built.
        syncText(p);
      } catch (err) {
        // A cancelled layer (page closed mid-render) is not worth reporting.
        if ((err as { name?: string })?.name !== 'AbortException') console.warn('Text layer failed', err);
      }
    }

    async function draw(p: PageView | undefined) {
      if (!p || p.rendering || Math.abs(p.renderedZoom - zoom) < 0.001) return;
      p.rendering = true;
      const z = zoom;
      try {
        const c = await renderPage(p.proxy, z);
        c.className = 'ed-canvas';
        p.canvas.replaceWith(c);
        p.canvas = c;
        p.renderedZoom = z;
        await drawText(p);
      } finally {
        p.rendering = false;
      }
      if (!p.suggestions && !p.detecting) void detectFields(p);
      if (Math.abs(z - zoom) > 0.001 && isVisible(p)) void draw(p);
    }

    function isVisible(p: PageView) {
      const r = p.el.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      return r.bottom > s.top - 800 && r.top < s.bottom + 800;
    }

    function setZoom(z: number) {
      const center = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
      zoom = Math.min(5, Math.max(0.25, z));
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      pages.forEach(layoutPage);
      scroller.scrollTop = center * scroller.scrollHeight;
      pages.filter(isVisible).forEach((p) => void draw(p));
    }

    function fitWidth() {
      const maxW = Math.max(...pages.map((p) => p.width), 1);
      setZoom(Math.min(2, (scroller.clientWidth - 48) / maxW));
    }

    function updatePageLabel() {
      const s = scroller.getBoundingClientRect();
      const mid = s.top + s.height / 3;
      const cur = pages.find((p) => p.el.getBoundingClientRect().bottom > mid);
      pageLabel.textContent = pages.length ? `Page ${(cur?.index ?? 0) + 1} of ${pages.length}` : '';
    }
    scroller.addEventListener('scroll', () => requestAnimationFrame(updatePageLabel), { passive: true });

    /* ---------- tools & properties ---------- */
    const HINTS: Record<ToolId, string> = {
      select: 'Drag over the page to select text, then Ctrl+C to copy (Ctrl+A selects it all). Click an item to select it; drag to move, drag any corner to resize (Shift stretches freely). Double-click text to edit.',
      text: 'Click anywhere on a page to type, or click a blue box to fill it in.',
      edittext: 'Click on existing text to replace it. The original is covered with white-out and you can retype it.',
      draw: 'Drag to draw freehand.',
      highlight: 'Drag over text to highlight it.',
      whiteout: 'Drag to cover content with a solid box (pick the color to match the background).',
      box: 'Drag to draw a rectangle.',
      line: 'Drag to draw a line.',
      arrow: 'Drag to draw an arrow.',
      check: 'Click to place a check mark. Set its size and thickness first, or resize it afterwards from any corner.',
      cross: 'Click to place a cross mark. Set its size and thickness first, or resize it afterwards from any corner.',
    };

    function setTool(t: ToolId) {
      finishEditing();
      tool = t;
      toolButtons.forEach((b, id) => b.classList.toggle('active', id === t));
      toolButtons.forEach((b, id) => b.setAttribute('aria-pressed', String(id === t)));
      hintText.textContent = HINTS[t];
      workspace.dataset.tool = t;
      if (t !== 'select') select_(null);
      syncProps();
      if (t === 'edittext') pages.forEach((p) => void loadTextItems(p));
    }

    /** Which tool's style does the property bar currently reflect? */
    function propTarget(): { ann?: Ann; style: Style; kind: string } {
      const ann = anns.find((a) => a.id === selectedId);
      if (ann) {
        const kind = ann.type === 'text' ? 'text' : ann.type === 'rect' ? ann.mode : ann.type === 'ink' ? (ann.shape ?? 'draw') : 'image';
        return { ann, style: styleFor(kind), kind };
      }
      return { style: styleFor(tool), kind: tool };
    }

    function syncProps() {
      const { ann, style, kind } = propTarget();
      const isText = kind === 'text' || kind === 'edittext';
      const isMark = kind === 'check' || kind === 'cross';
      colorInput.value = ann && 'color' in ann ? ann.color : style.color;
      const sizeVal =
        ann?.type === 'text' ? ann.size
        : isMark ? (ann?.type === 'ink' ? (ann.size ?? markSize(ann)) : style.size)
        : ann && 'width' in ann ? ann.width
        : style.size;
      sizeInput.value = String(Math.round(sizeVal * 10) / 10);
      sizeLabel.textContent = isText ? 'Font size' : isMark ? 'Size' : 'Thickness';
      const showSize = !['highlight', 'whiteout', 'image', 'select'].includes(kind) || (ann?.type === 'rect' && ann.mode === 'box');
      sizeInput.hidden = sizeLabel.hidden = !showSize;
      // Only the stamped marks separate weight from size; everything else has
      // just the one number.
      thickInput.hidden = thickLabel.hidden = !isMark;
      thickInput.value = String(ann?.type === 'ink' ? clampWeight(ann.width / Math.max(1, ann.size ?? markSize(ann))) : style.weight);
      colorInput.hidden = kind === 'image' || (kind === 'select' && !ann);
      textProps.hidden = !isText;
      const t = ann?.type === 'text' ? ann : null;
      familySel.value = t?.family ?? style.family;
      boldBtn.setAttribute('aria-pressed', String(t?.bold ?? style.bold));
      italicBtn.setAttribute('aria-pressed', String(t?.italic ?? style.italic));
      deleteBtn.disabled = !ann;
      allPagesBtn.hidden = !ann || pages.length < 2 || (ann.type === 'rect' && ann.mode === 'highlight');
    }

    function applyProp(fn: (s: Style, a?: Ann) => void) {
      const { ann, style } = propTarget();
      fn(style, ann);
      if (ann) {
        commit();
        renderLayer(pages[ann.page]);
      }
      syncProps();
    }
    colorInput.addEventListener('input', () =>
      applyProp((s, a) => {
        s.color = colorInput.value;
        if (a && 'color' in a) a.color = colorInput.value;
      }),
    );
    sizeInput.addEventListener('change', () =>
      applyProp((s, a) => {
        const v = Math.max(0.5, +sizeInput.value || 1);
        s.size = v;
        if (a?.type === 'text') a.size = v;
        else if (a?.type === 'ink' && a.shape) resizeMark(a, v);
        else if (a && 'width' in a) a.width = v;
      }),
    );
    // Live while dragging, so the weight can be judged against the page.
    thickInput.addEventListener('input', () =>
      applyProp((s, a) => {
        const v = clampWeight(+thickInput.value);
        s.weight = v;
        if (a?.type === 'ink' && a.shape) a.width = Math.max(0.5, (a.size ?? markSize(a)) * v);
      }),
    );
    familySel.addEventListener('change', () =>
      applyProp((s, a) => {
        s.family = familySel.value as FontFamily;
        if (a?.type === 'text') a.family = s.family;
      }),
    );
    boldBtn.addEventListener('click', () =>
      applyProp((s, a) => {
        s.bold = !(a?.type === 'text' ? a.bold : s.bold);
        if (a?.type === 'text') a.bold = s.bold;
      }),
    );
    italicBtn.addEventListener('click', () =>
      applyProp((s, a) => {
        s.italic = !(a?.type === 'text' ? a.italic : s.italic);
        if (a?.type === 'text') a.italic = s.italic;
      }),
    );

    /* ---------- history ---------- */
    const snapshot = () => anns.map((a) => (a.type === 'ink' ? { ...a, paths: a.paths.map((p) => [...p]) } : { ...a }));
    let lastSnap = JSON.stringify([]);
    function commit() {
      const json = JSON.stringify(anns);
      if (json === lastSnap) return;
      undoStack.push(JSON.parse(lastSnap));
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
      lastSnap = json;
      const was = dirty;
      dirty = true;
      updateHistoryButtons();
      if (!was) {
        if (docs[activeDoc]) docs[activeDoc].dirty = true;
        renderTabs();
      }
      void rememberSession();
    }
    function undo() {
      finishEditing();
      const prev = undoStack.pop();
      if (!prev) return;
      redoStack.push(snapshot());
      restore(prev);
    }
    function redo() {
      finishEditing();
      const next = redoStack.pop();
      if (!next) return;
      undoStack.push(snapshot());
      restore(next);
    }
    function restore(state: Ann[]) {
      anns = state;
      lastSnap = JSON.stringify(anns);
      if (!anns.some((a) => a.id === selectedId)) selectedId = null;
      pages.forEach(renderLayer);
      syncProps();
      updateHistoryButtons();
    }
    function updateHistoryButtons() {
      undoBtn.disabled = !undoStack.length;
      redoBtn.disabled = !redoStack.length;
    }

    /* ---------- rendering annotations into the overlay ---------- */
    let editingEl: HTMLElement | null = null;
    let autofillEl: HTMLElement | null = null;

    function renderLayer(p: PageView | undefined) {
      if (!p) return;
      p.layer.replaceChildren();
      if (showSuggestions) {
        for (const sg of openSuggestions(p)) {
          const el = h('div', {
            class: `suggest ${sg.kind}`,
            title: sg.kind === 'check' ? 'Click to tick' : 'Click to fill in',
            onpointerdown: (e: PointerEvent) => {
              if (tool !== 'select' && tool !== 'text') return;
              e.preventDefault();
              e.stopPropagation();
              fillSuggestion(p, sg);
            },
          });
          Object.assign(el.style, { left: `${sg.x}px`, top: `${sg.y}px`, width: `${sg.w}px`, height: `${sg.h}px` });
          p.layer.append(el);
        }
      }
      for (const a of anns.filter((x) => x.page === p.index)) {
        if (editingEl && a.id === editingId) {
          // Reuse the live contenteditable so typing isn't interrupted.
          styleTextEl(editingEl, a as TextAnn);
          p.layer.append(editingEl);
          continue;
        }
        p.layer.append(annElement(a));
      }
      const sel = anns.find((a) => a.id === selectedId && a.page === p.index);
      if (sel && sel.id !== editingId) p.layer.append(selectionBox(sel));
      if (editingEl && autofillEl && p.layer.contains(editingEl)) p.layer.append(autofillEl);
      updateSuggestButton();
    }

    function annElement(a: Ann): Element {
      switch (a.type) {
        case 'text': {
          const el = h('div', { class: 'ann ann-text', 'data-id': String(a.id) });
          el.textContent = a.text;
          styleTextEl(el, a);
          return el;
        }
        case 'rect': {
          const el = h('div', { class: `ann ann-rect ${a.mode}`, 'data-id': String(a.id) });
          Object.assign(el.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` });
          if (a.mode === 'box') el.style.border = `${a.width}px solid ${a.color}`;
          else el.style.background = a.color;
          return el;
        }
        case 'image': {
          const el = h('img', { class: 'ann ann-image', src: a.src, alt: '', draggable: 'false', 'data-id': String(a.id) });
          Object.assign(el.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` });
          return el;
        }
        case 'ink': {
          const NS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(NS, 'svg');
          svg.setAttribute('class', 'ann-svg');
          const d = inkPath(a);
          const hit = document.createElementNS(NS, 'path');
          hit.setAttribute('d', d);
          hit.setAttribute('class', 'ann ann-hit');
          hit.setAttribute('stroke-width', String(Math.max(a.width, 10)));
          hit.dataset.id = String(a.id);
          const path = document.createElementNS(NS, 'path');
          path.setAttribute('d', d);
          path.setAttribute('stroke', a.color);
          path.setAttribute('stroke-width', String(a.width));
          path.setAttribute('class', 'ann-stroke');
          svg.append(path, hit);
          return svg;
        }
      }
    }

    function styleTextEl(el: HTMLElement, a: TextAnn) {
      Object.assign(el.style, {
        left: `${a.x}px`,
        top: `${a.y}px`,
        fontSize: `${a.size}px`,
        color: a.color,
        fontFamily: CSS_FONT[a.family],
        fontWeight: a.bold ? '700' : '400',
        fontStyle: a.italic ? 'italic' : 'normal',
      });
    }

    /** The four corners, as [handle, the corner it pivots around]. */
    const HANDLES = [
      ['nw', 'se'],
      ['ne', 'sw'],
      ['sw', 'ne'],
      ['se', 'nw'],
    ] as const;
    type Corner = (typeof HANDLES)[number][0];

    function selectionBox(a: Ann) {
      const b = bbox(a);
      const pad = 3;
      const box = h('div', { class: 'sel-box', 'data-id': String(a.id) });
      Object.assign(box.style, { left: `${b.x - pad}px`, top: `${b.y - pad}px`, width: `${b.w + pad * 2}px`, height: `${b.h + pad * 2}px` });
      // Every kind of item resizes, drawings and marks included, from any corner.
      for (const [corner] of HANDLES) {
        box.append(h('div', { class: `sel-handle ${corner}`, 'data-handle': corner, title: 'Drag to resize (Shift to stretch freely)' }));
      }
      return box;
    }

    /* ---------- pointer interaction ---------- */
    type Drag =
      | { kind: 'move'; ann: Ann; start: [number, number]; orig: Ann; moved: boolean }
      | { kind: 'resize'; ann: Ann; start: [number, number]; orig: Ann; corner: Corner; box: { x: number; y: number; w: number; h: number } }
      | { kind: 'rect'; ann: RectAnn; start: [number, number] }
      | { kind: 'ink'; ann: InkAnn; start: [number, number] }
      | { kind: 'line'; ann: InkAnn; start: [number, number] };
    let drag: Drag | null = null;

    function bindLayer(p: PageView) {
      const pt = (e: PointerEvent): [number, number] => {
        const r = p.layer.getBoundingClientRect();
        return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom];
      };
      const hover = h('div', { class: 'text-hover', hidden: true });

      // With Select active the annotation layer lets pointer events through to
      // the text, so clicking blank page area has to clear the selection here.
      p.text.addEventListener('pointerdown', (e) => {
        if (tool !== 'select' || e.button !== 0) return;
        endOfContent(p)?.classList.add('active');
        finishEditing();
        select_(null);
      });

      p.layer.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const target = e.target as Element;
        if (editingEl && editingEl.contains(target)) return; // clicks inside the text being edited
        const [x, y] = pt(e);
        const hitId = Number((target.closest('[data-id]') as HTMLElement | null)?.dataset.id ?? NaN);
        const hitAnn = anns.find((a) => a.id === hitId);

        if (tool === 'select') {
          finishEditing();
          const handle = target.closest<HTMLElement>('.sel-handle');
          if (handle && hitAnn) {
            drag = { kind: 'resize', ann: hitAnn, start: [x, y], orig: cloneAnn(hitAnn), corner: (handle.dataset.handle ?? 'se') as Corner, box: bbox(hitAnn) };
          } else if (hitAnn) {
            select_(hitAnn.id);
            drag = { kind: 'move', ann: hitAnn, start: [x, y], orig: cloneAnn(hitAnn), moved: false };
          } else {
            select_(null);
            return;
          }
          p.layer.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }

        e.preventDefault();
        finishEditing();
        const st = styleFor(tool);
        switch (tool) {
          case 'text': {
            const a: TextAnn = { id: nextId++, page: p.index, type: 'text', x, y: y - st.size * 0.6, text: '', size: st.size, color: st.color, family: st.family, bold: st.bold, italic: st.italic };
            anns.push(a);
            startEditing(a);
            return;
          }
          case 'edittext':
            void replaceTextAt(p, x, y);
            return;
          case 'check':
          case 'cross': {
            const a: InkAnn = {
              id: nextId++,
              page: p.index,
              type: 'ink',
              shape: tool,
              size: st.size,
              paths: shapePaths(tool, x, y, st.size),
              color: st.color,
              width: Math.max(0.5, st.size * st.weight),
            };
            anns.push(a);
            select_(a.id, false);
            commit();
            renderLayer(p);
            return;
          }
          case 'draw': {
            const a: InkAnn = { id: nextId++, page: p.index, type: 'ink', paths: [[[x, y]]], color: st.color, width: st.size };
            anns.push(a);
            drag = { kind: 'ink', ann: a, start: [x, y] };
            break;
          }
          case 'line':
          case 'arrow': {
            const a: InkAnn = { id: nextId++, page: p.index, type: 'ink', paths: [[[x, y], [x, y]]], color: st.color, width: st.size, arrow: tool === 'arrow' };
            anns.push(a);
            drag = { kind: 'line', ann: a, start: [x, y] };
            break;
          }
          case 'highlight':
          case 'whiteout':
          case 'box': {
            const a: RectAnn = { id: nextId++, page: p.index, type: 'rect', mode: tool, x, y, w: 0, h: 0, color: st.color, width: st.size };
            anns.push(a);
            drag = { kind: 'rect', ann: a, start: [x, y] };
            break;
          }
        }
        p.layer.setPointerCapture(e.pointerId);
        renderLayer(p);
      });

      p.layer.addEventListener('pointermove', (e) => {
        const [x, y] = pt(e);
        if (tool === 'edittext' && !drag) {
          const item = textItemAt(p, x, y);
          if (item) {
            Object.assign(hover.style, { left: `${item.x - 1}px`, top: `${item.y - item.size}px`, width: `${item.w + 2}px`, height: `${item.size * 1.25}px` });
            hover.hidden = false;
            if (!hover.isConnected) p.layer.append(hover);
          } else hover.hidden = true;
        }
        if (!drag) return;
        const [sx, sy] = drag.start;
        const dx = x - sx;
        const dy = y - sy;
        switch (drag.kind) {
          case 'move':
            drag.moved ||= Math.abs(dx) + Math.abs(dy) > 1;
            Object.assign(drag.ann, translated(drag.orig, dx, dy));
            break;
          case 'resize':
            resize(drag.ann, drag.orig, drag.box, drag.corner, dx, dy, e.shiftKey);
            break;
          case 'rect':
            Object.assign(drag.ann, { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(dx), h: Math.abs(dy) });
            break;
          case 'ink': {
            const path = drag.ann.paths[0];
            const last = path[path.length - 1];
            if (Math.hypot(x - last[0], y - last[1]) > 0.8 / zoom) path.push([x, y]);
            break;
          }
          case 'line': {
            let [ex, ey] = [x, y];
            if (e.shiftKey) {
              // Snap to 45° angles.
              const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
              const len = Math.hypot(dx, dy);
              [ex, ey] = [sx + Math.cos(ang) * len, sy + Math.sin(ang) * len];
            }
            drag.ann.paths[0][1] = [ex, ey];
            break;
          }
        }
        renderLayer(p);
      });

      const end = () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (d.kind === 'rect' && (d.ann.w < 3 || d.ann.h < 3)) {
          // A click without dragging: make a sensibly sized box.
          d.ann.w = d.ann.mode === 'highlight' ? 120 : 100;
          d.ann.h = d.ann.mode === 'highlight' ? 16 : 60;
        }
        if (d.kind === 'line') {
          const [[x1, y1], [x2, y2]] = d.ann.paths[0];
          if (Math.hypot(x2 - x1, y2 - y1) < 3) d.ann.paths[0][1] = [x1 + 80, y1];
        }
        if (d.kind === 'ink' && d.ann.paths[0].length === 1) {
          const [x0, y0] = d.ann.paths[0][0];
          d.ann.paths[0].push([x0 + 0.1, y0 + 0.1]); // a dot
        }
        if (d.kind === 'rect' || d.kind === 'line') select_(d.ann.id, false);
        commit();
        renderLayer(p);
      };
      p.layer.addEventListener('pointerup', end);
      p.layer.addEventListener('pointercancel', end);
      p.layer.addEventListener('pointerleave', () => (hover.hidden = true));

      p.layer.addEventListener('dblclick', (e) => {
        const id = Number(((e.target as Element).closest('[data-id]') as HTMLElement | null)?.dataset.id ?? NaN);
        const a = anns.find((x) => x.id === id);
        if (a?.type === 'text') startEditing(a);
      });
      layoutPage(p);
    }

    /** Extent of a set of strokes, as [x, y, width, height]. */
    function span(paths: [number, number][][]) {
      const pts = paths.flat();
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
      return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0] as const;
    }

    /** A mark's size, for marks saved before the size was stored alongside. */
    function markSize(a: InkAnn) {
      const [, , w, hgt] = span(a.paths);
      // A cross spans 0.8 of its size; a check spans the full width.
      return Math.max(1, Math.max(w, hgt) / (a.shape === 'cross' ? 0.8 : 1));
    }

    /** Redraw a placed check or cross at a new size, without letting it wander. */
    function resizeMark(a: InkAnn, size: number) {
      if (!a.shape) return;
      const weight = clampWeight(a.width / Math.max(1, a.size ?? markSize(a)));
      const [ox, oy, ow, oh] = span(a.paths);
      const next = shapePaths(a.shape, 0, 0, size);
      const [nx, ny, nw, nh] = span(next);
      // Line the new strokes up on the old centre, whatever the shape's offsets.
      const dx = ox + ow / 2 - (nx + nw / 2);
      const dy = oy + oh / 2 - (ny + nh / 2);
      a.paths = next.map((path) => path.map(([px, py]) => [px + dx, py + dy] as [number, number]));
      a.size = size;
      a.width = Math.max(0.5, size * weight);
    }

    function cloneAnn(a: Ann): Ann {
      return a.type === 'ink' ? { ...a, paths: a.paths.map((p) => p.map((q) => [...q] as [number, number])) } : { ...a };
    }

    function translated(orig: Ann, dx: number, dy: number): Partial<Ann> {
      if (orig.type === 'ink') return { paths: orig.paths.map((p) => p.map(([x, y]) => [x + dx, y + dy] as [number, number])) };
      return { x: orig.x + dx, y: orig.y + dy };
    }

    /**
     * Drag a corner to resize. The opposite corner stays put, so the item grows
     * away from where it is pinned rather than jumping. Boxes stretch freely in
     * both directions; text, images, drawings and marks keep their proportions
     * unless Shift is held.
     */
    function resize(a: Ann, orig: Ann, box: { x: number; y: number; w: number; h: number }, corner: Corner, dx: number, dy: number, free: boolean) {
      const west = corner === 'nw' || corner === 'sw';
      const north = corner === 'nw' || corner === 'ne';
      // The corner being dragged moves; its opposite is the anchor.
      const anchorX = west ? box.x + box.w : box.x;
      const anchorY = north ? box.y + box.h : box.y;
      const MIN = 6;
      let w = Math.max(MIN, west ? box.w - dx : box.w + dx);
      let hgt = Math.max(MIN, north ? box.h - dy : box.h + dy);

      if (a.type === 'rect' && orig.type === 'rect') {
        // Highlights and white-out need to stretch to whatever they cover.
        a.w = w;
        a.h = hgt;
        a.x = west ? anchorX - w : anchorX;
        a.y = north ? anchorY - hgt : anchorY;
        return;
      }

      if (a.type === 'image' && orig.type === 'image') {
        if (!free) hgt = w * (box.h / Math.max(1, box.w)); // keep aspect (Shift = free)
        a.w = w;
        a.h = hgt;
        a.x = west ? anchorX - w : anchorX;
        a.y = north ? anchorY - hgt : anchorY;
        return;
      }

      if (a.type === 'text' && orig.type === 'text') {
        // Text has one size, so the width of the drag drives it.
        const k = Math.max(0.05, w / Math.max(1, box.w));
        a.size = Math.max(4, orig.size * k);
        a.x = west ? anchorX - box.w * k : anchorX;
        a.y = north ? anchorY - box.h * k : anchorY;
        syncProps();
        return;
      }

      if (a.type === 'ink' && orig.type === 'ink') {
        const kx = free ? w / Math.max(1, box.w) : Math.max(w / Math.max(1, box.w), hgt / Math.max(1, box.h));
        const ky = free ? hgt / Math.max(1, box.h) : kx;
        a.paths = orig.paths.map((path) => path.map(([px, py]) => [anchorX + (px - anchorX) * kx, anchorY + (py - anchorY) * ky] as [number, number]));
        // The stroke grows with the mark, so a big check isn't a hairline.
        const k = Math.min(kx, ky);
        a.width = Math.max(0.5, orig.width * k);
        if (orig.size) a.size = Math.max(1, orig.size * k);
        syncProps();
      }
    }

    function bbox(a: Ann): { x: number; y: number; w: number; h: number } {
      switch (a.type) {
        case 'text': {
          const el = pages[a.page]?.layer.querySelector<HTMLElement>(`.ann-text[data-id="${a.id}"]`);
          const lines = a.text.split('\n');
          const w = el?.offsetWidth || Math.max(...lines.map((l) => l.length)) * a.size * 0.55;
          return { x: a.x, y: a.y, w: Math.max(w, 8), h: lines.length * a.size * 1.2 };
        }
        case 'ink': {
          const pts = a.paths.flat();
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          const pad = a.width / 2 + (a.arrow ? a.width * 3 : 0);
          return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
        }
        default:
          return { x: a.x, y: a.y, w: a.w, h: a.h };
      }
    }

    function select_(id: number | null, rerender = true) {
      const prev = anns.find((a) => a.id === selectedId);
      selectedId = id;
      if (rerender) {
        if (prev) renderLayer(pages[prev.page]);
        const cur = anns.find((a) => a.id === id);
        if (cur && cur.page !== prev?.page) renderLayer(pages[cur.page]);
      }
      syncProps();
    }

    function deleteSelected() {
      const a = anns.find((x) => x.id === selectedId);
      if (!a) return;
      anns = anns.filter((x) => x.id !== a.id);
      selectedId = null;
      commit();
      renderLayer(pages[a.page]);
      syncProps();
    }

    /* ---------- text editing ---------- */
    function startEditing(a: TextAnn) {
      finishEditing();
      editingId = a.id;
      selectedId = a.id;
      const el = h('div', { class: 'ann ann-text editing', 'data-id': String(a.id), contenteditable: 'plaintext-only', spellcheck: 'true' });
      el.textContent = a.text;
      editingEl = el;

      // Autofill: offer things typed before (names, emails, addresses…), stored only on this computer.
      const drop = h('div', { class: 'autofill', role: 'listbox', hidden: true });
      autofillEl = drop;
      let options: string[] = [];
      let active = -1;
      const pick = (value: string) => {
        el.textContent = value;
        finishEditing();
      };
      const refresh = () => {
        options = suggestEntries(el.innerText, a.label).map((e) => e.value);
        active = -1;
        drop.hidden = !options.length;
        if (!options.length) return;
        drop.style.left = `${a.x}px`;
        drop.style.top = `${a.y + Math.max(el.offsetHeight, a.size * 1.2) + 4}px`;
        drop.style.transform = `scale(${1 / zoom})`;
        drop.replaceChildren(
          h('div', { class: 'autofill-head' }, 'Suggestions'),
          ...options.map((v, i) =>
            h(
              'div',
              { class: `autofill-item${i === active ? ' active' : ''}`, role: 'option', onpointerdown: (e: PointerEvent) => (e.preventDefault(), e.stopPropagation(), pick(v)) },
              h('span', null, v),
              h(
                'button',
                {
                  type: 'button',
                  class: 'mini',
                  title: 'Forget this entry',
                  'aria-label': `Forget ${v}`,
                  onpointerdown: (e: PointerEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    forgetEntry(v);
                    refresh();
                  },
                },
                icon(X, 12),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'autofill-forget',
              onpointerdown: (e: PointerEvent) => {
                e.preventDefault();
                e.stopPropagation();
                forgetAll();
                refresh();
              },
            },
            'Forget all remembered entries',
          ),
        );
      };
      const highlight = () => drop.querySelectorAll('.autofill-item').forEach((n, i) => n.classList.toggle('active', i === active));
      el.addEventListener('input', refresh);
      el.addEventListener('focus', refresh);

      renderLayer(pages[a.page]);
      el.addEventListener('keydown', (e) => {
        if (!drop.hidden && options.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          highlight();
        } else if (!drop.hidden && active >= 0 && (e.key === 'Enter' || e.key === 'Tab')) {
          e.preventDefault();
          pick(options[active]);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (!drop.hidden) drop.hidden = true;
          else finishEditing();
        }
        e.stopPropagation();
      });
      el.addEventListener('blur', () => setTimeout(() => editingId === a.id && finishEditing(), 0));
      // Focus right away so no keystrokes are lost to the tool shortcuts.
      el.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (document.activeElement !== el) el.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      });
      syncProps();
    }

    function finishEditing() {
      if (editingId === null || !editingEl) return;
      const a = anns.find((x) => x.id === editingId) as TextAnn | undefined;
      const text = editingEl.innerText.replace(/\n$/, '');
      editingId = null;
      editingEl = null;
      autofillEl = null;
      if (!a) return;
      if (!text.trim()) {
        anns = anns.filter((x) => x.id !== a.id);
        if (selectedId === a.id) selectedId = null;
      } else {
        a.text = text;
        rememberEntry(text, a.label);
      }
      commit();
      renderLayer(pages[a.page]);
      syncProps();
    }

    /* ---------- editing existing text ---------- */
    async function loadTextItems(p: PageView) {
      if (p.textItems) return p.textItems;
      const vp = p.proxy.getViewport({ scale: 1 });
      const content = await p.proxy.getTextContent();
      p.textItems = [];
      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str.trim()) continue;
        const it = raw as TextItem;
        const tx = pdfjs.Util.transform(vp.transform, it.transform);
        const size = Math.hypot(tx[2], tx[3]);
        const fam = (content.styles[it.fontName]?.fontFamily ?? '').toLowerCase();
        const family: FontFamily = fam.includes('mono') ? 'courier' : fam.includes('serif') && !fam.includes('sans') ? 'times' : 'helvetica';
        p.textItems.push({ x: tx[4], y: tx[5], w: it.width, size, str: it.str, family });
      }
      return p.textItems;
    }

    function textItemAt(p: PageView, x: number, y: number) {
      return p.textItems?.find((t) => x >= t.x - 1 && x <= t.x + t.w + 1 && y >= t.y - t.size && y <= t.y + t.size * 0.25);
    }

    async function replaceTextAt(p: PageView, x: number, y: number) {
      await loadTextItems(p);
      const item = textItemAt(p, x, y);
      if (!item) return toast('No text found there. Use “Add text” to type anywhere.');
      const bg = sampleBackground(p, item.x - 2, item.y - item.size * 0.5);
      const cover: RectAnn = { id: nextId++, page: p.index, type: 'rect', mode: 'whiteout', x: item.x - 1, y: item.y - item.size, w: item.w + 2, h: item.size * 1.25, color: bg, width: 0 };
      const st = styleFor('text');
      const text: TextAnn = {
        id: nextId++,
        page: p.index,
        type: 'text',
        x: item.x,
        y: item.y - baselineEm(item.family) * item.size,
        text: item.str,
        size: Math.round(item.size * 10) / 10,
        color: st.color,
        family: item.family,
        bold: false,
        italic: false,
      };
      anns.push(cover, text);
      p.textItems = p.textItems?.filter((t) => t !== item);
      startEditing(text);
    }

    function sampleBackground(p: PageView, x: number, y: number) {
      try {
        const ratio = p.canvas.width / (p.width * p.renderedZoom || 1);
        const ctx2 = p.canvas.getContext('2d', { willReadFrequently: true });
        const px = ctx2?.getImageData(Math.max(0, Math.round(x * p.renderedZoom * ratio)), Math.max(0, Math.round(y * p.renderedZoom * ratio)), 1, 1).data;
        if (px && px[3] > 0) return `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      } catch {
        /* fall back to white */
      }
      return '#ffffff';
    }

    /* ---------- images & signatures ---------- */
    function currentPage() {
      const s = scroller.getBoundingClientRect();
      return pages.find((p) => p.el.getBoundingClientRect().bottom > s.top + s.height / 3) ?? pages[0];
    }

    function placeImage(dataUrl: string, maxW = 200) {
      const img = new Image();
      img.onload = () => {
        const p = currentPage();
        if (!p) return;
        const w = Math.min(maxW, img.naturalWidth * 0.75, p.width * 0.8);
        const hgt = w * (img.naturalHeight / img.naturalWidth);
        // Center in the visible part of the page.
        const r = p.el.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        const visTop = Math.max(0, (s.top - r.top) / zoom);
        const visBottom = Math.min(p.height, (s.bottom - r.top) / zoom);
        const y = Math.max(0, Math.min(p.height - hgt, (visTop + visBottom) / 2 - hgt / 2));
        const a: ImageAnn = { id: nextId++, page: p.index, type: 'image', x: (p.width - w) / 2, y, w, h: hgt, src: dataUrl };
        anns.push(a);
        setTool('select');
        select_(a.id, false);
        commit();
        renderLayer(p);
      };
      img.src = dataUrl;
    }

    function copyToAllPages() {
      const a = anns.find((x) => x.id === selectedId);
      if (!a) return;
      const src = pages[a.page];
      let added = 0;
      for (const p of pages) {
        if (p.index === a.page) continue;
        const c = cloneAnn(a);
        c.id = nextId++;
        c.page = p.index;
        if (c.type === 'text' || c.type === 'ink') delete c.field;
        // Same spot relative to the page, even when page sizes differ.
        if (c.type !== 'ink') {
          c.x = (c.x / src.width) * p.width;
          c.y = (c.y / src.height) * p.height;
        }
        anns.push(c);
        added++;
      }
      commit();
      pages.forEach(renderLayer);
      toast(`Added to ${added} more page${added === 1 ? '' : 's'}.`, 'success');
    }

    async function addSignature() {
      const sig = await signatureDialog();
      if (sig) placeImage(sig, 180);
    }

    /* ---------- keyboard ---------- */
    /** Ctrl+A: select every page's text, not the rest of the app around it. */
    async function selectAllText() {
      const d = docs[activeDoc];
      if (!d) return;
      // Pages that were never scrolled into view have no text spans yet.
      const missing = d.pages.filter((p) => !p.textLayer);
      if (missing.length) {
        await withBusy('Reading text…', async () => {
          for (const p of missing) await drawText(p);
        });
      }
      const range = document.createRange();
      range.selectNodeContents(d.pagesEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }

    const onKey = (e: KeyboardEvent) => {
      if (workspace.hidden || !root.isConnected) return;
      const t = e.target as HTMLElement;
      if (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        void closeDoc(activeDoc);
      } else if (mod && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) {
        if (docs.length < 2) return;
        e.preventDefault();
        const back = e.shiftKey || e.key === 'PageUp';
        switchDoc((activeDoc + (back ? -1 : 1) + docs.length) % docs.length);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (mod && e.key.toLowerCase() === 'a') {
        // Select the whole document's text rather than the surrounding app.
        e.preventDefault();
        void selectAllText();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId !== null) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === 'Escape') {
        setTool('select');
        select_(null);
      } else if (!mod && !e.altKey) {
        const found = TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (found) setTool(found.id);
      }
    };
    document.addEventListener('keydown', onKey);
    const onResize = () => pages.length && pages.filter(isVisible).forEach((p) => void draw(p));
    window.addEventListener('resize', onResize);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unsaved().length) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    /** Names of the open documents whose edits are not in a PDF yet. */
    function unsaved() {
      return docs.filter((d, i) => (i === activeDoc ? dirty : d.dirty)).map((d) => d.src.name);
    }
    // The desktop shell asks this before it closes the window, so the question
    // is the app's own dialog rather than a native message box.
    const guard: UnsavedGuard = { names: unsaved, flush: () => rememberSession(true) };
    setUnsavedGuard(guard);

    /* ---------- save ---------- */
    async function save() {
      if (!src) return;
      finishEditing();
      const s = src;
      const out = await withBusy('Saving PDF…', async () => {
        const doc = await loadLib(s);
        const fonts = new FontCache(doc);
        const images = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();
        const form = doc.getForm();
        for (const a of anns) {
          // Text typed into a real form field is saved as the field's value.
          if (a.type === 'text' && a.field) {
            const fld = form.getFieldMaybe(a.field);
            if (fld instanceof PDFTextField) {
              fld.setText(safeText(await fonts.get('helvetica'), a.text));
              continue;
            }
          }
          if (a.type === 'ink' && a.field) {
            const fld = form.getFieldMaybe(a.field);
            if (fld instanceof PDFCheckBox) {
              fld.check();
              continue;
            }
          }
          const page = doc.getPage(a.page);
          await drawAnn(page, a, fonts, async (dataUrl) => {
            let img = images.get(dataUrl);
            if (!img) {
              const bytes = dataUrlBytes(dataUrl);
              img = dataUrl.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
              images.set(dataUrl, img);
            }
            return img;
          });
        }
        return doc.save();
      });
      if (!out) return;
      dirty = false;
      if (docs[activeDoc]) docs[activeDoc].dirty = false;
      renderTabs();
      void rememberSession(true);
      results.show([pdfOutput(`${baseName(s.name)}-edited`, out)]);
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearUnsavedGuard(guard);
      void rememberSession(true);
      for (const d of docs) {
        d.observer?.disconnect();
        void d.js?.loadingTask.destroy();
      }
    };
  },
};

/* ---------- drawing annotations into the PDF ---------- */

function color(hex: string) {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
}

function inkPath(a: InkAnn) {
  let d = a.paths.map((p) => `M${p.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L')}`).join(' ');
  if (a.arrow) {
    const [[x1, y1], [x2, y2]] = a.paths[0];
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.max(8, a.width * 4);
    const p1 = [x2 - len * Math.cos(ang - 0.45), y2 - len * Math.sin(ang - 0.45)];
    const p2 = [x2 - len * Math.cos(ang + 0.45), y2 - len * Math.sin(ang + 0.45)];
    d += ` M${p1[0].toFixed(2)} ${p1[1].toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} L${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

async function drawAnn(page: PDFPage, a: Ann, fonts: FontCache, image: (src: string) => Promise<import('@cantoo/pdf-lib').PDFImage>) {
  const f = visualFrame(page);
  const rotate = degrees(f.rotation);
  switch (a.type) {
    case 'text': {
      const font = await fonts.get(a.family, a.bold, a.italic);
      a.text.split('\n').forEach((line, i) => {
        const t = safeText(font, line);
        if (!t) return;
        const p = f.toPdf(a.x, a.y + i * a.size * 1.2 + baselineEm(a.family) * a.size);
        page.drawText(t, { x: p.x, y: p.y, size: a.size, font, color: color(a.color), rotate });
      });
      break;
    }
    case 'rect': {
      const p = f.toPdf(a.x, a.y + a.h);
      if (a.mode === 'box') {
        // Border drawn inside the box, like the CSS preview.
        const inset = a.width / 2;
        const q = f.toPdf(a.x + inset, a.y + a.h - inset);
        page.drawRectangle({ x: q.x, y: q.y, width: a.w - a.width, height: a.h - a.width, borderColor: color(a.color), borderWidth: a.width, rotate });
      } else {
        page.drawRectangle({
          x: p.x,
          y: p.y,
          width: a.w,
          height: a.h,
          color: color(a.color),
          rotate,
          ...(a.mode === 'highlight' ? { opacity: 0.4, blendMode: BlendMode.Multiply } : {}),
        });
      }
      break;
    }
    case 'image': {
      const img = await image(a.src);
      const p = f.toPdf(a.x, a.y + a.h);
      page.drawImage(img, { x: p.x, y: p.y, width: a.w, height: a.h, rotate });
      break;
    }
    case 'ink': {
      const o = f.toPdf(0, 0);
      page.drawSvgPath(inkPath(a), {
        x: o.x,
        y: o.y,
        borderColor: color(a.color),
        borderWidth: a.width,
        borderLineCap: LineCapStyle.Round,
        rotate,
      });
      break;
    }
  }
}

function dataUrlBytes(url: string) {
  const b64 = url.slice(url.indexOf(',') + 1);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Normalize any image file to a PNG or JPEG data URL (what PDFs can embed). */
async function fileToPngOrJpegDataUrl(file: File): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  if (/^data:image\/(png|jpeg)/.test(url)) return url;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Unsupported image'));
    img.src = url;
  });
}
