import { Ruler, Trash2, Save } from 'lucide';
import { degrees, rgb, StandardFonts } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { h, button, field, select, numberInput, modal, toast, withBusy } from '../lib/ui';
import { loadLib, loadJs, pdfOutput, baseName, visualFrame, type PdfSource } from '../lib/pdf';
import { pageStage, svg, type PageStage } from '../lib/viewer';
import { safeText } from '../lib/fonts';
import { pdfInput, resultsPanel, type Tool } from './common';

type Kind = 'distance' | 'perimeter' | 'area' | 'calibrate';
type Pt = { x: number; y: number };
interface Measurement {
  page: number;
  kind: Exclude<Kind, 'calibrate'>;
  points: Pt[];
}

/** Points per paper unit. */
const PAPER: Record<string, number> = { in: 72, mm: 72 / 25.4, cm: 72 / 2.54, pt: 1 };
/** Metres per real-world unit. */
const REAL: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, pt: 0.0254 / 72 };
const REAL_OPTIONS: [string, string][] = Object.keys(REAL).map((u) => [u, u]);

function length(points: Pt[], closed = false) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  if (closed && points.length > 2) d += Math.hypot(points[0].x - points.at(-1)!.x, points[0].y - points.at(-1)!.y);
  return d;
}

/** Shoelace formula, in square points. */
function area(points: Pt[]) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function centroid(points: Pt[]) {
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
}

const KIND_LABEL: Record<Measurement['kind'], string> = { distance: 'Distance', perimeter: 'Perimeter', area: 'Area' };

export const measureTool: Tool = {
  id: 'measure',
  title: 'Measure objects',
  blurb: 'Measure distances, perimeters and areas on a page at a set scale.',
  icon: Ruler,
  group: 'Edit & sign',
  acceptsPdf: true,
  mount(el, ctx) {
    const results = resultsPanel(ctx);
    const work = h('div', { class: 'stack', hidden: true });
    let js: PDFDocumentProxy | null = null;
    let source: PdfSource | null = null;
    let stage: PageStage | null = null;
    let measurements: Measurement[] = [];
    let kind: Kind = 'distance';
    let draft: Pt[] = [];
    let hover: Pt | null = null;

    // The scale: `ratio` real units for every one paper unit.
    const ratio = numberInput(1, { min: 0, step: 0.01 });
    ratio.step = 'any';
    const paperUnit = select<string>([['in', 'in'], ['mm', 'mm'], ['cm', 'cm'], ['pt', 'pt']], 'in', () => paint());
    const realUnit = select<string>(REAL_OPTIONS, 'in', () => paint());
    ratio.addEventListener('input', () => paint());
    const list = h('div', { class: 'measure-list' });

    function toReal(pts: number) {
      return (pts / PAPER[paperUnit.value]) * (+ratio.value || 1);
    }
    function fmt(n: number) {
      return n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : 1 });
    }
    function valueOf(m: Measurement) {
      const u = realUnit.value;
      if (m.kind === 'area') {
        const r = toReal(1);
        return `${fmt(area(m.points) * r * r)} ${u}²`;
      }
      return `${fmt(toReal(length(m.points, m.kind === 'perimeter')))} ${u}`;
    }

    const modes = h(
      'div',
      { class: 'seg', role: 'tablist' },
      (
        [
          ['distance', 'Distance'],
          ['perimeter', 'Perimeter'],
          ['area', 'Area'],
          ['calibrate', 'Set scale'],
        ] as [Kind, string][]
      ).map(([k, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'data-kind': k,
            'aria-selected': String(k === kind),
            onclick: () => {
              kind = k;
              draft = [];
              for (const b of modes.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.kind === kind));
              paint();
            },
          },
          label,
        ),
      ),
    );
    const hint = h('p', { class: 'muted small' });

    function shape(points: Pt[], k: Kind, cls: string) {
      const pts = points.map((p) => `${p.x},${p.y}`).join(' ');
      return k === 'area' ? svg('polygon', { class: cls, points: pts }) : svg('polyline', { class: cls, points: pts });
    }

    function paint() {
      hint.textContent =
        kind === 'distance' ? 'Click two points.'
        : kind === 'calibrate' ? 'Click both ends of something whose real length you know.'
        : 'Click each corner. Double-click or press Enter to finish, Esc to cancel.';
      if (stage) {
        const n = stage.page();
        const nodes: SVGElement[] = [];
        for (const m of measurements.filter((m) => m.page === n)) {
          nodes.push(shape(m.kind === 'perimeter' ? [...m.points, m.points[0]] : m.points, m.kind, 'measure-shape'));
          for (const p of m.points) nodes.push(svg('circle', { class: 'measure-dot', cx: p.x, cy: p.y, r: 2 }));
          const at = m.kind === 'distance' ? { x: (m.points[0].x + m.points[1].x) / 2, y: (m.points[0].y + m.points[1].y) / 2 - 4 } : centroid(m.points);
          nodes.push(svg('text', { class: 'measure-label', x: at.x, y: at.y, 'text-anchor': 'middle' }, valueOf(m)));
        }
        if (draft.length) {
          const pts = hover ? [...draft, hover] : draft;
          nodes.push(shape(pts, kind === 'area' ? 'area' : 'distance', 'measure-shape draft'));
          for (const p of draft) nodes.push(svg('circle', { class: 'measure-dot', cx: p.x, cy: p.y, r: 2 }));
        }
        stage.overlay.replaceChildren(...nodes);
      }
      list.replaceChildren(
        ...(measurements.length
          ? measurements.map((m, i) =>
              h(
                'div',
                { class: 'measure-row' },
                h('span', null, h('strong', null, KIND_LABEL[m.kind]), h('small', { class: 'muted' }, ` · page ${m.page}`)),
                h('span', { class: 'measure-value' }, valueOf(m)),
                button(null, () => (measurements.splice(i, 1), paint()), { icon: Trash2, kind: 'ghost', title: 'Remove measurement' }),
              ),
            )
          : [h('p', { class: 'muted small' }, 'No measurements yet.')]),
      );
    }

    async function calibrate(points: Pt[]) {
      const real = numberInput(1, { min: 0 });
      real.step = 'any';
      const unit = select<string>(REAL_OPTIONS, realUnit.value);
      const body = h('div', { class: 'stack' }, h('p', null, 'How long is the line you drew, in reality?'), h('div', { class: 'grid' }, field('Length', real), field('Unit', unit)));
      const res = await modal('Set scale', body, [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Set scale', value: 'ok', kind: 'primary' },
      ]);
      const value = +real.value;
      if (res !== 'ok' || !(value > 0)) return;
      const paper = length(points) / PAPER[paperUnit.value];
      if (!paper) return;
      realUnit.value = unit.value;
      ratio.value = String(+(value / paper).toPrecision(6));
      toast(`Scale set: 1 ${paperUnit.value} on the page = ${ratio.value} ${unit.value}.`, 'success');
      paint();
    }

    function finish() {
      if (kind === 'perimeter' && draft.length >= 2) measurements.push({ page: stage!.page(), kind, points: draft });
      if (kind === 'area' && draft.length >= 3) measurements.push({ page: stage!.page(), kind, points: draft });
      draft = [];
      paint();
    }

    function wire(s: PageStage) {
      s.overlay.addEventListener('click', (e) => {
        const p = s.point(e);
        draft.push(p);
        if (draft.length === 2 && (kind === 'distance' || kind === 'calibrate')) {
          const pts = draft;
          draft = [];
          if (kind === 'distance') measurements.push({ page: s.page(), kind: 'distance', points: pts });
          else void calibrate(pts);
        }
        paint();
      });
      s.overlay.addEventListener('dblclick', (e) => {
        e.preventDefault();
        // The double-click's two clicks each added a point; drop the duplicate.
        if (draft.length > 1) draft.pop();
        finish();
      });
      s.overlay.addEventListener('pointermove', (e) => {
        if (!draft.length) return;
        hover = s.point(e);
        paint();
      });
      s.overlay.addEventListener('pointerleave', () => ((hover = null), paint()));
    }

    const onKey = (e: KeyboardEvent) => {
      if (!draft.length) return;
      if (e.key === 'Enter') finish();
      if (e.key === 'Escape') ((draft = []), paint());
    };
    document.addEventListener('keydown', onKey);

    async function save() {
      if (!source) return;
      if (!measurements.length) return toast('Add a measurement first.', 'info');
      const src = source;
      const bytes = await withBusy('Saving measurements…', async () => {
        const doc = await loadLib(src);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const red = rgb(0.86, 0.2, 0.22);
        for (const m of measurements) {
          const page = doc.getPage(m.page - 1);
          const frame = visualFrame(page);
          const pts = m.kind === 'distance' ? m.points : [...m.points, m.points[0]];
          for (let i = 1; i < pts.length; i++) {
            page.drawLine({ start: frame.toPdf(pts[i - 1].x, pts[i - 1].y), end: frame.toPdf(pts[i].x, pts[i].y), thickness: 1, color: red });
          }
          const label = safeText(font, valueOf(m));
          const size = 9;
          const tw = font.widthOfTextAtSize(label, size);
          const at = m.kind === 'distance' ? { x: (m.points[0].x + m.points[1].x) / 2, y: (m.points[0].y + m.points[1].y) / 2 - 3 } : centroid(m.points);
          const origin = frame.toPdf(at.x - tw / 2, at.y);
          page.drawText(label, { x: origin.x, y: origin.y, size, font, color: red, rotate: degrees(frame.rotation) });
        }
        return doc.save();
      });
      if (bytes) results.show([pdfOutput(`${baseName(src.name)}-measured`, bytes)], 'Measurements are drawn onto the pages in red.');
    }

    const input = pdfInput(ctx, async (src) => {
      results.hide();
      measurements = [];
      draft = [];
      void js?.loadingTask.destroy();
      js = null;
      source = src;
      work.replaceChildren();
      work.hidden = !src;
      if (!src) return;
      js = await loadJs(src);
      stage = pageStage(js, () => ((draft = []), paint()));
      wire(stage);
      const side = h(
        'div',
        { class: 'stack' },
        h('div', { class: 'panel' }, modes, hint),
        h(
          'div',
          { class: 'panel' },
          h('h3', null, 'Scale'),
          h('div', { class: 'scale-row' }, h('span', null, '1'), paperUnit, h('span', null, 'on the page ='), ratio, realUnit),
          h('p', { class: 'muted small' }, 'Leave it at 1 in = 1 in to measure the page itself, or use Set scale on a known length.'),
        ),
        h('div', { class: 'panel' }, h('h3', null, 'Measurements'), list, button('Save PDF with measurements', () => void save(), { icon: Save, kind: 'primary' })),
      );
      work.append(h('div', { class: 'split-layout' }, stage.el, side));
      await stage.show(1);
    });
    el.append(input.el, work, results.el);
    return () => {
      document.removeEventListener('keydown', onKey);
      void js?.loadingTask.destroy();
    };
  },
};
