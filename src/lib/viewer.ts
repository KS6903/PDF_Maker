/**
 * A one-page-at-a-time PDF view with a drawing layer on top, for tools that
 * work by pointing at the page (redaction boxes, measurements). The layer is
 * an SVG whose units are page points as the reader sees the page: origin at
 * the top left, y going down, rotation already applied.
 */
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { h, button } from './ui';
import { renderPage } from './pdf';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

export interface PageStage {
  el: HTMLElement;
  /** Toolbar, for the tool's own controls. */
  bar: HTMLElement;
  /** Drawing layer over the page, in page points. */
  overlay: SVGSVGElement;
  /** Current page, 1-based. */
  page(): number;
  /** Size of the current page in points, as displayed. */
  size(): { width: number; height: number };
  show(n: number): Promise<void>;
  /** Pointer position in page points. */
  point(e: MouseEvent): { x: number; y: number };
}

export function pageStage(js: PDFDocumentProxy, onShow: (n: number) => void): PageStage {
  let current = 1;
  let zoom = 0; // 0 = fit the width
  let dims = { width: 0, height: 0 };
  let token = 0;

  const overlay = svg('svg') as SVGSVGElement;
  const holder = h('div', { class: 'stage-page' });
  const scroll = h('div', { class: 'stage-scroll' }, holder);
  const label = h('span', { class: 'stage-label' });
  const zoomLabel = h('span', { class: 'zoom-label' });
  const prev = button(null, () => void show(current - 1), { icon: ChevronLeft, kind: 'ghost', title: 'Previous page' });
  const next = button(null, () => void show(current + 1), { icon: ChevronRight, kind: 'ghost', title: 'Next page' });
  const bar = h(
    'div',
    { class: 'stage-bar' },
    prev,
    label,
    next,
    h('span', { class: 'sep' }),
    button(null, () => setZoom(-1), { icon: ZoomOut, kind: 'ghost', title: 'Zoom out' }),
    zoomLabel,
    button(null, () => setZoom(1), { icon: ZoomIn, kind: 'ghost', title: 'Zoom in' }),
  );
  const el = h('div', { class: 'stage' }, bar, scroll);

  function fitScale(width: number) {
    const avail = (scroll.clientWidth || 760) - 32;
    return Math.max(0.3, Math.min(2, avail / width));
  }

  function setZoom(dir: number) {
    const now = zoom || fitScale(dims.width);
    zoom = Math.max(0.3, Math.min(4, Math.round((now + dir * 0.25) * 4) / 4));
    void show(current);
  }

  async function show(n: number) {
    const target = Math.max(1, Math.min(js.numPages, n));
    const mine = ++token;
    const page = await js.getPage(target);
    const base = page.getViewport({ scale: 1 });
    const scale = zoom || fitScale(base.width);
    const canvas = await renderPage(page, scale);
    if (mine !== token) return;
    current = target;
    dims = { width: base.width, height: base.height };
    overlay.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    holder.style.width = canvas.style.width;
    holder.style.height = canvas.style.height;
    holder.replaceChildren(canvas, overlay);
    label.textContent = `Page ${current} of ${js.numPages}`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    prev.disabled = current <= 1;
    next.disabled = current >= js.numPages;
    onShow(current);
  }

  function point(e: MouseEvent) {
    const r = overlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(dims.width, ((e.clientX - r.left) / r.width) * dims.width)),
      y: Math.max(0, Math.min(dims.height, ((e.clientY - r.top) / r.height) * dims.height)),
    };
  }

  return { el, bar, overlay, page: () => current, size: () => dims, show, point };
}
