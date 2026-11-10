/**
 * Placing a picture on its own page by hand: a drawing of the page that the
 * Images → PDF cards use as thumbnails, and a dialog where the picture can be
 * dragged, resized from its corners, turned and snapped to the page.
 */
import { RotateCcw, RotateCw, Shrink, Expand, Scaling, Crosshair, Undo2, type IconNode } from 'lucide';
import { h, icon, modal } from './ui';
import { layoutPicture, type ImagePageOptions, type PictureAdjust, type PictureLayout, type Placement, type Rotation } from './images';

const SVG = 'http://www.w3.org/2000/svg';
let clipSeq = 0;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export interface PictureSource {
  url: string;
  /** Size in pixels, upright as the file shows it. */
  px: number;
  py: number;
}

/**
 * The page with the picture on it, drawn the way the PDF will lay it out.
 * Scales to whatever box it is put in; call `draw` again after a change.
 */
export function pageDrawing(pic: PictureSource) {
  const svg = svgEl('svg', { class: 'pic-page', preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  const clipId = `pic-clip-${++clipSeq}`;
  const clip = svgEl('clipPath', { id: clipId });
  const clipRect = svgEl('rect');
  clip.append(clipRect);
  const defs = svgEl('defs');
  defs.append(clip);
  const paper = svgEl('rect', { class: 'pic-paper' });
  const margins = svgEl('rect', { class: 'pic-margins' });
  const image = svgEl('image', { href: pic.url, preserveAspectRatio: 'none' });
  // The clip sits on a wrapper so it stays the page's shape when the picture turns.
  const clipped = svgEl('g', { 'clip-path': `url(#${clipId})` });
  clipped.append(image);
  svg.append(defs, paper, margins, clipped);

  function draw(l: PictureLayout, o: ImagePageOptions, rotate: Rotation) {
    svg.setAttribute('viewBox', `0 0 ${l.pw} ${l.ph}`);
    for (const r of [paper, clipRect]) {
      r.setAttribute('width', String(l.pw));
      r.setAttribute('height', String(l.ph));
    }
    margins.setAttribute('x', String(o.margin));
    margins.setAttribute('y', String(o.margin));
    margins.setAttribute('width', String(Math.max(0, l.pw - o.margin * 2)));
    margins.setAttribute('height', String(Math.max(0, l.ph - o.margin * 2)));
    margins.style.display = o.margin > 0 ? '' : 'none';
    // The picture is drawn upright about the box's centre, then turned into the box.
    const turned = rotate === 90 || rotate === 270;
    const w = turned ? l.h : l.w;
    const hh = turned ? l.w : l.h;
    const cx = l.x + l.w / 2;
    const cy = l.y + l.h / 2;
    image.setAttribute('x', String(cx - w / 2));
    image.setAttribute('y', String(cy - hh / 2));
    image.setAttribute('width', String(w));
    image.setAttribute('height', String(hh));
    if (rotate) image.setAttribute('transform', `rotate(${rotate} ${cx} ${cy})`);
    else image.removeAttribute('transform');
  }
  return { svg, draw };
}

const CM = 72 / 2.54;

function sizeText(l: PictureLayout) {
  const cm = (v: number) => (v / CM).toFixed(1);
  return `${cm(l.w)} × ${cm(l.h)} cm on a ${cm(l.pw)} × ${cm(l.ph)} cm page`;
}

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;
type Corner = (typeof CORNERS)[number];

/**
 * Open the placement dialog. Resolves with the new adjustment, or null if it
 * was cancelled. Nothing changes until Done is pressed.
 */
export async function adjustPicture(pic: PictureSource & { name: string }, o: ImagePageOptions, start: PictureAdjust): Promise<PictureAdjust | null> {
  let rotate: Rotation = start.rotate ?? 0;
  let placement: Placement | undefined = start.placement ? { ...start.placement } : undefined;
  // The dialog is at most 700px wide with 22px padding; leave the page a little air.
  const STAGE_W = Math.max(240, Math.min(620, window.innerWidth - 100));
  const STAGE_H = Math.max(220, Math.min(440, window.innerHeight - 340));

  const drawing = pageDrawing(pic);
  const box = h('div', { class: 'sel-box pic-sel', title: 'Drag to move' }, CORNERS.map((c) => h('div', { class: `sel-handle ${c}`, 'data-handle': c, title: 'Drag to resize' })));
  const page = h('div', { class: 'pic-stage-page' }, drawing.svg, box);
  const stage = h(
    'div',
    {
      class: 'pic-stage',
      tabindex: 0,
      'aria-label': 'Picture on the page. Drag it to move it, or drag a corner to resize. Arrow keys move it, plus and minus resize it.',
      style: `height:${STAGE_H}px`,
    },
    page,
  );
  const sizeRange = h('input', { type: 'range', min: 5, max: 300, step: 1, 'aria-label': 'Size' }) as HTMLInputElement;
  const sizeNum = h('input', { type: 'number', min: 5, max: 1000, step: 1, class: 'pic-size-num', 'aria-label': 'Size in percent' }) as HTMLInputElement;
  const readout = h('div', { class: 'muted small pic-readout' });

  let l = current();
  let s = 1; // screen px per pt

  /** The placement in use, made explicit, so a drag starts from what is shown. */
  function explicit(): Placement {
    if (placement) return placement;
    const auto = layoutPicture(o, pic.px, pic.py, { rotate });
    return { scale: auto.w / ((rotate === 90 || rotate === 270 ? pic.py : pic.px) * 0.75 * auto.fit), cx: (auto.x + auto.w / 2) / auto.pw, cy: (auto.y + auto.h / 2) / auto.ph };
  }
  function current() {
    return layoutPicture(o, pic.px, pic.py, { rotate, placement });
  }
  function render() {
    l = current();
    s = Math.min(STAGE_W / l.pw, STAGE_H / l.ph);
    page.style.width = `${l.pw * s}px`;
    page.style.height = `${l.ph * s}px`;
    drawing.draw(l, o, rotate);
    Object.assign(box.style, { left: `${l.x * s}px`, top: `${l.y * s}px`, width: `${l.w * s}px`, height: `${l.h * s}px` });
    const pct = Math.round(explicit().scale * 100);
    sizeRange.value = String(Math.min(300, pct));
    if (document.activeElement !== sizeNum) sizeNum.value = String(pct);
    readout.textContent = sizeText(l);
  }
  function setScale(scale: number) {
    placement = { ...explicit(), scale: Math.max(0.05, Math.min(10, scale)) };
    render();
  }
  function turn(by: 90 | -90) {
    // The size and spot stay as chosen; "100%" follows the picture's new shape.
    rotate = ((((rotate + by) % 360) + 360) % 360) as Rotation;
    render();
  }

  sizeRange.addEventListener('input', () => setScale(+sizeRange.value / 100));
  sizeNum.addEventListener('change', () => setScale((+sizeNum.value || 100) / 100));

  /* ---------- dragging ---------- */
  let drag: { kind: 'move' | Corner; x: number; y: number; from: Placement; l: PictureLayout } | null = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.sel-handle');
    drag = { kind: handle ? ((handle.dataset.handle ?? 'se') as Corner) : 'move', x: e.clientX, y: e.clientY, from: explicit(), l };
    box.setPointerCapture(e.pointerId);
    stage.focus({ preventScroll: true });
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / s;
    const dy = (e.clientY - drag.y) / s;
    const d = drag.l;
    if (drag.kind === 'move') {
      let cx = d.x + d.w / 2 + dx;
      let cy = d.y + d.h / 2 + dy;
      // Snap to the middle of the page when close, unless Alt is held.
      if (!e.altKey) {
        if (Math.abs(cx - d.pw / 2) * s < 6) cx = d.pw / 2;
        if (Math.abs(cy - d.ph / 2) * s < 6) cy = d.ph / 2;
      }
      placement = { ...drag.from, cx: cx / d.pw, cy: cy / d.ph };
    } else {
      // The opposite corner stays put and the picture keeps its proportions:
      // the pointer's travel along the diagonal sets the new size.
      const sx = drag.kind.includes('e') ? 1 : -1;
      const sy = drag.kind.includes('s') ? 1 : -1;
      const ax = sx > 0 ? d.x : d.x + d.w;
      const ay = sy > 0 ? d.y : d.y + d.h;
      const grow = 1 + (sx * dx * d.w + sy * dy * d.h) / (d.w * d.w + d.h * d.h);
      const w = Math.max(12 / s, d.w * grow);
      const hh = (w * d.h) / d.w;
      placement = { scale: (drag.from.scale * w) / d.w, cx: (ax + (sx * w) / 2) / d.pw, cy: (ay + (sy * hh) / 2) / d.ph };
    }
    render();
  });
  const end = () => {
    drag = null;
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  stage.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const p = explicit();
    const move = (dx: number, dy: number) => {
      placement = { ...p, cx: p.cx + dx / l.pw, cy: p.cy + dy / l.ph };
      render();
    };
    if (e.key === 'ArrowLeft') move(-step, 0);
    else if (e.key === 'ArrowRight') move(step, 0);
    else if (e.key === 'ArrowUp') move(0, -step);
    else if (e.key === 'ArrowDown') move(0, step);
    else if (e.key === '+' || e.key === '=') setScale(p.scale * (e.shiftKey ? 1.1 : 1.02));
    else if (e.key === '-' || e.key === '_') setScale(p.scale / (e.shiftKey ? 1.1 : 1.02));
    else return;
    e.preventDefault();
  });

  /* ---------- quick choices ---------- */
  const quick = (label: string, ic: IconNode, title: string, fn: () => void) =>
    h('button', { type: 'button', class: 'btn default pic-quick', title, onclick: fn }, icon(ic, 16), h('span', null, label));
  const choices = h(
    'div',
    { class: 'pic-quick-row' },
    quick('Fit page', Shrink, 'Make it as big as fits inside the margins, centred', () => {
      placement = { scale: 1, cx: 0.5, cy: 0.5 };
      render();
    }),
    quick('Fill page', Expand, 'Cover the whole area inside the margins; edges may be cut off', () => {
      const turned = rotate === 90 || rotate === 270;
      const iw = (turned ? pic.py : pic.px) * 0.75;
      const ih = (turned ? pic.px : pic.py) * 0.75;
      const bw = l.pw - o.margin * 2;
      const bh = l.ph - o.margin * 2;
      placement = { scale: Math.max(bw / iw, bh / ih) / l.fit, cx: 0.5, cy: 0.5 };
      render();
    }),
    quick('Actual size', Scaling, 'The size the picture is meant to print at (96 pixels per inch)', () => {
      setScale(1 / l.fit);
    }),
    quick('Centre', Crosshair, 'Move it to the middle of the page', () => {
      placement = { ...explicit(), cx: 0.5, cy: 0.5 };
      render();
    }),
    quick('Turn left', RotateCcw, 'Turn a quarter turn to the left', () => turn(-90)),
    quick('Turn right', RotateCw, 'Turn a quarter turn to the right', () => turn(90)),
    quick('Reset', Undo2, 'Back to how the page settings place it, upright', () => {
      placement = undefined;
      rotate = 0;
      render();
    }),
  );

  const body = h(
    'div',
    { class: 'pic-adjust' },
    stage,
    h('div', { class: 'pic-size-row' }, h('span', { class: 'field-label' }, 'Size'), sizeRange, sizeNum, h('span', { class: 'muted small' }, '%')),
    readout,
    choices,
    h('p', { class: 'muted small' }, '100% is as big as fits inside the margins. Drag the picture to move it and drag a corner to resize it. It snaps to the middle of the page; hold Alt to place it freely.'),
  );
  render();

  const res = await modal(`Place ${pic.name}`, body, [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Done', kind: 'primary', value: 'done' },
  ], { className: 'pic-modal' });
  if (res !== 'done') return null;
  return { rotate, placement };
}
