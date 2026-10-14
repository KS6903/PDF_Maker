import { GitCompare } from 'lucide';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { h, button, withBusy, toast } from '../lib/ui';
import { loadLib, loadJs, rasterizePage, pdfOutput, baseName, visualFrame, type PdfSource } from '../lib/pdf';
import { safeText } from '../lib/fonts';
import { pdfInput, resultsPanel, type Tool } from './common';

/* ---------- diffing ---------- */

type Op = { type: 'equal' | 'insert' | 'delete'; a: number; b: number };

/**
 * Myers' shortest edit script between two lists. Returns null when the lists
 * differ by more than `maxD` edits, so a wholly different file can't eat all
 * the memory.
 */
function diff(a: string[], b: string[], maxD = 3000): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      // Only a path ending exactly at the corner counts. Paths that stepped off
      // the grid can never come back to it, so backtracking stays on real moves.
      if (x === n && y === m) found = d;
    }
    trace.push(v.slice(off - d, off + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) ops.push({ type: 'equal', a: --x, b: --y });
    if (down) ops.push({ type: 'insert', a: x, b: --y });
    else ops.push({ type: 'delete', a: --x, b: y });
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) ops.push({ type: 'equal', a: --x, b: --y });
  return ops.reverse();
}

interface Line {
  text: string;
  page: number;
}

async function documentLines(js: PDFDocumentProxy): Promise<Line[]> {
  const out: Line[] = [];
  for (let n = 1; n <= js.numPages; n++) {
    const page = await js.getPage(n);
    const content = await page.getTextContent();
    let cur = '';
    let lastY: number | null = null;
    let lastEnd = 0;
    const flush = () => {
      const t = cur.replace(/\s+/g, ' ').trim();
      if (t) out.push({ text: t, page: n });
      cur = '';
    };
    for (const raw of content.items) {
      if (!('str' in raw)) continue;
      const it = raw as TextItem;
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      const x = it.transform[4];
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > size * 0.5) flush();
      else if (cur && x - lastEnd > size * 0.15) cur += ' ';
      cur += it.str;
      lastY = y;
      lastEnd = x + it.width;
      if (it.hasEOL) {
        flush();
        lastY = null;
      }
    }
    flush();
    page.cleanup();
  }
  return out;
}

interface Change {
  kind: 'added' | 'removed' | 'changed';
  pageA?: number;
  pageB?: number;
  before: string[];
  after: string[];
}

/** Line-level diff, with replaced runs of lines treated as one change. */
function textChanges(a: Line[], b: Line[]): Change[] | null {
  const ops = diff(a.map((l) => l.text), b.map((l) => l.text));
  if (!ops) return null;
  const changes: Change[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    const del: Line[] = [];
    const ins: Line[] = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'delete') del.push(a[ops[i].a]);
      else ins.push(b[ops[i].b]);
      i++;
    }
    changes.push({
      kind: del.length && ins.length ? 'changed' : del.length ? 'removed' : 'added',
      pageA: del[0]?.page,
      pageB: ins[0]?.page,
      before: del.map((l) => l.text),
      after: ins.map((l) => l.text),
    });
  }
  return changes;
}

/** The two sides of a changed passage, with the differing words marked. */
function wordDiff(before: string, after: string) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const ops = diff(a, b, 800);
  const left = h('p', { class: 'diff-before' });
  const right = h('p', { class: 'diff-after' });
  if (!ops) {
    left.append(h('del', null, before));
    right.append(h('ins', null, after));
  } else {
    for (const op of ops) {
      if (op.type === 'equal') {
        left.append(a[op.a]);
        right.append(b[op.b]);
      } else if (op.type === 'delete') {
        left.append(h('del', null, a[op.a]));
      } else {
        right.append(h('ins', null, b[op.b]));
      }
    }
  }
  return [left, right];
}

/* ---------- visual comparison ---------- */

const CELL = 6;

interface PageDiff {
  page: number;
  /** Share of the page that looks different, 0-1. */
  changed: number;
  /** Changed areas in page points (top-left origin), already merged into runs. */
  boxes: { x: number; y: number; w: number; h: number }[];
  preview: HTMLCanvasElement;
  sizeChanged: boolean;
}

async function comparePages(pa: PDFDocumentProxy, pb: PDFDocumentProxy, n: number): Promise<PageDiff> {
  const [a, b] = await Promise.all([pa.getPage(n), pb.getPage(n)]);
  const [ca, cb] = await Promise.all([rasterizePage(a, 1), rasterizePage(b, 1)]);
  const w = cb.width;
  const hgt = cb.height;
  const sizeChanged = Math.abs(ca.width - w) > 1 || Math.abs(ca.height - hgt) > 1;
  const da = ca.getContext('2d')!.getImageData(0, 0, Math.min(w, ca.width), Math.min(hgt, ca.height)).data;
  const db = cb.getContext('2d')!.getImageData(0, 0, Math.min(w, ca.width), Math.min(hgt, ca.height)).data;
  const cw = Math.min(w, ca.width);
  const ch = Math.min(hgt, ca.height);
  const cols = Math.ceil(cw / CELL);
  const rows = Math.ceil(ch / CELL);
  const cells = new Uint8Array(cols * rows);
  let changedPx = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) {
        changedPx++;
        cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
      }
    }
  }
  // Merge changed cells into horizontal runs, then stack identical runs vertically.
  const boxes: PageDiff['boxes'] = [];
  const open = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (let r = 0; r < rows; r++) {
    const runs: string[] = [];
    for (let c = 0; c < cols; c++) {
      if (!cells[r * cols + c]) continue;
      const start = c;
      while (c + 1 < cols && cells[r * cols + c + 1]) c++;
      runs.push(`${start}:${c}`);
    }
    for (const [key, box] of [...open]) {
      if (!runs.includes(key)) {
        boxes.push(box);
        open.delete(key);
      }
    }
    for (const key of runs) {
      const box = open.get(key);
      if (box) box.h += CELL;
      else {
        const [s, e] = key.split(':').map(Number);
        open.set(key, { x: s * CELL, y: r * CELL, w: (e - s + 1) * CELL, h: CELL });
      }
    }
  }
  boxes.push(...open.values());

  const preview = document.createElement('canvas');
  preview.width = w;
  preview.height = hgt;
  const p = preview.getContext('2d')!;
  p.globalAlpha = 0.35;
  p.drawImage(cb, 0, 0);
  p.globalAlpha = 1;
  p.fillStyle = 'rgba(229, 72, 77, 0.45)';
  for (const bx of boxes) p.fillRect(bx.x, bx.y, bx.w, bx.h);
  for (const c of [ca, cb]) c.width = c.height = 0;
  a.cleanup();
  b.cleanup();
  return { page: n, changed: changedPx / Math.max(1, cw * ch), boxes, preview, sizeChanged };
}

/* ---------- report ---------- */

async function buildReport(srcB: PdfSource, nameA: string, changes: Change[], visual: PageDiff[], pagesA: number, pagesB: number) {
  const docB = await loadLib(srcB);
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  // Summary pages first.
  const [W, H] = [595.28, 841.89];
  const margin = 50;
  let page = out.addPage([W, H]);
  let y = H - margin;
  const write = (text: string, opts: { size?: number; f?: typeof font; color?: ReturnType<typeof rgb>; indent?: number } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.f ?? font;
    const maxW = W - margin * 2 - (opts.indent ?? 0);
    const words = safeText(f, text).split(' ');
    let line = '';
    const lines: string[] = [];
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) > maxW && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      if (y < margin + size) {
        page = out.addPage([W, H]);
        y = H - margin;
      }
      y -= size * 1.35;
      page.drawText(l, { x: margin + (opts.indent ?? 0), y, size, font: f, color: opts.color ?? rgb(0.12, 0.12, 0.12) });
    }
  };
  write('Comparison report', { size: 20, f: bold });
  y -= 8;
  write(`Original: ${nameA} (${pagesA} pages)`);
  write(`Changed: ${srcB.name} (${pagesB} pages)`);
  write(`Compared on ${new Date().toLocaleString()}`);
  y -= 8;
  const looks = visual.filter((v) => v.boxes.length || v.sizeChanged);
  write(`${changes.length} text change${changes.length === 1 ? '' : 's'}; ${looks.length} ${looks.length === 1 ? 'page looks' : 'pages look'} different.`, { f: bold });
  if (pagesA !== pagesB) write(`Page count changed from ${pagesA} to ${pagesB}.`);
  y -= 6;
  for (const c of changes) {
    y -= 6;
    const where = c.kind === 'removed' ? `page ${c.pageA} of the original` : `page ${c.pageB}`;
    write(`${c.kind === 'added' ? 'Added' : c.kind === 'removed' ? 'Removed' : 'Changed'} on ${where}`, { f: bold, size: 9 });
    for (const t of c.before) write(`- ${t}`, { size: 9, color: rgb(0.7, 0.14, 0.1), indent: 10 });
    for (const t of c.after) write(`+ ${t}`, { size: 9, color: rgb(0.1, 0.5, 0.22), indent: 10 });
  }

  // Then the changed document, with what changed highlighted.
  const copies = await out.copyPages(docB, docB.getPageIndices());
  for (const [i, p] of copies.entries()) {
    out.addPage(p);
    const diffs = visual.find((v) => v.page === i + 1);
    if (!diffs) continue;
    const frame = visualFrame(p);
    for (const bx of diffs.boxes) {
      const c1 = frame.toPdf(bx.x, bx.y);
      const c2 = frame.toPdf(bx.x + bx.w, bx.y + bx.h);
      p.drawRectangle({
        x: Math.min(c1.x, c2.x),
        y: Math.min(c1.y, c2.y),
        width: Math.abs(c2.x - c1.x),
        height: Math.abs(c2.y - c1.y),
        color: rgb(0.9, 0.28, 0.3),
        opacity: 0.28,
      });
    }
  }
  return out.save();
}

export const compareTool: Tool = {
  id: 'compare',
  title: 'Compare files',
  blurb: 'See what changed between two versions of a PDF, in the text and on the page.',
  icon: GitCompare,
  group: 'Organize',
  acceptsPdf: true,
  mount(el, ctx) {
    let srcA: PdfSource | null = null;
    let srcB: PdfSource | null = null;
    const results = resultsPanel(ctx);
    const output = h('div', { class: 'stack' });
    const go = button('Compare', () => void run(), { icon: GitCompare, kind: 'primary', disabled: true });
    const ready = () => (go.disabled = !(srcA && srcB));
    const inputA = pdfInput(ctx, (s) => ((srcA = s), ready()));
    const inputB = pdfInput(ctx, (s) => ((srcB = s), ready()));

    async function run() {
      if (!srcA || !srcB) return;
      const a = srcA;
      const b = srcB;
      results.hide();
      const res = await withBusy('Comparing…', async (progress) => {
        const [ja, jb] = await Promise.all([loadJs(a), loadJs(b)]);
        try {
          progress('Comparing text…');
          const [la, lb] = await Promise.all([documentLines(ja), documentLines(jb)]);
          const changes = textChanges(la, lb);
          const visual: PageDiff[] = [];
          const shared = Math.min(ja.numPages, jb.numPages, 300);
          for (let n = 1; n <= shared; n++) {
            progress(`Comparing page ${n} of ${shared}…`);
            visual.push(await comparePages(ja, jb, n));
          }
          progress('Writing the report…');
          const report = await buildReport(b, a.name, changes ?? [], visual, ja.numPages, jb.numPages);
          return { changes, visual, report, pagesA: ja.numPages, pagesB: jb.numPages, noText: !la.length && !lb.length };
        } finally {
          await Promise.all([ja.loadingTask.destroy(), jb.loadingTask.destroy()]);
        }
      });
      if (!res) return;

      const looks = res.visual.filter((v) => v.boxes.length || v.sizeChanged);
      const changes = res.changes ?? [];
      const summary =
        res.changes === null
          ? 'The text is too different to compare line by line. These look like different documents.'
          : res.noText
            ? 'Neither file has text (they may be scans), so only the look of the pages was compared.'
            : changes.length
              ? `${changes.length} text change${changes.length === 1 ? '' : 's'}.`
              : 'The text is identical.';
      const sections: (HTMLElement | null)[] = [
        h(
          'div',
          { class: 'panel' },
          h('h3', null, 'Summary'),
          h('p', null, summary),
          h('p', null, looks.length ? `${looks.length} ${looks.length === 1 ? 'page looks' : 'pages look'} different.` : 'Every page looks the same.'),
          res.pagesA !== res.pagesB ? h('p', null, `The page count changed from ${res.pagesA} to ${res.pagesB}.`) : null,
        ),
        changes.length
          ? h(
              'div',
              { class: 'panel' },
              h('h3', null, 'Text changes'),
              h(
                'div',
                { class: 'diff-list' },
                changes.slice(0, 400).map((c) =>
                  h(
                    'div',
                    { class: `diff-item ${c.kind}` },
                    h('div', { class: 'diff-where' }, c.kind === 'added' ? 'Added' : c.kind === 'removed' ? 'Removed' : 'Changed', h('span', { class: 'muted' }, c.kind === 'removed' ? ` · original page ${c.pageA}` : ` · page ${c.pageB}`)),
                    c.kind === 'changed'
                      ? h('div', { class: 'diff-pair' }, wordDiff(c.before.join(' '), c.after.join(' ')))
                      : h('p', { class: c.kind === 'added' ? 'diff-after' : 'diff-before' }, h(c.kind === 'added' ? 'ins' : 'del', null, (c.kind === 'added' ? c.after : c.before).join(' '))),
                  ),
                ),
                changes.length > 400 ? h('p', { class: 'muted small' }, `…and ${changes.length - 400} more in the report.`) : null,
              ),
            )
          : null,
        looks.length
          ? h(
              'div',
              { class: 'panel' },
              h('h3', null, 'Pages that look different'),
              h('p', { class: 'muted small' }, 'Changed areas of the new version are shaded red.'),
              h(
                'div',
                { class: 'diff-pages' },
                looks.map((v) =>
                  h(
                    'figure',
                    { class: 'diff-page' },
                    v.preview,
                    h('figcaption', null, `Page ${v.page}`, h('span', { class: 'muted' }, v.sizeChanged ? ' · page size changed' : ` · ${Math.max(0.1, Math.round(v.changed * 1000) / 10)}% different`)),
                  ),
                ),
              ),
            )
          : null,
      ];
      output.replaceChildren(...sections.filter((s): s is HTMLElement => !!s));
      results.show([pdfOutput(`${baseName(b.name)}-comparison`, res.report)], 'The report lists every text change, then the new version with changed areas highlighted.');
      if (!changes.length && !looks.length) toast('No differences found.', 'success');
    }

    el.append(
      h(
        'div',
        { class: 'compare-inputs' },
        h('div', { class: 'stack' }, h('h3', null, 'Original'), inputA.el),
        h('div', { class: 'stack' }, h('h3', null, 'Changed version'), inputB.el),
      ),
      h('div', { class: 'actions' }, go),
      output,
      results.el,
    );
  },
};
