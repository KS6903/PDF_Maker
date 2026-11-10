/**
 * Placing a picture on its own page by hand: a drawing of the page that the
 * Images → PDF cards use as thumbnails, and a dialog where the picture can be
 * dragged, resized (in proportion or freely, by hand or by the number),
 * cropped, turned and snapped to the page.
 */
import { RotateCcw, RotateCw, Shrink, Expand, Scaling, Crosshair, Undo2, Crop as CropIcon, Link, Unlink, type IconNode } from 'lucide';
import { h, icon, modal } from './ui';
import {
  layoutPicture,
  placementFor,
  fillScale,
  pictureSize,
  isCropped,
  type Crop,
  type ImagePageOptions,
  type PictureAdjust,
  type PictureLayout,
  type Placement,
  type Rotation,
} from './images';

const SVG = 'http://www.w3.org/2000/svg';
let clipSeq = 0;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
function setAttrs(el: Element, attrs: Record<string, number>) {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}

const NO_CROP: Crop = { l: 0, t: 0, r: 0, b: 0 };

/** The crop as it looks on the page: a quarter turn clockwise moves the top edge to the right. */
function shownCrop(c: Crop | undefined, rotate: Rotation): Crop {
  let d = c ?? NO_CROP;
  for (let i = 0; i < rotate / 90; i++) d = { l: d.b, t: d.l, r: d.t, b: d.r };
  return d;
}
/** Back from the page's view of the crop to the upright picture's. */
function uprightCrop(d: Crop, rotate: Rotation): Crop {
  let c = d;
  for (let i = 0; i < (4 - rotate / 90) % 4; i++) c = { l: c.b, t: c.l, r: c.t, b: c.r };
  return c;
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
 * With `ghost`, the cropped-off parts show faintly and the page doesn't clip.
 */
export function pageDrawing(pic: PictureSource) {
  const svg = svgEl('svg', { class: 'pic-page', preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  const id = ++clipSeq;
  const pageClip = svgEl('clipPath', { id: `pic-page-${id}` });
  const pageRect = svgEl('rect');
  pageClip.append(pageRect);
  const cropClip = svgEl('clipPath', { id: `pic-crop-${id}` });
  const cropRect = svgEl('rect');
  cropClip.append(cropRect);
  const defs = svgEl('defs');
  defs.append(pageClip, cropClip);
  const paper = svgEl('rect', { class: 'pic-paper' });
  const margins = svgEl('rect', { class: 'pic-margins' });
  const ghost = svgEl('image', { href: pic.url, preserveAspectRatio: 'none', class: 'pic-ghost' });
  const image = svgEl('image', { href: pic.url, preserveAspectRatio: 'none', 'clip-path': `url(#pic-crop-${id})` });
  // The page clip sits outside the turn so it stays the page's shape; the crop
  // clip sits inside it so it turns with the picture.
  const turn = svgEl('g');
  turn.append(ghost, image);
  const clipped = svgEl('g');
  clipped.append(turn);
  svg.append(defs, paper, margins, clipped);

  function draw(l: PictureLayout, o: ImagePageOptions, adjust: PictureAdjust, opts: { ghost?: boolean } = {}) {
    const rotate = adjust.rotate ?? 0;
    svg.setAttribute('viewBox', `0 0 ${l.pw} ${l.ph}`);
    for (const r of [paper, pageRect]) setAttrs(r, { width: l.pw, height: l.ph });
    setAttrs(margins, { x: o.margin, y: o.margin, width: Math.max(0, l.pw - o.margin * 2), height: Math.max(0, l.ph - o.margin * 2) });
    margins.style.display = o.margin > 0 ? '' : 'none';
    // Upright, the cropped picture is w × hh about the box's centre; the whole
    // picture extends past it by the crop, and the lot is turned into the box.
    const turned = rotate === 90 || rotate === 270;
    const w = turned ? l.h : l.w;
    const hh = turned ? l.w : l.h;
    const cx = l.x + l.w / 2;
    const cy = l.y + l.h / 2;
    const c = adjust.crop ?? NO_CROP;
    const fw = w / (1 - c.l - c.r);
    const fh = hh / (1 - c.t - c.b);
    const full = { x: cx - w / 2 - c.l * fw, y: cy - hh / 2 - c.t * fh, width: fw, height: fh };
    setAttrs(image, full);
    setAttrs(ghost, full);
    setAttrs(cropRect, { x: cx - w / 2, y: cy - hh / 2, width: w, height: hh });
    if (rotate) turn.setAttribute('transform', `rotate(${rotate} ${cx} ${cy})`);
    else turn.removeAttribute('transform');
    ghost.style.display = opts.ghost ? '' : 'none';
    if (opts.ghost) clipped.removeAttribute('clip-path');
    else clipped.setAttribute('clip-path', `url(#pic-page-${id})`);
  }
  return { svg, draw };
}

const UNITS = { cm: 72 / 2.54, mm: 72 / 25.4, in: 72 } as const;
type Unit = keyof typeof UNITS;
let lastUnit: Unit = 'cm';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];
type Box = { x: number; y: number; w: number; h: number };

/**
 * Open the placement dialog. Resolves with the new adjustment, or null if it
 * was cancelled. Nothing changes until Done is pressed.
 */
export async function adjustPicture(pic: PictureSource & { name: string }, o: ImagePageOptions, start: PictureAdjust): Promise<PictureAdjust | null> {
  let rotate: Rotation = start.rotate ?? 0;
  let crop: Crop | undefined = start.crop ? { ...start.crop } : undefined;
  let placement: Placement | undefined = start.placement ? { ...start.placement } : undefined;
  let keepShape = !placement?.stretch;
  let mode: 'place' | 'crop' = 'place';
  let unit: Unit = lastUnit;
  const STAGE_W = Math.max(240, Math.min(620, window.innerWidth - 100));
  const STAGE_H = Math.max(220, Math.min(420, window.innerHeight - 420));

  const adj = (): PictureAdjust => ({ rotate, crop, placement });
  const drawing = pageDrawing(pic);
  const box = h('div', { class: 'sel-box pic-sel' }, HANDLES.map((c) => h('div', { class: `sel-handle ${c}`, 'data-handle': c })));
  const page = h('div', { class: 'pic-stage-page' }, drawing.svg, box);
  const stage = h(
    'div',
    {
      class: 'pic-stage',
      tabindex: 0,
      'aria-label': 'Picture on the page. Drag it to move it, or drag a corner or side to resize. Arrow keys move it, plus and minus resize it.',
      style: `height:${STAGE_H}px`,
    },
    page,
  );

  /* ---------- controls ---------- */
  const sizeRange = h('input', { type: 'range', min: 5, max: 300, step: 1, 'aria-label': 'Size, percent of the space inside the margins' }) as HTMLInputElement;
  const sizePct = h('span', { class: 'pic-size-pct' });
  const numIn = (label: string) => h('input', { type: 'number', min: 0.1, step: 0.1, class: 'pic-size-num', 'aria-label': label }) as HTMLInputElement;
  const widthIn = numIn('Width');
  const heightIn = numIn('Height');
  const unitSel = h('select', { class: 'pic-unit', 'aria-label': 'Unit' }, (Object.keys(UNITS) as Unit[]).map((u) => h('option', { value: u }, u))) as HTMLSelectElement;
  unitSel.value = unit;
  const lockBtn = h('button', { type: 'button', class: 'btn ghost icon-only pic-lock' });
  const readout = h('div', { class: 'muted small pic-readout' });
  const hint = h('p', { class: 'muted small' });

  let l = current();
  let s = 1; // screen px per pt

  function current() {
    return layoutPicture(o, pic.px, pic.py, adj());
  }
  /** The placement in use, made explicit, so a change starts from what is shown. */
  function explicit(): Placement {
    return placement ?? placementFor(o, pic.px, pic.py, adj(), current());
  }
  function put(r: Box) {
    placement = placementFor(o, pic.px, pic.py, adj(), r);
    render();
  }
  function scaleTo(scale: number) {
    placement = { ...explicit(), scale: Math.max(0.05, Math.min(10, scale)) };
    render();
  }
  const fmt = (pt: number) => {
    const v = pt / UNITS[unit];
    return unit === 'mm' ? String(Math.round(v)) : (Math.round(v * 100) / 100).toString();
  };

  function render() {
    l = current();
    s = Math.min(STAGE_W / l.pw, STAGE_H / l.ph);
    page.style.width = `${l.pw * s}px`;
    page.style.height = `${l.ph * s}px`;
    drawing.draw(l, o, adj(), { ghost: mode === 'crop' });
    Object.assign(box.style, { left: `${l.x * s}px`, top: `${l.y * s}px`, width: `${l.w * s}px`, height: `${l.h * s}px` });
    box.classList.toggle('cropping', mode === 'crop');
    box.classList.toggle('free', mode === 'place' && !keepShape);
    box.title = mode === 'crop' ? 'Drag a side or corner to crop; drag inside to move the crop' : 'Drag to move';
    const pct = Math.round(explicit().scale * 100);
    sizeRange.value = String(Math.min(300, pct));
    sizePct.textContent = `${pct}%`;
    if (document.activeElement !== widthIn) widthIn.value = fmt(l.w);
    if (document.activeElement !== heightIn) heightIn.value = fmt(l.h);
    lockBtn.replaceChildren(icon(keepShape ? Link : Unlink, 16));
    lockBtn.title = keepShape ? 'Proportions kept. Click to size width and height freely' : 'Sizing freely. Click to keep the proportions';
    lockBtn.setAttribute('aria-label', 'Keep proportions');
    lockBtn.setAttribute('aria-pressed', String(keepShape));
    const cm = (v: number) => (v / UNITS.cm).toFixed(1);
    readout.textContent = `Page ${cm(l.pw)} × ${cm(l.ph)} cm${isCropped(crop) ? ' · cropped' : ''}${placement?.stretch ? ' · stretched' : ''}`;
    cropBtn.setAttribute('aria-pressed', String(mode === 'crop'));
    cropBtn.querySelector('span')!.textContent = mode === 'crop' ? 'Done cropping' : 'Crop';
    hint.textContent =
      mode === 'crop'
        ? 'Drag the sides or corners to cut the picture down, and drag inside to choose which part to keep. The faded parts are cut off and left out of the PDF.'
        : '100% is as big as fits inside the margins. Drag the picture to move it and drag a corner to resize it; with the chain unlinked, or holding Shift, it resizes freely and the sides stretch it. It snaps to the middle of the page; hold Alt to place it freely.';
  }

  sizeRange.addEventListener('input', () => scaleTo(+sizeRange.value / 100));
  function typed(which: 'w' | 'h') {
    const v = +(which === 'w' ? widthIn : heightIn).value * UNITS[unit];
    if (!(v > 0)) return render();
    let w = which === 'w' ? v : keepShape ? (v * l.w) / l.h : l.w;
    let hh = which === 'h' ? v : keepShape ? (v * l.h) / l.w : l.h;
    w = Math.max(1, w);
    hh = Math.max(1, hh);
    const cx = l.x + l.w / 2;
    const cy = l.y + l.h / 2;
    put({ x: cx - w / 2, y: cy - hh / 2, w, h: hh });
  }
  widthIn.addEventListener('change', () => typed('w'));
  heightIn.addEventListener('change', () => typed('h'));
  unitSel.addEventListener('change', () => {
    unit = lastUnit = unitSel.value as Unit;
    render();
  });
  lockBtn.addEventListener('click', () => {
    keepShape = !keepShape;
    render();
  });

  function turn(by: 90 | -90) {
    rotate = ((((rotate + by) % 360) + 360) % 360) as Rotation;
    // A stretch turns with the picture, so its width and height swap.
    if (placement?.stretch) placement = { ...placement, stretch: 1 / placement.stretch };
    render();
  }

  /* ---------- dragging ---------- */
  let drag: { kind: Handle | 'move'; x: number; y: number; l: PictureLayout; shown: Crop; full: Box } | null = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.sel-handle');
    const shown = shownCrop(crop, rotate);
    // The whole picture's box on the page, which stays put while cropping.
    const fw = l.w / (1 - shown.l - shown.r);
    const fh = l.h / (1 - shown.t - shown.b);
    const full = { x: l.x - shown.l * fw, y: l.y - shown.t * fh, w: fw, h: fh };
    drag = { kind: handle ? ((handle.dataset.handle ?? 'se') as Handle) : 'move', x: e.clientX, y: e.clientY, l, shown, full };
    box.setPointerCapture(e.pointerId);
    stage.focus({ preventScroll: true });
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / s;
    const dy = (e.clientY - drag.y) / s;
    if (mode === 'crop') cropDrag(drag, dx, dy);
    else placeDrag(drag, dx, dy, e);
  });
  const end = () => {
    drag = null;
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  function placeDrag(d: NonNullable<typeof drag>, dx: number, dy: number, e: PointerEvent) {
    const b = d.l;
    if (d.kind === 'move') {
      let cx = b.x + b.w / 2 + dx;
      let cy = b.y + b.h / 2 + dy;
      // Snap to the middle of the page when close, unless Alt is held.
      if (!e.altKey) {
        if (Math.abs(cx - b.pw / 2) * s < 6) cx = b.pw / 2;
        if (Math.abs(cy - b.ph / 2) * s < 6) cy = b.ph / 2;
      }
      return put({ x: cx - b.w / 2, y: cy - b.h / 2, w: b.w, h: b.h });
    }
    const min = 12 / s;
    const sx = d.kind.includes('e') ? 1 : d.kind.includes('w') ? -1 : 0;
    const sy = d.kind.includes('s') ? 1 : d.kind.includes('n') ? -1 : 0;
    let w = b.w;
    let hh = b.h;
    const corner = sx !== 0 && sy !== 0;
    if (corner && keepShape !== e.shiftKey) {
      // In proportion: the pointer's travel along the diagonal sets the size.
      const grow = 1 + (sx * dx * b.w + sy * dy * b.h) / (b.w * b.w + b.h * b.h);
      w = Math.max(min, b.w * grow);
      hh = (w * b.h) / b.w;
    } else {
      if (sx) w = Math.max(min, b.w + sx * dx);
      if (sy) hh = Math.max(min, b.h + sy * dy);
    }
    // The opposite side or corner stays put.
    const x = sx > 0 ? b.x : sx < 0 ? b.x + b.w - w : b.x + (b.w - w) / 2;
    const y = sy > 0 ? b.y : sy < 0 ? b.y + b.h - hh : b.y + (b.h - hh) / 2;
    put({ x, y, w, h: hh });
  }

  function cropDrag(d: NonNullable<typeof drag>, dx: number, dy: number) {
    const F = d.full;
    const c = { ...d.shown };
    const minW = Math.max(0.02, 8 / s / F.w);
    const minH = Math.max(0.02, 8 / s / F.h);
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    if (d.kind === 'move') {
      // Slide the kept part around inside the picture.
      const mx = clamp(dx / F.w, -c.l, c.r);
      const my = clamp(dy / F.h, -c.t, c.b);
      c.l += mx;
      c.r -= mx;
      c.t += my;
      c.b -= my;
    } else {
      if (d.kind.includes('w')) c.l = clamp(c.l + dx / F.w, 0, 1 - c.r - minW);
      if (d.kind.includes('e')) c.r = clamp(c.r - dx / F.w, 0, 1 - c.l - minW);
      if (d.kind.includes('n')) c.t = clamp(c.t + dy / F.h, 0, 1 - c.b - minH);
      if (d.kind.includes('s')) c.b = clamp(c.b - dy / F.h, 0, 1 - c.t - minH);
    }
    crop = uprightCrop(c, rotate);
    if (!isCropped(crop)) crop = undefined;
    if (o.size === 'fit') {
      // The page is the picture's size, so it simply follows the crop.
      placement = undefined;
      return render();
    }
    put({ x: F.x + c.l * F.w, y: F.y + c.t * F.h, w: F.w * (1 - c.l - c.r), h: F.h * (1 - c.t - c.b) });
  }

  stage.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const move = (dx: number, dy: number) => put({ x: l.x + dx, y: l.y + dy, w: l.w, h: l.h });
    if (e.key === 'ArrowLeft') move(-step, 0);
    else if (e.key === 'ArrowRight') move(step, 0);
    else if (e.key === 'ArrowUp') move(0, -step);
    else if (e.key === 'ArrowDown') move(0, step);
    else if (e.key === '+' || e.key === '=') scaleTo(explicit().scale * (e.shiftKey ? 1.1 : 1.02));
    else if (e.key === '-' || e.key === '_') scaleTo(explicit().scale / (e.shiftKey ? 1.1 : 1.02));
    else if (e.key === 'Enter' && mode === 'crop') {
      mode = 'place';
      render();
    } else return;
    e.preventDefault();
  });

  /* ---------- quick choices ---------- */
  const quick = (label: string, ic: IconNode, title: string, fn: () => void) =>
    h('button', { type: 'button', class: 'btn default pic-quick', title, onclick: fn }, icon(ic, 16), h('span', null, label));
  const cropBtn = quick('Crop', CropIcon, 'Cut the picture down to the part you want', () => {
    mode = mode === 'crop' ? 'place' : 'crop';
    render();
    stage.focus({ preventScroll: true });
  });
  const choices = h(
    'div',
    { class: 'pic-quick-row' },
    cropBtn,
    quick('Fit page', Shrink, 'Make it as big as fits inside the margins, centred', () => {
      placement = { ...explicit(), scale: 1, cx: 0.5, cy: 0.5 };
      render();
    }),
    quick('Fill page', Expand, 'Cover the whole area inside the margins; edges may be cut off', () => {
      placement = { ...explicit(), cx: 0.5, cy: 0.5 };
      placement.scale = fillScale(o, pic.px, pic.py, adj());
      render();
    }),
    quick('Actual size', Scaling, 'The size the picture is meant to print at (96 pixels per inch), in its own proportions', () => {
      const { iw, ih } = pictureSize(pic.px, pic.py, adj());
      const cx = l.x + l.w / 2;
      const cy = l.y + l.h / 2;
      keepShape = true;
      put({ x: cx - iw / 2, y: cy - ih / 2, w: iw, h: ih });
    }),
    quick('Centre', Crosshair, 'Move it to the middle of the page', () => {
      placement = { ...explicit(), cx: 0.5, cy: 0.5 };
      render();
    }),
    quick('Turn left', RotateCcw, 'Turn a quarter turn to the left', () => turn(-90)),
    quick('Turn right', RotateCw, 'Turn a quarter turn to the right', () => turn(90)),
    quick('Reset', Undo2, 'Undo the crop, turn and sizing: back to how the page settings place it', () => {
      placement = undefined;
      crop = undefined;
      rotate = 0;
      keepShape = true;
      mode = 'place';
      render();
    }),
  );

  const body = h(
    'div',
    { class: 'pic-adjust' },
    stage,
    h('div', { class: 'pic-size-row' }, h('span', { class: 'field-label' }, 'Size'), sizeRange, sizePct),
    h(
      'div',
      { class: 'pic-dims-row' },
      h('label', { class: 'pic-dim' }, h('span', { class: 'field-label' }, 'Width'), widthIn),
      lockBtn,
      h('label', { class: 'pic-dim' }, h('span', { class: 'field-label' }, 'Height'), heightIn),
      unitSel,
      readout,
    ),
    choices,
    hint,
  );
  render();

  const res = await modal(`Place ${pic.name}`, body, [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Done', kind: 'primary', value: 'done' },
  ], { className: 'pic-modal' });
  if (res !== 'done') return null;
  return { rotate, placement, crop };
}
