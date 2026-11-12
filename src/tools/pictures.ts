/**
 * Transform pictures: free transform for photos, one or many at a time, and
 * combining them into one picture.
 *
 * Every picture you add becomes a sheet of its own: a canvas with the picture
 * on it. On a sheet, any picture can be moved, scaled, turned, slanted,
 * distorted or given perspective, alone or several together. Sheets can be
 * combined into a new sheet (the originals stay), then saved as pictures or
 * handed to Images → PDF.
 */
import {
  ImagePlus,
  Undo2,
  Redo2,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  RotateCw,
  BringToFront,
  SendToBack,
  CopyPlus,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Combine,
  FileImage,
  Save,
  Eye,
  EyeOff,
  Scaling,
  Shrink,
  Crosshair,
  Link,
  Unlink,
  Frame,
  Copy,
  Move3d,
  type IconNode,
} from 'lucide';
import { h, button, icon, dropzone, withBusy, toast, modal, field, select, numberInput, checkbox, confirmDiscard, textInput } from '../lib/ui';
import { canvasToBlob, download, zipOutputs, type OutputFile } from '../lib/pdf';
import { canWriteDisk, exportFile, exportFiles, fileNameOf } from '../lib/disk';
import { setUnsavedGuard } from '../lib/unsaved';
import {
  apply,
  basis,
  bounds,
  centre,
  contains,
  cssMatrix,
  dist,
  drawMapped,
  inFrame,
  invert,
  isUsable,
  mapQuad,
  mul,
  quadToQuad,
  rectQuad,
  rectToQuad,
  rotateAbout,
  scaling,
  translate,
  type Mat,
  type Pt,
  type Quad,
} from '../lib/transform';
import { readPictures } from './images';
import type { Tool } from './common';

interface Photo {
  name: string;
  url: string;
  img: HTMLImageElement;
  px: number;
  py: number;
}
interface Layer {
  id: number;
  photo: Photo;
  quad: Quad;
  opacity: number;
  hidden: boolean;
}
interface Snap {
  w: number;
  h: number;
  bg: string;
  layers: Layer[];
}
interface Sheet extends Snap {
  id: number;
  name: string;
  undo: Snap[];
  redo: Snap[];
  /** Changed since it was last saved. */
  dirty: boolean;
  view: { z: number; ox: number; oy: number } | null;
}

type Mode = 'free' | 'skew' | 'distort' | 'perspective';
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
/** Where each handle sits in the frame's own 0..1 coordinates. */
const HANDLE_AT: Record<Handle, Pt> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};
const CORNER_INDEX: Partial<Record<Handle, number>> = { nw: 0, ne: 1, se: 2, sw: 3 };
const SIDE_INDEX: Partial<Record<Handle, [number, number]>> = { n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0] };

const MODES: [Mode, string, string][] = [
  ['free', 'Free', 'Drag a corner to resize, a side to stretch, just outside a corner to turn. Hold Ctrl on a corner to distort or on a side to slant.'],
  ['skew', 'Skew', 'Drag a side to slant the picture along it. Corners still resize.'],
  ['distort', 'Distort', 'Drag any corner or side anywhere; the picture follows.'],
  ['perspective', 'Perspective', 'Drag a corner and the one opposite it on the same side moves the other way, like tilting the picture away from you.'],
];

/** The biggest canvas a browser can reliably draw. */
const MAX_SIDE = 16000;
const MAX_AREA = 16384 * 16384 * 0.9;

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="4"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/></g><g stroke="#111" stroke-width="2"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/></g></svg>',
)}") 12 12, crosshair`;

let nextId = 1;
const copyLayer = (l: Layer, keepId = true): Layer => ({ ...l, id: keepId ? l.id : nextId++, quad: l.quad.map((p) => ({ ...p })) as Quad });
const snapOf = (s: Snap): Snap => ({ w: s.w, h: s.h, bg: s.bg, layers: s.layers.map((l) => copyLayer(l)) });
const layerMatrix = (l: Layer) => rectToQuad(l.photo.px, l.photo.py, l.quad);
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const angleOf = (q: Quad) => Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Draw a sheet into a canvas, `scale` times its own size. */
export function renderSheet(s: Snap, scale = 1, background?: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(s.w * scale));
  c.height = Math.max(1, Math.round(s.h * scale));
  const g = c.getContext('2d')!;
  const bg = s.bg !== 'none' ? s.bg : background;
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
  }
  for (const l of s.layers) {
    if (l.hidden) continue;
    const m = layerMatrix(l);
    if (m) drawMapped(g, l.photo.img, l.photo.px, l.photo.py, mul(scaling(scale, scale), m), l.opacity);
  }
  return c;
}

/** The pictures of a sheet drawn into `host`, fitted into a w×h box. Used for thumbnails. */
function miniSheet(s: Sheet, w: number, hh: number) {
  const z = Math.min(w / s.w, hh / s.h);
  const ox = (w - s.w * z) / 2;
  const oy = (hh - s.h * z) / 2;
  const S: Mat = [z, 0, ox, 0, z, oy, 0, 0, 1];
  const board = h('div', { class: `pt-mini-canvas${s.bg === 'none' ? ' checker' : ''}`, style: `left:${ox}px;top:${oy}px;width:${s.w * z}px;height:${s.h * z}px;${s.bg !== 'none' ? `background:${s.bg}` : ''}` });
  const layers = s.layers
    .filter((l) => !l.hidden)
    .map((l) => {
      const m = layerMatrix(l);
      const img = h('img', { src: l.photo.url, alt: '', draggable: false, class: 'pt-img' });
      img.style.width = `${l.photo.px}px`;
      img.style.height = `${l.photo.py}px`;
      img.style.opacity = String(l.opacity);
      if (m) img.style.transform = cssMatrix(mul(S, m));
      return img;
    });
  return h('div', { class: 'pt-mini', style: `width:${w}px;height:${hh}px` }, board, ...layers);
}

const SVG = 'http://www.w3.org/2000/svg';
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
const pointsAttr = (q: Pt[]) => q.map((p) => `${p.x},${p.y}`).join(' ');

export const picturesTool: Tool = {
  id: 'pictures',
  title: 'Transform pictures',
  blurb: 'Move, resize, turn, slant and distort photos freely, many at once, then combine them into one picture or a PDF.',
  icon: Move3d,
  group: 'Edit & sign',
  wide: true,
  keepAlive: true,
  mount(root, ctx) {
    const sheets: Sheet[] = [];
    let cur: Sheet | null = null;
    /** Sheets ticked in the list, for combining, saving and making a PDF. */
    const checked = new Set<number>();
    /** Selected pictures on the current sheet. */
    let sel = new Set<number>();
    /** The frame around several selected pictures, which turns and slants with them. */
    let groupFrame: Quad | null = null;
    let mode: Mode = 'free';
    let keepShape = true;
    let guides: { x?: number; y?: number } = {};
    let marquee: { a: Pt; b: Pt } | null = null;
    let spaceDown = false;

    setUnsavedGuard({ names: () => sheets.filter((s) => s.dirty).map((s) => s.name) });

    /* ---------- empty state ---------- */
    const accept = 'image/*,.heic,.heif,.tif,.tiff,.avif,.svg';
    const intro = h(
      'div',
      { class: 'ed-intro' },
      h('h1', { class: 'ed-intro-title' }, 'Transform pictures'),
      h('p', { class: 'muted pt-intro-text' }, 'Each picture opens on a canvas of its own. Move, resize, turn, slant, distort or add perspective, to one picture or several at once. Combine pictures into one whenever you like, then save them as pictures or make a PDF.'),
      dropzone({ accept, multiple: true, title: 'Choose pictures or drop them here', hint: 'JPG, PNG, HEIC, WebP, GIF, BMP, TIFF, SVG. Nothing leaves your computer.', icon: ImagePlus, onFiles: (f) => void addFiles(f, 'sheets') }),
    );
    const fileInput = h('input', { type: 'file', accept, multiple: true, hidden: true }) as HTMLInputElement;
    let fileTarget: 'sheets' | 'layers' = 'sheets';
    fileInput.addEventListener('change', () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      if (files.length) void addFiles(files, fileTarget);
    });
    const pick = (target: 'sheets' | 'layers') => {
      fileTarget = target;
      fileInput.click();
    };

    /* ---------- toolbar ---------- */
    const tb = (label: string, ic: IconNode, fn: () => void) => {
      const b = h('button', { type: 'button', class: 'tool-btn', title: label, 'aria-label': label, onclick: fn }, icon(ic, 18));
      return b as HTMLButtonElement;
    };
    const undoBtn = tb('Undo (Ctrl+Z)', Undo2, () => undo());
    const redoBtn = tb('Redo (Ctrl+Y)', Redo2, () => redo());
    const modeBtns = new Map<Mode, HTMLButtonElement>();
    const modeGroup = h(
      'div',
      { class: 'pt-seg', role: 'radiogroup', 'aria-label': 'Transform' },
      MODES.map(([m, label, tip]) => {
        const b = h('button', { type: 'button', class: 'pt-seg-btn', role: 'radio', title: tip, onclick: () => setMode(m) }, label) as HTMLButtonElement;
        modeBtns.set(m, b);
        return b;
      }),
    );
    const selButtons = [
      tb('Flip left to right', FlipHorizontal2, () => flip('h')),
      tb('Flip upside down', FlipVertical2, () => flip('v')),
      tb('Turn left', RotateCcw, () => turnBy(-90)),
      tb('Turn right', RotateCw, () => turnBy(90)),
      tb('Bring forward (Ctrl+])', BringToFront, () => reorder(1)),
      tb('Send backward (Ctrl+[)', SendToBack, () => reorder(-1)),
      tb('Duplicate (Ctrl+J)', CopyPlus, () => duplicateLayers()),
      tb('Delete (Del)', Trash2, () => deleteLayers()),
    ];
    const zoomLabel = h('span', { class: 'zoom-label' }, '100%');
    const bar = h(
      'div',
      { class: 'ed-bar pt-bar' },
      button('Add pictures', () => pick('sheets'), { icon: ImagePlus, kind: 'default', title: 'Add pictures, each on a canvas of its own' }),
      h('span', { class: 'sep' }),
      h('div', { class: 'ed-tools' }, undoBtn, redoBtn),
      h('span', { class: 'sep' }),
      modeGroup,
      h('span', { class: 'sep' }),
      h('div', { class: 'ed-tools' }, ...selButtons),
      h('span', { class: 'spacer' }),
      h('div', { class: 'ed-tools' }, tb('Zoom out', ZoomOut, () => zoomBy(1 / 1.25)), zoomLabel, tb('Zoom in', ZoomIn, () => zoomBy(1.25)), tb('Fit on screen (Ctrl+0)', Maximize, () => fitView())),
    );
    const hint = h('div', { class: 'ed-hint' });

    /* ---------- sheets (left) ---------- */
    const sheetList = h('div', { class: 'pt-sheet-list' });
    const sheetCount = h('span', { class: 'muted small' });
    const allToggle = h('button', { type: 'button', class: 'pt-text-btn', onclick: () => toggleAll() });
    const combineBtn = button('Combine', () => void combine(), { icon: Combine, kind: 'primary', title: 'Put the ticked pictures together on a new canvas. The originals stay.' });
    const pdfBtn = button('Make PDF', () => void makePdf(), { icon: FileImage, kind: 'default', title: 'Send the ticked pictures (or all of them) to Images → PDF' });
    const saveBtn = button('Save', () => void savePictures(), { icon: Save, kind: 'default', title: 'Save as PNG, JPG or WebP pictures' });
    const sheetsPane = h(
      'aside',
      { class: 'pt-sheets', 'aria-label': 'Pictures' },
      h('div', { class: 'pt-pane-head' }, h('h3', null, 'Pictures'), sheetCount, allToggle),
      sheetList,
      h('div', { class: 'pt-sheet-actions' }, combineBtn, h('div', { class: 'pt-row' }, pdfBtn, saveBtn)),
    );

    /* ---------- stage (centre) ---------- */
    const canvasEl = h('div', { class: 'pt-canvas' });
    const layerHost = h('div', { class: 'pt-layers' });
    const boundsEl = h('div', { class: 'pt-bounds' });
    const overlay = svgEl('svg', { class: 'pt-overlay' });
    const stage = h(
      'div',
      {
        class: 'pt-stage',
        tabindex: 0,
        'aria-label': 'Canvas. Click a picture to select it, Shift-click to select more. Arrow keys move the selection.',
      },
      canvasEl,
      layerHost,
      boundsEl,
      overlay,
    );
    const imgEls = new Map<number, HTMLImageElement>();

    /* ---------- properties (right) ---------- */
    const num = (label: string, step = 1) => {
      const i = h('input', { type: 'number', step, class: 'pt-num', 'aria-label': label }) as HTMLInputElement;
      return i;
    };
    const xIn = num('Centre across, pixels');
    const yIn = num('Centre down, pixels');
    const wIn = num('Width, pixels');
    const hIn = num('Height, pixels');
    const aIn = num('Angle, degrees', 0.1);
    const linkBtn = h('button', { type: 'button', class: 'tool-btn pt-link', onclick: () => ((keepShape = !keepShape), paintProps()) }) as HTMLButtonElement;
    const opacityIn = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'pt-range', 'aria-label': 'Opacity' }) as HTMLInputElement;
    const opacityVal = h('span', { class: 'muted small pt-range-val' });
    const selTitle = h('h3', null, 'Selection');
    const smallBtn = (label: string, ic: IconNode, title: string, fn: () => void) => button(label, fn, { icon: ic, kind: 'ghost', title });
    const selSection = h(
      'section',
      { class: 'pt-section' },
      selTitle,
      h(
        'div',
        { class: 'pt-grid2' },
        h('label', { class: 'pt-field' }, h('span', null, 'X'), xIn),
        h('label', { class: 'pt-field' }, h('span', null, 'Y'), yIn),
        h('label', { class: 'pt-field' }, h('span', null, 'W'), wIn),
        h('label', { class: 'pt-field' }, h('span', null, 'H'), hIn),
        h('label', { class: 'pt-field' }, h('span', null, '∠'), aIn),
        linkBtn,
      ),
      h('label', { class: 'pt-opacity' }, h('span', { class: 'field-label' }, 'Opacity'), opacityIn, opacityVal),
      h(
        'div',
        { class: 'pt-btn-grid' },
        smallBtn('Fit canvas', Shrink, 'Make it as big as fits on the canvas, centred', () => fitSelection()),
        smallBtn('Centre', Crosshair, 'Move it to the middle of the canvas', () => centreSelection()),
        smallBtn('Straighten', Frame, 'Undo the turn, slant and distortion: upright, in its own proportions, the same width', () => straighten()),
        smallBtn('Actual size', Scaling, 'Upright at the size of the picture file, one pixel for one pixel', () => actualSize()),
      ),
    );
    const noSel = h('p', { class: 'muted small' }, 'Click a picture to transform it. Shift-click or drag a box around several to transform them together.');

    const nameIn = textInput('', 'Name');
    nameIn.setAttribute('aria-label', 'Name');
    const cwIn = num('Canvas width, pixels');
    const chIn = num('Canvas height, pixels');
    const bgSel = select<string>(
      [
        ['none', 'See-through'],
        ['#ffffff', 'White'],
        ['#000000', 'Black'],
        ['custom', 'Colour…'],
      ],
      'none',
    );
    bgSel.setAttribute('aria-label', 'Background');
    const bgColor = h('input', { type: 'color', value: '#ffffff', class: 'pt-color', 'aria-label': 'Background colour' }) as HTMLInputElement;
    const canvasSection = h(
      'section',
      { class: 'pt-section' },
      h('h3', null, 'Canvas'),
      h('label', { class: 'pt-field wide' }, h('span', null, 'Name'), nameIn),
      h('div', { class: 'pt-grid2' }, h('label', { class: 'pt-field' }, h('span', null, 'W'), cwIn), h('label', { class: 'pt-field' }, h('span', null, 'H'), chIn)),
      h('div', { class: 'pt-bg-row' }, h('span', { class: 'field-label' }, 'Background'), bgSel, bgColor),
      h('div', { class: 'pt-btn-grid' }, smallBtn('Fit to pictures', Shrink, 'Trim or grow the canvas to just hold the pictures on it', () => fitCanvas())),
    );
    const layerList = h('div', { class: 'pt-layer-list', role: 'listbox', 'aria-label': 'Pictures on this canvas', 'aria-multiselectable': 'true' });
    const layersSection = h(
      'section',
      { class: 'pt-section' },
      h('div', { class: 'pt-pane-head' }, h('h3', null, 'On this canvas'), h('button', { type: 'button', class: 'pt-text-btn', onclick: () => pick('layers'), title: 'Add pictures onto this canvas' }, '+ Add')),
      layerList,
      h('p', { class: 'muted small' }, 'The top of the list is in front. Drop pictures on the canvas to add them here.'),
    );
    const propsPane = h('aside', { class: 'pt-props', 'aria-label': 'Properties' }, selSection, noSel, canvasSection, layersSection);

    const workspace = h('div', { class: 'ed-workspace pt-workspace', hidden: true }, bar, hint, h('div', { class: 'pt-body' }, sheetsPane, stage, propsPane));
    root.append(intro, workspace, fileInput);

    /* ---------- adding pictures ---------- */
    async function toPhotos(files: File[]): Promise<Photo[]> {
      const items = await withBusy('Reading pictures…', () => readPictures(files));
      if (!items?.length) return [];
      const out: Photo[] = [];
      for (const it of items) {
        const img = new Image();
        img.src = it.url;
        await img.decode().catch(() => undefined);
        out.push({ name: it.name, url: it.url, img, px: it.px, py: it.py });
      }
      return out;
    }

    async function addFiles(files: File[], target: 'sheets' | 'layers') {
      const photos = await toPhotos(files);
      if (!photos.length) return;
      if (target === 'layers' && cur) {
        const s = cur;
        const before = snapOf(s);
        const added: number[] = [];
        for (const [i, p] of photos.entries()) {
          // As big as it is, or shrunk to fit most of the canvas, a little apart from the one before.
          const k = Math.min(1, (s.w * 0.8) / p.px, (s.h * 0.8) / p.py);
          const w = p.px * k;
          const hh = p.py * k;
          const off = i * Math.min(s.w, s.h) * 0.04;
          const l: Layer = { id: nextId++, photo: p, quad: rectQuad((s.w - w) / 2 + off, (s.h - hh) / 2 + off, w, hh), opacity: 1, hidden: false };
          s.layers.push(l);
          added.push(l.id);
        }
        commit(before);
        setSel(added);
        return;
      }
      let first: Sheet | null = null;
      for (const p of photos) {
        const s: Sheet = {
          id: nextId++,
          name: p.name.replace(/\.[^.]+$/, '') || 'Picture',
          w: p.px,
          h: p.py,
          bg: 'none',
          layers: [{ id: nextId++, photo: p, quad: rectQuad(0, 0, p.px, p.py), opacity: 1, hidden: false }],
          undo: [],
          redo: [],
          dirty: false,
          view: null,
        };
        sheets.push(s);
        first ??= s;
      }
      if (first) open(first);
    }

    /* ---------- sheets ---------- */
    function open(s: Sheet) {
      cur = s;
      sel = new Set(s.layers.length === 1 ? [s.layers[0].id] : []);
      groupFrame = null;
      layerHost.replaceChildren();
      imgEls.clear();
      intro.hidden = true;
      workspace.hidden = false;
      paintAll();
      if (!s.view) requestAnimationFrame(() => fitView());
    }

    function paintAll() {
      paintSheets();
      paint();
      paintProps();
      paintLayers();
      paintBar();
    }

    function paintSheets() {
      for (const id of [...checked]) if (!sheets.some((s) => s.id === id)) checked.delete(id);
      sheetCount.textContent = String(sheets.length);
      allToggle.textContent = checked.size === sheets.length && sheets.length ? 'Untick all' : 'Tick all';
      sheetList.replaceChildren(
        ...sheets.map((s) => {
          const box = h('input', { type: 'checkbox', checked: checked.has(s.id), 'aria-label': `Tick ${s.name}`, title: 'Tick to combine, save or make a PDF' }) as HTMLInputElement;
          box.addEventListener('click', (e) => e.stopPropagation());
          box.addEventListener('change', () => {
            if (box.checked) checked.add(s.id);
            else checked.delete(s.id);
            paintSheets();
          });
          const card = h(
            'div',
            {
              class: `pt-sheet${s === cur ? ' active' : ''}${checked.has(s.id) ? ' ticked' : ''}`,
              role: 'button',
              tabindex: 0,
              'aria-current': s === cur ? 'true' : undefined,
              title: `${s.name} · ${Math.round(s.w)} × ${Math.round(s.h)} px`,
              onclick: () => s !== cur && open(s),
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (s !== cur) open(s);
                }
              },
            },
            h('div', { class: 'pt-thumb' }, miniSheet(s, 168, 96)),
            h(
              'div',
              { class: 'pt-sheet-meta' },
              box,
              h('span', { class: 'pt-sheet-name' }, s.name),
              s.dirty ? h('span', { class: 'pt-dot', title: 'Changed since it was saved' }) : null,
              h(
                'span',
                { class: 'pt-sheet-tools' },
                h('button', { type: 'button', class: 'mini icon', title: 'Duplicate', 'aria-label': `Duplicate ${s.name}`, onclick: (e: Event) => (e.stopPropagation(), duplicateSheet(s)) }, icon(Copy, 14)),
                h('button', { type: 'button', class: 'mini icon', title: 'Remove', 'aria-label': `Remove ${s.name}`, onclick: (e: Event) => (e.stopPropagation(), void removeSheet(s)) }, icon(Trash2, 14)),
              ),
            ),
            h('div', { class: 'muted small pt-sheet-size' }, `${Math.round(s.w)} × ${Math.round(s.h)} px${s.layers.length > 1 ? ` · ${s.layers.length} pictures` : ''}`),
          );
          return card;
        }),
      );
      const n = checked.size;
      combineBtn.disabled = n < 2;
      combineBtn.querySelector('span')!.textContent = n >= 2 ? `Combine ${n}` : 'Combine';
      combineBtn.title = n >= 2 ? 'Put the ticked pictures together on a new canvas. The originals stay.' : 'Tick two or more pictures to combine them';
    }

    function toggleAll() {
      if (checked.size === sheets.length) checked.clear();
      else sheets.forEach((s) => checked.add(s.id));
      paintSheets();
    }

    function duplicateSheet(s: Sheet) {
      const copy: Sheet = { ...snapOf(s), layers: s.layers.map((l) => copyLayer(l, false)), id: nextId++, name: `${s.name} copy`, undo: [], redo: [], dirty: true, view: null };
      sheets.splice(sheets.indexOf(s) + 1, 0, copy);
      open(copy);
    }

    async function removeSheet(s: Sheet) {
      if (s.dirty) {
        const ok = await confirmDiscard({ title: 'Remove this picture?', message: `“${s.name}” has changes that haven’t been saved.`, confirm: 'Remove', cancel: 'Keep it' });
        if (!ok) return;
      }
      const i = sheets.indexOf(s);
      sheets.splice(i, 1);
      checked.delete(s.id);
      // Pictures no sheet uses any more can let go of their memory.
      const used = new Set(sheets.flatMap((x) => [...x.layers, ...x.undo.flatMap((u) => u.layers), ...x.redo.flatMap((u) => u.layers)].map((l) => l.photo.url)));
      for (const l of [...s.layers, ...s.undo.flatMap((u) => u.layers), ...s.redo.flatMap((u) => u.layers)]) if (!used.has(l.photo.url)) URL.revokeObjectURL(l.photo.url);
      if (s === cur) {
        cur = null;
        const next = sheets[Math.min(i, sheets.length - 1)];
        if (next) return open(next);
        intro.hidden = false;
        workspace.hidden = true;
        return;
      }
      paintSheets();
    }

    /* ---------- history ---------- */
    function commit(before: Snap, s = cur) {
      if (!s) return;
      s.undo.push(before);
      if (s.undo.length > 100) s.undo.shift();
      s.redo = [];
      s.dirty = true;
      paintAll();
    }
    function restore(s: Sheet, snap: Snap) {
      s.w = snap.w;
      s.h = snap.h;
      s.bg = snap.bg;
      s.layers = snap.layers;
      const ids = new Set(s.layers.map((l) => l.id));
      sel = new Set([...sel].filter((id) => ids.has(id)));
      groupFrame = null;
      s.dirty = true;
      paintAll();
    }
    function undo() {
      const s = cur;
      const snap = s?.undo.pop();
      if (!s || !snap) return;
      s.redo.push(snapOf(s));
      restore(s, snap);
    }
    function redo() {
      const s = cur;
      const snap = s?.redo.pop();
      if (!s || !snap) return;
      s.undo.push(snapOf(s));
      restore(s, snap);
    }

    /* ---------- selection ---------- */
    const selected = () => (cur ? cur.layers.filter((l) => sel.has(l.id)) : []);
    function setSel(ids: Iterable<number>) {
      sel = new Set(ids);
      groupFrame = null;
      paint();
      paintProps();
      paintLayers();
      paintBar();
    }
    /** The frame being transformed: the picture's own corners, or a box around several. */
    function frame(): Quad | null {
      const ls = selected();
      if (!ls.length) return null;
      if (ls.length === 1) return ls[0].quad;
      if (groupFrame) return groupFrame;
      const b = bounds(ls.flatMap((l) => l.quad));
      return rectQuad(b.x, b.y, b.w, b.h);
    }

    /**
     * Move every selected picture through `m`, from where they were in
     * `starts`. Refused (nothing changes) if any picture would fold over.
     */
    function applyToSel(m: Mat, F0: Quad, starts: Map<number, Quad>) {
      const next = new Map<number, Quad>();
      for (const [id, q] of starts) {
        const nq = mapQuad(m, q);
        if (!isUsable(nq, 0.5)) return false;
        next.set(id, nq);
      }
      for (const l of selected()) {
        const q = next.get(l.id);
        if (q) l.quad = q;
      }
      if (sel.size > 1) groupFrame = mapQuad(m, F0);
      return true;
    }
    function startsOf() {
      return new Map(selected().map((l) => [l.id, l.quad.map((p) => ({ ...p })) as Quad]));
    }
    /** One change to the selection, with its own undo step. */
    function transformSel(m: Mat | null) {
      const F = frame();
      if (!cur || !F || !m) return;
      const before = snapOf(cur);
      if (!applyToSel(m, F, startsOf())) return toast('That would fold the picture over itself.', 'error');
      commit(before);
    }
    const local = (F: Quad, m: Mat) => inFrame(F, m);
    function flip(axis: 'h' | 'v') {
      const F = frame();
      if (F) transformSel(local(F, axis === 'h' ? [-1, 0, 1, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 1, 0, 0, 1]));
    }
    function turnBy(by: number) {
      const F = frame();
      if (F) transformSel(rotateAbout(centre(F), rad(by)));
    }
    function fitSelection() {
      const F = frame();
      if (!F || !cur) return;
      const b = bounds(F);
      const k = Math.min(cur.w / b.w, cur.h / b.h);
      transformSel(mul(translate(cur.w / 2, cur.h / 2), mul(scaling(k, k), translate(-(b.x + b.w / 2), -(b.y + b.h / 2)))));
    }
    function centreSelection() {
      const F = frame();
      if (!F || !cur) return;
      const b = bounds(F);
      transformSel(translate(cur.w / 2 - (b.x + b.w / 2), cur.h / 2 - (b.y + b.h / 2)));
    }
    /** Each selected picture upright in its own proportions, keeping its centre and width (or its file size). */
    function reshape(width: (l: Layer) => number) {
      if (!cur || !sel.size) return;
      const before = snapOf(cur);
      for (const l of selected()) {
        const c = centre(l.quad);
        const w = width(l);
        const hh = (w * l.photo.py) / l.photo.px;
        l.quad = rectQuad(c.x - w / 2, c.y - hh / 2, w, hh);
      }
      groupFrame = null;
      commit(before);
    }
    const straighten = () => reshape((l) => Math.max(1, dist(l.quad[0], l.quad[1])));
    const actualSize = () => reshape((l) => l.photo.px);

    function reorder(d: 1 | -1) {
      if (!cur || !sel.size) return;
      const before = snapOf(cur);
      const ls = cur.layers;
      const idx = ls.map((l, i) => (sel.has(l.id) ? i : -1)).filter((i) => i >= 0);
      if (d > 0) idx.reverse();
      let moved = false;
      for (const i of idx) {
        const j = i + d;
        if (j < 0 || j >= ls.length || sel.has(ls[j].id)) continue;
        [ls[i], ls[j]] = [ls[j], ls[i]];
        moved = true;
      }
      if (moved) commit(before);
    }
    function duplicateLayers() {
      if (!cur || !sel.size) return;
      const before = snapOf(cur);
      const off = Math.max(8, Math.min(cur.w, cur.h) * 0.02);
      const copies = selected().map((l) => ({ ...copyLayer(l, false), quad: mapQuad(translate(off, off), l.quad) }));
      cur.layers.push(...copies);
      commit(before);
      setSel(copies.map((l) => l.id));
    }
    function deleteLayers() {
      if (!cur || !sel.size) return;
      const before = snapOf(cur);
      cur.layers = cur.layers.filter((l) => !sel.has(l.id));
      sel = new Set();
      groupFrame = null;
      commit(before);
    }

    /* ---------- the canvas itself ---------- */
    function resizeCanvas(w: number, hh: number) {
      if (!cur) return;
      w = Math.round(Math.max(1, Math.min(MAX_SIDE, w)));
      hh = Math.round(Math.max(1, Math.min(MAX_SIDE, hh)));
      if (w === cur.w && hh === cur.h) return paintProps();
      const before = snapOf(cur);
      // Grows or shrinks about the middle, so the pictures stay centred.
      const m = translate((w - cur.w) / 2, (hh - cur.h) / 2);
      for (const l of cur.layers) l.quad = mapQuad(m, l.quad);
      if (groupFrame) groupFrame = mapQuad(m, groupFrame);
      cur.w = w;
      cur.h = hh;
      commit(before);
      fitView();
    }
    function fitCanvas() {
      if (!cur) return;
      const vis = cur.layers.filter((l) => !l.hidden);
      if (!vis.length) return toast('There are no pictures on this canvas.');
      const b = bounds(vis.flatMap((l) => l.quad));
      const x0 = Math.floor(b.x);
      const y0 = Math.floor(b.y);
      const w = Math.min(MAX_SIDE, Math.ceil(b.x + b.w) - x0);
      const hh = Math.min(MAX_SIDE, Math.ceil(b.y + b.h) - y0);
      const before = snapOf(cur);
      const m = translate(-x0, -y0);
      for (const l of cur.layers) l.quad = mapQuad(m, l.quad);
      groupFrame = null;
      cur.w = Math.max(1, w);
      cur.h = Math.max(1, hh);
      commit(before);
      fitView();
    }
    cwIn.addEventListener('change', () => cur && resizeCanvas(+cwIn.value || cur.w, cur.h));
    chIn.addEventListener('change', () => cur && resizeCanvas(cur.w, +chIn.value || cur.h));
    nameIn.addEventListener('change', () => {
      if (!cur) return;
      cur.name = nameIn.value.trim() || cur.name;
      paintSheets();
    });
    function setBg(v: string) {
      if (!cur || v === cur.bg) return;
      const before = snapOf(cur);
      cur.bg = v;
      commit(before);
    }
    bgSel.addEventListener('change', () => setBg(bgSel.value === 'custom' ? bgColor.value : bgSel.value));
    // The colour shows while it is being picked and becomes one undo step when it is chosen.
    let bgBefore: Snap | null = null;
    bgColor.addEventListener('input', () => {
      if (!cur) return;
      bgBefore ??= snapOf(cur);
      bgSel.value = 'custom';
      cur.bg = bgColor.value;
      paint();
    });
    bgColor.addEventListener('change', () => {
      if (!cur) return;
      const before = bgBefore ?? snapOf(cur);
      bgBefore = null;
      cur.bg = bgColor.value;
      commit(before);
    });

    /* ---------- numbers for the selection ---------- */
    function typedSize(which: 'w' | 'h') {
      const F = frame();
      if (!F) return;
      const v = +(which === 'w' ? wIn : hIn).value;
      const cw = dist(F[0], F[1]);
      const chh = dist(F[0], F[3]);
      if (!(v >= 1) || !cw || !chh) return paintProps();
      const k = v / (which === 'w' ? cw : chh);
      const kx = which === 'w' || keepShape ? k : 1;
      const ky = which === 'h' || keepShape ? k : 1;
      transformSel(local(F, [kx, 0, 0.5 - 0.5 * kx, 0, ky, 0.5 - 0.5 * ky, 0, 0, 1]));
    }
    wIn.addEventListener('change', () => typedSize('w'));
    hIn.addEventListener('change', () => typedSize('h'));
    xIn.addEventListener('change', () => {
      const F = frame();
      if (F && Number.isFinite(+xIn.value)) transformSel(translate(+xIn.value - centre(F).x, 0));
    });
    yIn.addEventListener('change', () => {
      const F = frame();
      if (F && Number.isFinite(+yIn.value)) transformSel(translate(0, +yIn.value - centre(F).y));
    });
    aIn.addEventListener('change', () => {
      const F = frame();
      if (F && Number.isFinite(+aIn.value)) transformSel(rotateAbout(centre(F), rad(+aIn.value) - angleOf(F)));
    });
    let opacityBefore: Snap | null = null;
    opacityIn.addEventListener('input', () => {
      if (!cur) return;
      opacityBefore ??= snapOf(cur);
      for (const l of selected()) l.opacity = +opacityIn.value / 100;
      opacityVal.textContent = `${opacityIn.value}%`;
      paint();
    });
    opacityIn.addEventListener('change', () => {
      if (opacityBefore) commit(opacityBefore);
      opacityBefore = null;
    });

    function paintProps() {
      const F = frame();
      const s = cur;
      selSection.hidden = !F;
      noSel.hidden = !!F || !s?.layers.length;
      const set = (i: HTMLInputElement, v: number) => {
        if (document.activeElement !== i) i.value = String(round1(v));
      };
      if (F) {
        const c = centre(F);
        set(xIn, c.x);
        set(yIn, c.y);
        set(wIn, dist(F[0], F[1]));
        set(hIn, dist(F[0], F[3]));
        let a = deg(angleOf(F));
        if (a <= -180) a += 360;
        set(aIn, Math.abs(a) < 0.05 ? 0 : a);
        const ls = selected();
        selTitle.textContent = ls.length === 1 ? ls[0].photo.name : `${ls.length} pictures`;
        selTitle.title = selTitle.textContent;
        const op = Math.round((ls[0]?.opacity ?? 1) * 100);
        if (document.activeElement !== opacityIn) opacityIn.value = String(op);
        opacityVal.textContent = `${opacityIn.value}%`;
      }
      linkBtn.replaceChildren(icon(keepShape ? Link : Unlink, 16));
      linkBtn.title = keepShape ? 'Typed sizes keep the proportions. Click to size width and height apart' : 'Width and height are typed apart. Click to keep the proportions';
      linkBtn.setAttribute('aria-label', 'Keep proportions');
      linkBtn.setAttribute('aria-pressed', String(keepShape));
      if (s) {
        if (document.activeElement !== nameIn) nameIn.value = s.name;
        set(cwIn, s.w);
        set(chIn, s.h);
        const preset = ['none', '#ffffff', '#000000'].includes(s.bg);
        bgSel.value = preset ? s.bg : 'custom';
        bgColor.hidden = preset;
        if (!preset) bgColor.value = s.bg;
      }
    }

    function paintLayers() {
      const s = cur;
      if (!s) return layerList.replaceChildren();
      layerList.replaceChildren(
        ...[...s.layers].reverse().map((l) => {
          const eye = h(
            'button',
            {
              type: 'button',
              class: 'mini icon',
              title: l.hidden ? 'Show' : 'Hide',
              'aria-label': `${l.hidden ? 'Show' : 'Hide'} ${l.photo.name}`,
              onclick: (e: Event) => {
                e.stopPropagation();
                const before = snapOf(s);
                l.hidden = !l.hidden;
                commit(before);
              },
            },
            icon(l.hidden ? EyeOff : Eye, 14),
          );
          return h(
            'div',
            {
              class: `pt-layer${sel.has(l.id) ? ' selected' : ''}${l.hidden ? ' hidden-layer' : ''}`,
              role: 'option',
              tabindex: 0,
              'aria-selected': String(sel.has(l.id)),
              onclick: (e: MouseEvent) => pickLayer(l, e.shiftKey || e.ctrlKey || e.metaKey),
              onkeydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  pickLayer(l, e.shiftKey || e.ctrlKey);
                }
              },
            },
            h('img', { src: l.photo.url, alt: '', class: 'pt-layer-thumb', draggable: false }),
            h('span', { class: 'pt-layer-name', title: l.photo.name }, l.photo.name),
            eye,
          );
        }),
      );
    }
    function pickLayer(l: Layer, add: boolean) {
      if (!add) return setSel([l.id]);
      const next = new Set(sel);
      if (next.has(l.id)) next.delete(l.id);
      else next.add(l.id);
      setSel(next);
    }

    function paintBar() {
      const s = cur;
      undoBtn.disabled = !s?.undo.length;
      redoBtn.disabled = !s?.redo.length;
      for (const b of selButtons) b.disabled = !sel.size;
      for (const [m, b] of modeBtns) b.setAttribute('aria-checked', String(m === mode));
      const tip = MODES.find(([m]) => m === mode)![2];
      hint.textContent = sel.size
        ? `${tip} Shift keeps proportions free or turns in 15° steps; Alt works from the centre. Arrow keys nudge it.`
        : 'Click a picture to select it; Shift-click or drag a box to select several. Scroll to pan, Ctrl+scroll to zoom.';
    }
    function setMode(m: Mode) {
      mode = m;
      paintBar();
    }

    /* ---------- view ---------- */
    function stageSize() {
      const r = stage.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }
    function view() {
      return cur?.view ?? { z: 1, ox: 0, oy: 0 };
    }
    function fitView() {
      if (!cur) return;
      const { w, h: hh } = stageSize();
      if (!w || !hh) return;
      const pad = 48;
      const z = Math.max(0.01, Math.min(8, (w - pad * 2) / cur.w, (hh - pad * 2) / cur.h));
      cur.view = { z, ox: (w - cur.w * z) / 2, oy: (hh - cur.h * z) / 2 };
      paint();
    }
    function zoomBy(k: number, at?: Pt) {
      if (!cur) return;
      const v = view();
      const { w, h: hh } = stageSize();
      const p = at ?? { x: w / 2, y: hh / 2 };
      const z = Math.max(0.01, Math.min(32, v.z * k));
      cur.view = { z, ox: p.x - ((p.x - v.ox) * z) / v.z, oy: p.y - ((p.y - v.oy) * z) / v.z };
      paint();
    }
    const toScreen = (p: Pt): Pt => {
      const v = view();
      return { x: p.x * v.z + v.ox, y: p.y * v.z + v.oy };
    };
    const toCanvas = (p: Pt): Pt => {
      const v = view();
      return { x: (p.x - v.ox) / v.z, y: (p.y - v.oy) / v.z };
    };
    const screenQuad = (q: Quad) => q.map(toScreen) as Quad;
    function stagePoint(e: { clientX: number; clientY: number }): Pt {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    /* ---------- painting the stage ---------- */
    function paint() {
      const s = cur;
      if (!s) return;
      const v = view();
      const S: Mat = [v.z, 0, v.ox, 0, v.z, v.oy, 0, 0, 1];
      zoomLabel.textContent = `${Math.round(v.z * 100)}%`;
      const box = `left:${v.ox}px;top:${v.oy}px;width:${s.w * v.z}px;height:${s.h * v.z}px;`;
      canvasEl.setAttribute('style', box + (s.bg !== 'none' ? `background:${s.bg}` : ''));
      canvasEl.classList.toggle('checker', s.bg === 'none');
      boundsEl.setAttribute('style', box);

      const live = new Set(s.layers.map((l) => l.id));
      for (const [id, el] of imgEls) {
        if (!live.has(id)) {
          el.remove();
          imgEls.delete(id);
        }
      }
      s.layers.forEach((l, i) => {
        let el = imgEls.get(l.id);
        if (!el || el.dataset.src !== l.photo.url) {
          el?.remove();
          el = h('img', { src: l.photo.url, alt: '', draggable: false, class: 'pt-img' });
          el.dataset.src = l.photo.url;
          el.style.width = `${l.photo.px}px`;
          el.style.height = `${l.photo.py}px`;
          imgEls.set(l.id, el);
        }
        if (layerHost.children[i] !== el) layerHost.insertBefore(el, layerHost.children[i] ?? null);
        const m = layerMatrix(l);
        if (m) el.style.transform = cssMatrix(mul(S, m));
        el.style.opacity = String(l.opacity);
        el.hidden = l.hidden;
      });
      paintOverlay();
    }

    function handlePoints(F: Quad) {
      const q = screenQuad(F);
      const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const pts: Record<Handle, Pt> = { nw: q[0], ne: q[1], se: q[2], sw: q[3], n: mid(q[0], q[1]), e: mid(q[1], q[2]), s: mid(q[2], q[3]), w: mid(q[3], q[0]) };
      // Side handles only when there is room for them between the corners.
      const sides = Math.min(dist(q[0], q[1]), dist(q[3], q[0])) > 36;
      // The turn knob sticks out of the top edge, away from the middle.
      const c = centre(q);
      const top = pts.n;
      const len = dist(top, c) || 1;
      const knob = { x: top.x + ((top.x - c.x) / len) * 26, y: top.y + ((top.y - c.y) / len) * 26 };
      return { q, pts, sides, knob };
    }

    function paintOverlay() {
      overlay.replaceChildren();
      const s = cur;
      if (!s) return;
      const ls = selected();
      if (ls.length > 1) for (const l of ls) overlay.append(svgEl('polygon', { class: 'pt-outline', points: pointsAttr(screenQuad(l.quad)) }));
      if (guides.x !== undefined) {
        const a = toScreen({ x: guides.x, y: 0 });
        const b = toScreen({ x: guides.x, y: s.h });
        overlay.append(svgEl('line', { class: 'pt-guide', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      }
      if (guides.y !== undefined) {
        const a = toScreen({ x: 0, y: guides.y });
        const b = toScreen({ x: s.w, y: guides.y });
        overlay.append(svgEl('line', { class: 'pt-guide', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      }
      const F = frame();
      if (F) {
        const { q, pts, sides, knob } = handlePoints(F);
        overlay.append(svgEl('polygon', { class: 'pt-frame', points: pointsAttr(q) }));
        overlay.append(svgEl('line', { class: 'pt-frame', x1: pts.n.x, y1: pts.n.y, x2: knob.x, y2: knob.y }));
        overlay.append(svgEl('circle', { class: 'pt-handle pt-knob', cx: knob.x, cy: knob.y, r: 5 }));
        for (const [k, p] of Object.entries(pts) as [Handle, Pt][]) {
          if (k.length === 1 && !sides) continue;
          overlay.append(svgEl('rect', { class: 'pt-handle', x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9, rx: 1.5 }));
        }
      }
      if (marquee) {
        const a = toScreen(marquee.a);
        const b = toScreen(marquee.b);
        overlay.append(svgEl('rect', { class: 'pt-marquee', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }));
      }
    }

    /* ---------- pointer ---------- */
    type Hit = { kind: 'handle'; handle: Handle } | { kind: 'rotate' } | { kind: 'frame' } | { kind: 'layer'; layer: Layer } | { kind: 'empty' };
    function topLayerAt(sp: Pt) {
      if (!cur) return null;
      for (let i = cur.layers.length - 1; i >= 0; i--) {
        const l = cur.layers[i];
        if (!l.hidden && contains(screenQuad(l.quad), sp)) return l;
      }
      return null;
    }
    function hitTest(sp: Pt): Hit {
      const F = frame();
      let inside = false;
      if (F) {
        const { q, pts, sides, knob } = handlePoints(F);
        for (const [k, p] of Object.entries(pts) as [Handle, Pt][]) {
          if (k.length === 1 && !sides) continue;
          if (dist(p, sp) <= 9) return { kind: 'handle', handle: k };
        }
        if (dist(knob, sp) <= 10) return { kind: 'rotate' };
        inside = contains(q, sp);
        if (!inside && Math.min(...q.map((p) => dist(p, sp))) <= 28) return { kind: 'rotate' };
      }
      const top = topLayerAt(sp);
      if (top && !sel.has(top.id)) return { kind: 'layer', layer: top };
      if (inside) return { kind: 'frame' };
      if (top) return { kind: 'layer', layer: top };
      return { kind: 'empty' };
    }
    function cursorFor(hit: Hit) {
      if (hit.kind === 'rotate') return ROTATE_CURSOR;
      if (hit.kind === 'frame' || hit.kind === 'layer') return 'move';
      if (hit.kind !== 'handle') return 'default';
      if (mode === 'distort' || (mode === 'perspective' && hit.handle.length === 2)) return 'crosshair';
      // Point the arrows the way the handle actually faces on screen.
      const F = frame()!;
      const { pts } = handlePoints(F);
      const c = centre(screenQuad(F));
      const p = pts[hit.handle];
      const a = (((deg(Math.atan2(p.y - c.y, p.x - c.x)) % 180) + 180) % 180);
      return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
    }

    type Drag =
      | { kind: 'pan'; start: Pt; ox: number; oy: number }
      | { kind: 'marquee'; base: Set<number> }
      | { kind: 'move' | 'rotate' | Handle; p0: Pt; F0: Quad; starts: Map<number, Quad>; before: Snap; changed: boolean };
    let drag: Drag | null = null;

    stage.addEventListener('pointerdown', (e) => {
      const s = cur;
      if (!s) return;
      stage.focus({ preventScroll: true });
      const sp = stagePoint(e);
      if (e.button === 1 || (e.button === 0 && spaceDown)) {
        e.preventDefault();
        const v = view();
        drag = { kind: 'pan', start: sp, ox: v.ox, oy: v.oy };
        stage.setPointerCapture(e.pointerId);
        stage.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      const hit = hitTest(sp);
      const p0 = toCanvas(sp);
      const begin = (kind: 'move' | 'rotate' | Handle) => {
        const F0 = frame();
        if (!F0) return;
        drag = { kind, p0, F0: F0.map((p) => ({ ...p })) as Quad, starts: startsOf(), before: snapOf(s), changed: false };
        stage.setPointerCapture(e.pointerId);
      };
      if (e.shiftKey && (hit.kind === 'layer' || hit.kind === 'frame')) {
        const l = hit.kind === 'layer' ? hit.layer : topLayerAt(sp);
        if (l) return pickLayer(l, true);
      }
      if (hit.kind === 'handle') return begin(hit.handle);
      if (hit.kind === 'rotate') return begin('rotate');
      if (hit.kind === 'frame') return begin('move');
      if (hit.kind === 'layer') {
        setSel([hit.layer.id]);
        return begin('move');
      }
      // Empty space: drag a box to select.
      const base = e.shiftKey ? new Set(sel) : new Set<number>();
      if (!e.shiftKey) setSel([]);
      marquee = { a: p0, b: p0 };
      drag = { kind: 'marquee', base };
      stage.setPointerCapture(e.pointerId);
    });

    stage.addEventListener('pointermove', (e) => {
      const sp = stagePoint(e);
      if (!drag) {
        if (cur) stage.style.cursor = spaceDown ? 'grab' : cursorFor(hitTest(sp));
        return;
      }
      if (drag.kind === 'pan') {
        if (!cur) return;
        const v = view();
        cur.view = { z: v.z, ox: drag.ox + sp.x - drag.start.x, oy: drag.oy + sp.y - drag.start.y };
        return paint();
      }
      const p = toCanvas(sp);
      if (drag.kind === 'marquee') {
        if (!marquee || !cur) return;
        marquee.b = p;
        const r = bounds([marquee.a, marquee.b]);
        const hits = cur.layers.filter((l) => {
          if (l.hidden) return false;
          const b = bounds(l.quad);
          return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
        });
        sel = new Set([...drag.base, ...hits.map((l) => l.id)]);
        groupFrame = null;
        paintOverlay();
        return;
      }
      const m = dragMatrix(drag, p, e);
      if (m && applyToSel(m, drag.F0, drag.starts)) {
        drag.changed = true;
        paint();
        paintProps();
      }
    });

    const endDrag = () => {
      const d = drag;
      drag = null;
      guides = {};
      if (!d) return;
      if (d.kind === 'pan') {
        stage.style.cursor = spaceDown ? 'grab' : '';
        return;
      }
      if (d.kind === 'marquee') {
        marquee = null;
        return setSel(sel);
      }
      if (d.changed) commit(d.before);
      else paint();
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('lostpointercapture', () => drag && endDrag());

    /** The map a drag makes, from where it started to the pointer at `p`. */
    function dragMatrix(d: Extract<Drag, { p0: Pt }>, p: Pt, e: PointerEvent): Mat | null {
      const F0 = d.F0;
      const s = cur!;
      const z = view().z;
      let dx = p.x - d.p0.x;
      let dy = p.y - d.p0.y;
      guides = {};
      if (d.kind === 'move') {
        // Snap the edges and middle to the canvas's edges and middle, unless Alt is held.
        if (!e.altKey) {
          const b = bounds(F0);
          const tol = 6 / z;
          const snapAxis = (start: number, size: number, total: number, delta: number) => {
            let best: { d: number; at: number } | null = null;
            for (const [edge, target] of [
              [start, 0],
              [start + size / 2, total / 2],
              [start + size, total],
            ]) {
              const diff = target - (edge + delta);
              if (Math.abs(diff) < tol && (!best || Math.abs(diff) < Math.abs(best.d))) best = { d: diff, at: target };
            }
            return best;
          };
          const sx = snapAxis(b.x, b.w, s.w, dx);
          const sy = snapAxis(b.y, b.h, s.h, dy);
          if (sx) {
            dx += sx.d;
            guides.x = sx.at;
          }
          if (sy) {
            dy += sy.d;
            guides.y = sy.at;
          }
        }
        if (e.shiftKey) {
          // Straight across or straight down.
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        return translate(dx, dy);
      }
      if (d.kind === 'rotate') {
        const c = centre(F0);
        let a = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(d.p0.y - c.y, d.p0.x - c.x);
        if (e.shiftKey) {
          const a0 = angleOf(F0);
          const step = rad(15);
          a = Math.round((a0 + a) / step) * step - a0;
        }
        return rotateAbout(c, a);
      }
      const handle = d.kind;
      const corner = handle.length === 2;
      const ctrl = e.ctrlKey || e.metaKey;
      let m: Mode = mode;
      if (mode === 'free' && ctrl) m = corner ? 'distort' : 'skew';
      if (mode === 'perspective' && !corner) m = 'skew';

      if (m === 'distort') {
        const F1 = F0.map((q) => ({ ...q })) as Quad;
        const idx = corner ? [CORNER_INDEX[handle]!] : SIDE_INDEX[handle]!;
        for (const i of idx) F1[i] = { x: F0[i].x + dx, y: F0[i].y + dy };
        return isUsable(F1) ? quadToQuad(F0, F1) : null;
      }
      if (m === 'perspective') {
        const i = CORNER_INDEX[handle]!;
        const F1 = F0.map((q) => ({ ...q })) as Quad;
        // Along the top or bottom edge, or along the left or right edge, whichever the pointer favours.
        const horiz: Record<number, number> = { 0: 1, 1: 0, 2: 3, 3: 2 };
        const vert: Record<number, number> = { 0: 3, 3: 0, 1: 2, 2: 1 };
        const unit = (a: Pt, b: Pt) => {
          const l = dist(a, b) || 1;
          return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
        };
        const hu = unit(F0[i === 0 || i === 1 ? 0 : 3], F0[i === 0 || i === 1 ? 1 : 2]);
        const vu = unit(F0[i === 0 || i === 3 ? 0 : 1], F0[i === 0 || i === 3 ? 3 : 2]);
        const along = dx * hu.x + dy * hu.y;
        const down = dx * vu.x + dy * vu.y;
        const [u, t, j] = Math.abs(along) >= Math.abs(down) ? [hu, along, horiz[i]] : [vu, down, vert[i]];
        F1[i] = { x: F0[i].x + u.x * t, y: F0[i].y + u.y * t };
        F1[j] = { x: F0[j].x - u.x * t, y: F0[j].y - u.y * t };
        return isUsable(F1) ? quadToQuad(F0, F1) : null;
      }

      // The rest works in the frame's own 0..1 coordinates.
      const Ainv = invert(basis(F0));
      if (!Ainv) return null;
      const lp = apply(Ainv, p);
      const l0 = apply(Ainv, d.p0);
      const lw = dist(F0[0], F0[1]);
      const lh = dist(F0[0], F0[3]);

      if (m === 'skew' && !corner) {
        const ds = lp.x - l0.x;
        const dt = lp.y - l0.y;
        const k = handle === 'n' || handle === 's' ? ds : dt;
        const shear: Mat =
          handle === 'n' ? [1, -k, k, 0, 1, 0, 0, 0, 1] : handle === 's' ? [1, k, 0, 0, 1, 0, 0, 0, 1] : handle === 'e' ? [1, 0, 0, k, 1, 0, 0, 0, 1] : [1, 0, 0, -k, 1, k, 0, 0, 1];
        return local(F0, shear);
      }

      // Scale: drag a corner (in proportion unless Shift) or a side (one way).
      const hc = HANDLE_AT[handle];
      const anchor = e.altKey ? { x: 0.5, y: 0.5 } : { x: 1 - hc.x, y: 1 - hc.y };
      const minPx = 4;
      const factor = (axis: 'x' | 'y') => {
        const span = hc[axis] - anchor[axis];
        if (!span) return 1;
        return (lp[axis] - anchor[axis]) / span;
      };
      let kx = hc.x === 0.5 ? 1 : factor('x');
      let ky = hc.y === 0.5 ? 1 : factor('y');
      if (corner && !e.shiftKey) {
        // In proportion: weigh each way by how long that side is on screen.
        const wx = ((hc.x - anchor.x) * lw) ** 2;
        const wy = ((hc.y - anchor.y) * lh) ** 2;
        const k = (kx * wx + ky * wy) / (wx + wy || 1);
        kx = ky = k;
      }
      const spanX = Math.abs((hc.x - anchor.x) * lw) || lw;
      const spanY = Math.abs((hc.y - anchor.y) * lh) || lh;
      kx = Math.max(minPx / spanX, kx);
      ky = Math.max(minPx / spanY, ky);
      if (corner && !e.shiftKey) kx = ky = Math.max(kx, ky);
      const S: Mat = [kx, 0, anchor.x - kx * anchor.x, 0, ky, anchor.y - ky * anchor.y, 0, 0, 1];
      return local(F0, S);
    }

    stage.addEventListener(
      'wheel',
      (e) => {
        if (!cur) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) return zoomBy(Math.exp(-e.deltaY * 0.0015), stagePoint(e));
        const v = view();
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        cur.view = { z: v.z, ox: v.ox - dx, oy: v.oy - dy };
        paint();
      },
      { passive: false },
    );

    // Pictures dropped on the canvas join it; dropped on the list, they get canvases of their own.
    const dropTarget = (el: HTMLElement, target: 'sheets' | 'layers') => {
      el.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        el.classList.add('over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('over'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('over');
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        void addFiles(files, target);
      });
    };
    dropTarget(stage, 'layers');
    dropTarget(sheetsPane, 'sheets');

    /* ---------- keyboard ---------- */
    let nudge: { before: Snap; timer: number } | null = null;
    function nudgeBy(dx: number, dy: number) {
      const F = frame();
      if (!cur || !F) return;
      if (!nudge) nudge = { before: snapOf(cur), timer: 0 };
      clearTimeout(nudge.timer);
      if (applyToSel(translate(dx, dy), F, startsOf())) {
        paint();
        paintProps();
      }
      // A run of key presses is one undo step.
      nudge.timer = window.setTimeout(() => {
        if (nudge) commit(nudge.before);
        nudge = null;
      }, 500);
    }
    const onKey = (e: KeyboardEvent) => {
      if (workspace.hidden || !root.isConnected || !cur) return;
      if (document.querySelector('dialog[open]')) return;
      const t = e.target as HTMLElement;
      if (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === ' ' && !mod) {
        if (!spaceDown) {
          spaceDown = true;
          stage.style.cursor = 'grab';
        }
        e.preventDefault();
        return;
      }
      if (mod && k === 'z') e.shiftKey ? redo() : undo();
      else if (mod && k === 'y') redo();
      else if (mod && k === 'a') setSel(cur.layers.filter((l) => !l.hidden).map((l) => l.id));
      else if (mod && k === 'j') duplicateLayers();
      else if (mod && e.key === ']') reorder(1);
      else if (mod && e.key === '[') reorder(-1);
      else if (mod && e.key === '0') fitView();
      else if (mod && (e.key === '=' || e.key === '+')) zoomBy(1.25);
      else if (mod && e.key === '-') zoomBy(1 / 1.25);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) deleteLayers();
      else if (e.key === 'Escape' && sel.size) setSel([]);
      else if (e.key.startsWith('Arrow') && sel.size && !mod) {
        const step = e.shiftKey ? 10 : 1;
        nudgeBy(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      } else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && spaceDown) {
        spaceDown = false;
        if (!drag) stage.style.cursor = '';
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => (spaceDown = false));

    new ResizeObserver(() => {
      if (!cur || workspace.hidden) return;
      if (!cur.view) fitView();
      else paint();
    }).observe(stage);
    root.addEventListener('tool-show', () => cur && paintAll());

    /* ---------- combining ---------- */
    const tickedSheets = () => sheets.filter((s) => checked.has(s.id));

    async function combine() {
      const items = tickedSheets();
      if (items.length < 2) return toast('Tick two or more pictures in the list to combine them.');
      const arrange = select<'row' | 'column' | 'grid' | 'stack'>(
        [
          ['row', 'Side by side'],
          ['column', 'One above the other'],
          ['grid', 'In a grid'],
          ['stack', 'On top of each other'],
        ],
        'row',
        () => paintOpts(),
      );
      const gap = numberInput(0, { min: 0, max: 2000 });
      const match = checkbox('Make them the same height', true);
      const removeOriginals = checkbox('Remove the originals from the list', false);
      const matchHint = h('small', { class: 'muted' });
      function paintOpts() {
        const a = arrange.value;
        match.el.hidden = a === 'stack';
        match.el.querySelector('span')!.textContent = a === 'row' ? 'Make them the same height' : a === 'column' ? 'Make them the same width' : 'Make them the same size';
        matchHint.textContent = a === 'stack' ? 'Each picture is centred on one canvas, the last one ticked in front. Move them around afterwards.' : 'Everything stays editable on the new canvas: each picture can still be moved, resized and turned.';
      }
      paintOpts();
      const body = h(
        'div',
        { class: 'stack' },
        h('p', null, `${items.length} pictures go onto a new canvas, in the order they are listed. The originals stay as they are.`),
        h('div', { class: 'grid' }, field('Arrange', arrange), field('Gap (pixels)', gap)),
        match.el,
        removeOriginals.el,
        matchHint,
      );
      const res = await modal('Combine pictures', body, [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Combine', kind: 'primary', value: 'ok' },
      ]);
      if (res !== 'ok') return;
      const a = arrange.value;
      const g = Math.max(0, +gap.value || 0);
      const same = match.input.checked && a !== 'stack';
      const maxW = Math.max(...items.map((s) => s.w));
      const maxH = Math.max(...items.map((s) => s.h));
      // How much each one is scaled.
      const k = items.map((s) => (!same ? 1 : a === 'row' ? maxH / s.h : a === 'column' ? maxW / s.w : Math.min(maxW / s.w, maxH / s.h)));
      const sw = items.map((s, i) => s.w * k[i]);
      const sh = items.map((s, i) => s.h * k[i]);
      const origins: Pt[] = [];
      let W = 0;
      let H = 0;
      if (a === 'row') {
        H = Math.max(...sh);
        let x = 0;
        items.forEach((_, i) => {
          origins.push({ x, y: (H - sh[i]) / 2 });
          x += sw[i] + g;
        });
        W = x - g;
      } else if (a === 'column') {
        W = Math.max(...sw);
        let y = 0;
        items.forEach((_, i) => {
          origins.push({ x: (W - sw[i]) / 2, y });
          y += sh[i] + g;
        });
        H = y - g;
      } else if (a === 'grid') {
        const cols = Math.ceil(Math.sqrt(items.length));
        const rows = Math.ceil(items.length / cols);
        const cw = Math.max(...sw);
        const chh = Math.max(...sh);
        items.forEach((_, i) => {
          const c = i % cols;
          const r = Math.floor(i / cols);
          origins.push({ x: c * (cw + g) + (cw - sw[i]) / 2, y: r * (chh + g) + (chh - sh[i]) / 2 });
        });
        W = cols * cw + (cols - 1) * g;
        H = rows * chh + (rows - 1) * g;
      } else {
        W = Math.max(...sw);
        H = Math.max(...sh);
        items.forEach((_, i) => origins.push({ x: (W - sw[i]) / 2, y: (H - sh[i]) / 2 }));
      }
      const scaleDown = Math.min(1, MAX_SIDE / W, MAX_SIDE / H);
      const layers: Layer[] = [];
      items.forEach((s, i) => {
        const m = mul(scaling(scaleDown, scaleDown), mul(translate(origins[i].x, origins[i].y), scaling(k[i], k[i])));
        for (const l of s.layers) layers.push({ ...copyLayer(l, false), quad: mapQuad(m, l.quad) });
      });
      const combined: Sheet = {
        id: nextId++,
        name: `Combined ${sheets.filter((s) => s.name.startsWith('Combined')).length + 1}`,
        w: Math.max(1, Math.round(W * scaleDown)),
        h: Math.max(1, Math.round(H * scaleDown)),
        bg: items.find((s) => s.bg !== 'none')?.bg ?? 'none',
        layers,
        undo: [],
        redo: [],
        dirty: true,
        view: null,
      };
      if (removeOriginals.input.checked) {
        for (const s of items) sheets.splice(sheets.indexOf(s), 1);
        checked.clear();
      }
      const at = removeOriginals.input.checked ? sheets.length : sheets.indexOf(items[items.length - 1]) + 1;
      sheets.splice(at, 0, combined);
      if (!removeOriginals.input.checked) checked.clear();
      open(combined);
      toast(`Combined ${items.length} pictures. Each one can still be moved and transformed.`, 'success');
    }

    /* ---------- saving ---------- */
    type Format = 'png' | 'jpeg' | 'webp';
    let lastSave: { format: Format; scale: string; quality: string } = { format: 'png', scale: '1', quality: '92' };

    async function renderFile(s: Sheet, format: Format, scale: number, quality: number): Promise<OutputFile> {
      const w = s.w * scale;
      const hh = s.h * scale;
      if (w > MAX_SIDE || hh > MAX_SIDE || w * hh > MAX_AREA) throw new Error(`“${s.name}” would be ${Math.round(w)} × ${Math.round(hh)} pixels, too big to save. Choose a smaller size.`);
      // JPG has no see-through, so it goes on white.
      const c = renderSheet(s, scale, format === 'jpeg' ? '#ffffff' : undefined);
      const blob = await canvasToBlob(c, `image/${format}`, quality / 100);
      c.width = c.height = 0;
      const ext = format === 'jpeg' ? 'jpg' : format;
      const safe = s.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'picture';
      return { name: `${safe}.${ext}`, data: blob, type: `image/${format}` };
    }

    function whichChoice() {
      const n = checked.size;
      const opts: [string, string][] = [['current', `This picture (${cur?.name ?? ''})`]];
      if (n > 0 && !(n === 1 && cur && checked.has(cur.id))) opts.push(['ticked', `Ticked pictures (${n})`]);
      if (sheets.length > 1) opts.push(['all', `All pictures (${sheets.length})`]);
      return select<string>(opts, n > 1 ? 'ticked' : 'current');
    }
    const chosen = (v: string) => (v === 'all' ? [...sheets] : v === 'ticked' ? tickedSheets() : cur ? [cur] : []);

    async function savePictures() {
      if (!cur) return;
      const which = whichChoice();
      const format = select<Format>(
        [
          ['png', 'PNG (sharpest, keeps see-through)'],
          ['jpeg', 'JPG (smaller, for photos)'],
          ['webp', 'WebP (smallest)'],
        ],
        lastSave.format,
        () => paintQ(),
      );
      const scale = select<string>(
        [
          ['0.25', '25%'],
          ['0.5', '50%'],
          ['1', '100% (actual size)'],
          ['2', '200%'],
        ],
        lastSave.scale,
      );
      const quality = select<string>(
        [
          ['95', 'Best'],
          ['92', 'High'],
          ['80', 'Medium'],
          ['65', 'Small file'],
        ],
        lastSave.quality,
      );
      const qField = field('Quality', quality);
      const paintQ = () => (qField.hidden = format.value === 'png');
      paintQ();
      const body = h(
        'div',
        { class: 'stack' },
        h('div', { class: 'grid' }, which.options.length > 1 ? field('Save', which) : null, field('Format', format), field('Size', scale), qField),
        h('p', { class: 'muted small' }, canWriteDisk ? 'You choose where it goes. Several pictures go into a folder you pick.' : 'It downloads. Several pictures download together as a .zip.'),
      );
      const res = await modal('Save pictures', body, [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Save', kind: 'primary', value: 'ok' },
      ]);
      if (res !== 'ok') return;
      lastSave = { format: format.value as Format, scale: scale.value, quality: quality.value };
      const list = chosen(which.value);
      const files = await withBusy('Drawing pictures…', async (p) => {
        const out: OutputFile[] = [];
        for (const [i, s] of list.entries()) {
          p(`Drawing ${i + 1} of ${list.length}…`);
          out.push(await renderFile(s, lastSave.format, +lastSave.scale, +lastSave.quality));
        }
        return out;
      });
      if (!files?.length) return;
      const bytes = async (f: OutputFile) => new Uint8Array(await (f.data as Blob).arrayBuffer());
      if (canWriteDisk) {
        const r = files.length === 1 ? await exportFile(files[0].name, await bytes(files[0])) : await exportFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await bytes(f) }))));
        if (!r.ok) {
          if (!r.canceled) toast(r.error ?? 'Could not save.', 'error');
          return;
        }
        toast(files.length === 1 ? `Saved ${fileNameOf(r.path)}.` : `Saved ${files.length} pictures to ${fileNameOf(r.path)}.`, 'success');
      } else if (files.length === 1) {
        download(files[0]);
      } else {
        const zip = await withBusy('Zipping…', () => zipOutputs(files, 'pictures'));
        if (!zip) return;
        download(zip);
      }
      for (const s of list) s.dirty = false;
      paintSheets();
    }

    async function makePdf() {
      const list = checked.size ? tickedSheets() : [...sheets];
      if (!list.length) return;
      const files = await withBusy('Drawing pictures…', async (p) => {
        const out: File[] = [];
        for (const [i, s] of list.entries()) {
          p(`Drawing ${i + 1} of ${list.length}…`);
          // Photos on a solid background go in as JPG to keep the PDF small; see-through ones as PNG.
          const f = await renderFile(s, s.bg === 'none' ? 'png' : 'jpeg', 1, 92);
          out.push(new File([f.data as Blob], f.name, { type: f.type }));
        }
        return out;
      });
      if (!files?.length) return;
      toast(`${files.length} picture${files.length === 1 ? '' : 's'} sent to Images → PDF. Your canvases stay here.`, 'success');
      ctx.openTool('images-to-pdf', undefined, files);
    }

    paintAll();
  },
};
