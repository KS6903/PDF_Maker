/**
 * Free transform for pictures. A picture on a canvas is a quad: where its four
 * corners land. Moving, scaling, turning, slanting, distorting and perspective
 * all just move those corners. The picture is mapped onto its quad with a
 * homography (a 3×3 projective matrix), which is affine whenever the quad is a
 * parallelogram. The same matrix draws the on-screen preview (CSS matrix3d)
 * and the saved picture, so what you see is what you get.
 */

export interface Pt {
  x: number;
  y: number;
}
/** Corners in order: top left, top right, bottom right, bottom left (of the upright picture). */
export type Quad = [Pt, Pt, Pt, Pt];
/** 3×3, row major, mapping (x, y, 1). */
export type Mat = number[];

export const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat, b: Mat): Mat {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function invert(m: Mat): Mat | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function apply(m: Mat, p: Pt): Pt {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

export const mapQuad = (m: Mat, q: Quad): Quad => q.map((p) => apply(m, p)) as Quad;

export const translate = (dx: number, dy: number): Mat => [1, 0, dx, 0, 1, dy, 0, 0, 1];
export const scaling = (sx: number, sy: number): Mat => [sx, 0, 0, 0, sy, 0, 0, 0, 1];

export function rotateAbout(c: Pt, rad: number): Mat {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return mul(translate(c.x, c.y), mul([cos, -sin, 0, sin, cos, 0, 0, 0, 1], translate(-c.x, -c.y)));
}

/** The unit square (0,0) (1,0) (1,1) (0,1) onto `q`. Heckbert's construction. */
export function squareToQuad(q: Quad): Mat | null {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

/** A w×h picture (in its own pixels) onto `q`. */
export function rectToQuad(w: number, h: number, q: Quad): Mat | null {
  const s = squareToQuad(q);
  return s && mul(s, scaling(1 / w, 1 / h));
}

/** The projective map that takes quad `a` to quad `b`, corner for corner. */
export function quadToQuad(a: Quad, b: Quad): Mat | null {
  const sa = squareToQuad(a);
  const sb = squareToQuad(b);
  const ia = sa && invert(sa);
  return sb && ia ? mul(sb, ia) : null;
}

/** The affine frame of a quad: its top-left corner and the directions of its top and left edges. */
export function basis(q: Quad): Mat {
  const [o, r, , d] = q;
  return [r.x - o.x, d.x - o.x, o.x, r.y - o.y, d.y - o.y, o.y, 0, 0, 1];
}

/** `local` (a map in the quad's own 0..1 coordinates) carried out on the canvas. */
export function inFrame(q: Quad, local: Mat): Mat | null {
  const A = basis(q);
  const inv = invert(A);
  return inv && mul(A, mul(local, inv));
}

export function rectQuad(x: number, y: number, w: number, h: number): Quad {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function bounds(points: Pt[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const centre = (q: Quad): Pt => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Signed area; positive when the corners run clockwise on screen. */
export function area(q: Quad) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * A quad a picture can be mapped onto: convex, not folded over and not
 * squashed flat. Mirrored quads (a flip) are fine.
 */
export function isUsable(q: Quad, minArea = 1) {
  if (q.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  if (Math.abs(area(q)) < minArea) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export function contains(q: Quad, p: Pt) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const s = Math.sign(cross(q[i], q[(i + 1) % 4], p));
    if (!s) continue;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Whether the map has no perspective in it, so a plain 2D transform draws it. */
export function isAffine(m: Mat, w: number, h: number) {
  return (Math.abs(m[6]) * w + Math.abs(m[7]) * h) / Math.abs(m[8]) < 1e-7;
}

/** CSS for the map, for an element whose top-left corner is the origin. */
export function cssMatrix(m: Mat) {
  const n = m.map((v) => +v.toPrecision(12));
  return `matrix3d(${n[0]},${n[3]},0,${n[6]},${n[1]},${n[4]},0,${n[7]},0,0,1,0,${n[2]},${n[5]},0,${n[8]})`;
}

/* ---------- drawing a picture onto a canvas ---------- */

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * Draw `img` (`w`×`h` pixels) onto `g` through `m`. Affine maps go through
 * the canvas itself; perspective is resampled pixel by pixel, from a copy
 * shrunk first when the picture ends up much smaller, so it stays smooth.
 */
export function drawMapped(g: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, m: Mat, alpha = 1) {
  g.save();
  g.globalAlpha = alpha;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (isAffine(m, w, h)) {
    const k = 1 / m[8];
    g.setTransform(m[0] * k, m[3] * k, m[1] * k, m[4] * k, m[2] * k, m[5] * k);
    g.drawImage(img, 0, 0, w, h);
    g.restore();
    return;
  }
  const W = g.canvas.width;
  const H = g.canvas.height;
  const q = mapQuad(m, rectQuad(0, 0, w, h));
  const b = bounds(q);
  const bx = Math.max(0, Math.floor(b.x));
  const by = Math.max(0, Math.floor(b.y));
  const bw = Math.min(W, Math.ceil(b.x + b.w)) - bx;
  const bh = Math.min(H, Math.ceil(b.y + b.h)) - by;
  if (bw <= 0 || bh <= 0) return void g.restore();

  // Work from a copy no bigger than about twice the size it lands at.
  const k = Math.min(1, (2 * Math.sqrt(Math.abs(area(q)))) / Math.sqrt(w * h));
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  const src = canvas(sw, sh);
  const sg = src.getContext('2d', { willReadFrequently: true })!;
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(img, 0, 0, sw, sh);
  const S = sg.getImageData(0, 0, sw, sh).data;
  src.width = src.height = 0;

  const inv = invert(mul(m, scaling(w / sw, h / sh)));
  if (!inv) return void g.restore();
  const out = new ImageData(bw, bh);
  const D = out.data;
  const [a, bb, c, d, e, f, gg, hh, ii] = inv;
  for (let y = 0; y < bh; y++) {
    const Y = by + y + 0.5;
    for (let x = 0; x < bw; x++) {
      const X = bx + x + 0.5;
      const ww = gg * X + hh * Y + ii;
      const u = (a * X + bb * Y + c) / ww - 0.5;
      const v = (d * X + e * Y + f) / ww - 0.5;
      if (u < -0.5 || v < -0.5 || u > sw - 0.5 || v > sh - 0.5) continue;
      // Bilinear, weighted by alpha so see-through edges don't go dark.
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(u)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(v)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, u - x0));
      const fy = Math.max(0, Math.min(1, v - y0));
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy) * S[i00 + 3];
      const w10 = fx * (1 - fy) * S[i10 + 3];
      const w01 = (1 - fx) * fy * S[i01 + 3];
      const w11 = fx * fy * S[i11 + 3];
      const wa = w00 + w10 + w01 + w11;
      if (wa <= 0) continue;
      const o = (y * bw + x) * 4;
      D[o] = (w00 * S[i00] + w10 * S[i10] + w01 * S[i01] + w11 * S[i11]) / wa;
      D[o + 1] = (w00 * S[i00 + 1] + w10 * S[i10 + 1] + w01 * S[i01 + 1] + w11 * S[i11 + 1]) / wa;
      D[o + 2] = (w00 * S[i00 + 2] + w10 * S[i10 + 2] + w01 * S[i01 + 2] + w11 * S[i11 + 2]) / wa;
      D[o + 3] = wa;
    }
  }
  const tile = canvas(bw, bh);
  tile.getContext('2d')!.putImageData(out, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(tile, bx, by);
  tile.width = tile.height = 0;
  g.restore();
}
