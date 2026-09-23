/**
 * Finds places on a page that look like they're meant to be filled in, like
 * Acrobat's Fill & Sign: blank lines, underscores, "Label:" followed by empty
 * space, checkbox glyphs, and real form fields. Everything runs locally.
 *
 * All coordinates are visual page points (origin top-left), matching the editor.
 */

export interface Suggestion {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'text' | 'check';
  /** Where the text baseline should sit (line-type fields write just above the line). */
  baseline?: number;
  /** Nearby label, e.g. "name", used to offer remembered entries. */
  label?: string;
  /** Name of a real AcroForm field; filled via the form instead of drawn. */
  field?: string;
}

export interface TextItemLite {
  x: number;
  y: number; // baseline
  w: number;
  size: number;
  str: string;
}

const PRIORITY = { field: 0, underscore: 1, line: 2, check: 1, colon: 3 } as const;
type Ranked = Suggestion & { rank: number };

/** Form widgets from pdf.js getAnnotations(), converted to visual coords. */
export function fromWidgets(
  annots: { subtype?: string; fieldType?: string; checkBox?: boolean; readOnly?: boolean; fieldName?: string; rect: number[]; alternativeText?: string }[],
  toView: (rect: number[]) => number[],
): Ranked[] {
  const out: Ranked[] = [];
  for (const a of annots) {
    if (a.subtype !== 'Widget' || a.readOnly || !a.fieldName) continue;
    const [x1, y1, x2, y2] = toView(a.rect);
    const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    if (box.w < 4 || box.h < 4) continue;
    const label = normalizeLabel(a.alternativeText || a.fieldName.split('.').pop() || '');
    if (a.fieldType === 'Tx') out.push({ ...box, kind: 'text', field: a.fieldName, label, rank: PRIORITY.field });
    else if (a.fieldType === 'Btn' && a.checkBox) out.push({ ...box, kind: 'check', field: a.fieldName, rank: PRIORITY.field });
  }
  return out;
}

/** Underscore runs, checkbox glyphs and "Label:" + empty space, from the text layer. */
export function fromText(items: TextItemLite[], pageWidth: number): Ranked[] {
  const out: Ranked[] = [];
  for (const it of items) {
    const n = it.str.length;
    if (!n) continue;
    const charW = it.w / n;
    // "Name: __________"
    for (const m of it.str.matchAll(/_{3,}/g)) {
      const x = it.x + charW * m.index!;
      const w = charW * m[0].length;
      const label = labelBefore(items, it, x);
      out.push({ x, y: it.y - it.size * 1.15, w, h: it.size * 1.15, baseline: it.y - it.size * 0.15, kind: 'text', label, rank: PRIORITY.underscore });
    }
    // ☐ Yes  ☐ No
    for (const m of it.str.matchAll(/[☐□❑❒▢]/g)) {
      const x = it.x + charW * m.index!;
      out.push({ x, y: it.y - it.size * 0.85, w: Math.max(charW, it.size * 0.8), h: it.size * 0.9, kind: 'check', rank: PRIORITY.check });
    }
    // "Date:" with nothing after it on the same line
    const t = it.str.trim();
    if (t.endsWith(':') && t.length >= 2 && t.length <= 40) {
      const end = it.x + it.w;
      const next = items
        .filter((o) => o !== it && Math.abs(o.y - it.y) < it.size * 0.5 && o.x > end - 1 && o.str.trim())
        .reduce((min, o) => Math.min(min, o.x), pageWidth - 36);
      const gap = next - end;
      if (gap >= 50) {
        out.push({
          x: end + 6,
          y: it.y - it.size * 1.1,
          w: Math.min(gap - 12, 280),
          h: it.size * 1.45,
          kind: 'text',
          label: normalizeLabel(t),
          rank: PRIORITY.colon,
        });
      }
    }
  }
  return out;
}

/**
 * Blank horizontal rules with empty space above them, found in the rendered
 * page image, so it works however the line was drawn (paths, glyphs, images).
 */
export function fromCanvas(canvas: HTMLCanvasElement, pageWidth: number, items: TextItemLite[]): Ranked[] {
  const W = canvas.width;
  const H = canvas.height;
  const sc = W / pageWidth; // canvas pixels per point
  let data: Uint8ClampedArray;
  try {
    data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  } catch {
    return [];
  }
  const dark = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return data[i + 3] > 128 && data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < 140;
  };
  const darkFrac = (x0: number, x1: number, y0: number, y1: number, step = 2) => {
    let d = 0;
    let n = 0;
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y += step) {
      for (let x = x0; x <= x1; x += step) {
        n++;
        if (dark(x, y)) d++;
      }
    }
    return n ? d / n : 1;
  };

  const minRun = Math.round(40 * sc);
  const thick = Math.max(2, Math.round(1.6 * sc));
  const above = Math.round(15 * sc);
  const found: { x0: number; x1: number; y: number }[] = [];
  for (let y = above + thick; y < H - thick - 1; y++) {
    let x = 0;
    while (x < W) {
      if (!dark(x, y)) {
        x++;
        continue;
      }
      let x1 = x;
      while (x1 + 1 < W && (dark(x1 + 1, y) || (x1 + 2 < W && dark(x1 + 2, y)))) x1++;
      if (x1 - x >= minRun) {
        const dup = found.some((f) => Math.abs(f.y - y) <= thick + 1 && f.x0 < x1 && x < f.x1);
        // Thin line (light just above and below), with an empty band above it.
        if (
          !dup &&
          darkFrac(x, x1, y - thick - 1, y - thick - 1, 3) < 0.25 &&
          darkFrac(x, x1, y + thick + 1, y + thick + 1, 3) < 0.25 &&
          darkFrac(x + 2, x1 - 2, y - above, y - thick - 2, 3) < 0.015
        ) {
          found.push({ x0: x, x1, y });
        }
      }
      x = x1 + 1;
    }
  }
  return found.map((f) => {
    const x = f.x0 / sc;
    const lineY = f.y / sc;
    const h = 16;
    const probe: TextItemLite = { x, y: lineY, w: 0, size: 12, str: '' };
    return {
      x,
      y: lineY - h,
      w: (f.x1 - f.x0) / sc,
      h,
      baseline: lineY - 3,
      kind: 'text' as const,
      label: labelBefore(items, probe, x),
      rank: PRIORITY.line,
    };
  });
}

/** Keep the best suggestion where several overlap. */
export function mergeSuggestions(list: Ranked[]): Suggestion[] {
  const kept: Ranked[] = [];
  for (const s of [...list].sort((a, b) => a.rank - b.rank)) {
    if (!kept.some((k) => overlap(k, s) > 0.4)) kept.push(s);
  }
  return kept.map(({ rank: _rank, ...s }) => s);
}

export function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/** The words just left of a position on the same line ("Full name:" → "full name"). */
function labelBefore(items: TextItemLite[], ref: TextItemLite, x: number) {
  const left = items
    .filter((o) => Math.abs(o.y - ref.y) < Math.max(ref.size, o.size) * 0.9 && o.x < x && o.str.replace(/_/g, '').trim())
    .sort((a, b) => b.x - a.x)[0];
  if (!left) return undefined;
  const text = left.str.split(/_{3,}/)[0];
  return normalizeLabel(text) || undefined;
}

export function normalizeLabel(s: string) {
  return s
    .toLowerCase()
    .replace(/[_:*\[\]().]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-40);
}
