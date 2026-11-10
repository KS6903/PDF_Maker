/**
 * Lifts a signature off a photo or scan of paper: the paper becomes
 * transparent and only the ink is kept.
 *
 * - The paper's brightness is measured area by area, not as one colour, so a
 *   phone photo with a shadow or uneven light across it still comes out clean.
 * - Edges stay smooth (partly transparent) instead of jagged.
 * - The paper's tint is taken back out of those edge pixels, so blue ink stays
 *   blue and there is no pale fringe around the strokes on a coloured page.
 * - Specks of dust and paper texture that aren't part of the writing are dropped.
 *
 * Images that already have a transparent background are left as they are.
 */

/** Works on raw RGBA pixels. Returns new pixels, or null to keep the image unchanged. */
export function liftInkPixels(px: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray | null {
  const n = w * h;
  if (!n) return null;

  // Already cut out: leave it alone.
  let seeThrough = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) seeThrough++;
  if (seeThrough > n * 0.05) return null;

  const lum = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];

  /* 1. What the paper looks like in each area: the brightest quarter of every
        grid cell, which is paper unless the cell is almost all ink. */
  const cell = Math.max(8, Math.round(Math.max(w, h) / 24));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const raw = new Float32Array(gw * gh * 4); // luminance, r, g, b
  const hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * cell;
      const y0 = gy * cell;
      const x1 = Math.min(w, x0 + cell);
      const y1 = Math.min(h, y0 + cell);
      hist.fill(0);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[lum[y * w + x] | 0]++;
      let need = Math.max(1, Math.round((x1 - x0) * (y1 - y0) * 0.25));
      let cut = 255;
      for (; cut > 0; cut--) {
        need -= hist[cut];
        if (need <= 0) break;
      }
      let sl = 0, sr = 0, sg = 0, sb = 0, k = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (lum[i] < cut) continue;
          const j = i * 4;
          sl += lum[i];
          sr += px[j];
          sg += px[j + 1];
          sb += px[j + 2];
          k++;
        }
      }
      const o = (gy * gw + gx) * 4;
      raw[o] = sl / k;
      raw[o + 1] = sr / k;
      raw[o + 2] = sg / k;
      raw[o + 3] = sb / k;
    }
  }

  // A cell covered by a thick stroke reads too dark; take the middle of each
  // 3x3 neighbourhood so one odd cell can't turn its ink into "paper".
  const grid = new Float32Array(raw.length);
  const near: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      near.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && y >= 0 && x < gw && y < gh) near.push((y * gw + x) * 4);
        }
      }
      near.sort((a, b) => raw[a] - raw[b]);
      const src = near[near.length >> 1];
      const o = (gy * gw + gx) * 4;
      for (let c = 0; c < 4; c++) grid[o + c] = raw[src + c];
    }
  }

  // Smooth paper estimate for any pixel, blended between cell centres.
  const axis = (len: number, cells: number) => {
    const i0 = new Int32Array(len);
    const i1 = new Int32Array(len);
    const t = new Float32Array(len);
    for (let p = 0; p < len; p++) {
      const f = p / cell - 0.5;
      const a = Math.min(cells - 1, Math.max(0, Math.floor(f)));
      i0[p] = a;
      i1[p] = Math.min(cells - 1, a + 1);
      t[p] = Math.min(1, Math.max(0, f - a));
    }
    return { i0, i1, t };
  };
  const ax = axis(w, gw);
  const ay = axis(h, gh);
  const paper = (x: number, y: number, c: number) => {
    const r0 = ay.i0[y] * gw;
    const r1 = ay.i1[y] * gw;
    const tx = ax.t[x];
    const top = grid[(r0 + ax.i0[x]) * 4 + c] * (1 - tx) + grid[(r0 + ax.i1[x]) * 4 + c] * tx;
    const bot = grid[(r1 + ax.i0[x]) * 4 + c] * (1 - tx) + grid[(r1 + ax.i1[x]) * 4 + c] * tx;
    return top + (bot - top) * ay.t[y];
  };

  /* 2. How much darker than its paper each pixel is (0 = paper, 1 = black). */
  const dark = new Float32Array(n);
  const dh = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bg = Math.max(1, paper(x, y, 0));
      const d = Math.min(1, Math.max(0, 1 - lum[i] / bg));
      dark[i] = d;
      dh[Math.round(d * 255)]++;
    }
  }

  // Split paper from ink where the two groups separate best (Otsu's method).
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * dh[v];
  let sumB = 0, wB = 0, best = 0, split = 64;
  for (let v = 0; v < 256; v++) {
    wB += dh[v];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += v * dh[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      split = v;
    }
  }
  const t = Math.min(0.6, Math.max(0.15, split / 255));
  const lo = t * 0.5;
  const hi = Math.min(0.95, t * 1.2);

  /* 3. Ink coverage per pixel, with a soft ramp for smooth edges. */
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = dark[i];
    if (d <= lo) continue;
    const s = d >= hi ? 1 : (d - lo) / (hi - lo);
    alpha[i] = Math.round(s * s * (3 - 2 * s) * 255);
  }

  /* 4. Drop specks: connected bits of "ink" too small to be writing. */
  const minArea = Math.max(4, Math.round(n * 0.00002));
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  const members: number[] = [];
  let kept = 0;
  let next = 1;
  for (let s = 0; s < n; s++) {
    if (!alpha[s] || label[s]) continue;
    const id = next++;
    let top = 0;
    let solid = 0;
    members.length = 0;
    stack[top++] = s;
    label[s] = id;
    while (top) {
      const i = stack[--top];
      members.push(i);
      if (alpha[i] >= 128) solid++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (alpha[j] && !label[j]) {
            label[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
    if (solid < minArea) for (const i of members) alpha[i] = 0;
    else kept += solid;
  }
  if (!kept) return null; // nothing that looks like writing: keep the picture as it was

  /* 5. Final colours: take the paper's tint back out of partly covered pixels. */
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = alpha[i];
      if (!a) continue;
      const j = i * 4;
      const f = Math.max(a / 255, 0.4);
      for (let c = 0; c < 3; c++) out[j + c] = (px[j + c] - (1 - f) * paper(x, y, c + 1)) / f;
      out[j + 3] = a;
    }
  }
  return out;
}

/** Canvas version: returns a new canvas with the paper removed, or the same one if there was nothing to do. */
export function liftInk(src: HTMLCanvasElement): HTMLCanvasElement {
  const { width: w, height: h } = src;
  const img = src.getContext('2d')!.getImageData(0, 0, w, h);
  const lifted = liftInkPixels(img.data, w, h);
  if (!lifted) return src;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.putImageData(new ImageData(lifted, w, h), 0, 0);
  return out;
}
