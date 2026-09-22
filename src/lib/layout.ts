/**
 * A small document layout engine: turns structured blocks (from plain text, Markdown,
 * Word or HTML) into paginated PDF pages using the standard PDF fonts.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb } from '@cantoo/pdf-lib';
import { marked, type Token, type Tokens } from 'marked';
import { FontCache, safeText, type FontFamily } from './fonts';

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
  strike?: boolean;
}

export type TextStyle = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'line' | 'quote';

export type Block =
  | { kind: 'text'; style: TextStyle; runs: Run[]; indent?: number; bullet?: string; align?: 'left' | 'center' | 'right' }
  | { kind: 'code'; text: string }
  | { kind: 'hr' }
  | { kind: 'gap'; size: number }
  | { kind: 'pagebreak' }
  | { kind: 'table'; rows: Run[][][]; header: boolean }
  | { kind: 'image'; src: string; alt?: string };

export interface LayoutOptions {
  pageSize: [number, number];
  margin: number;
  family: FontFamily;
  fontSize: number;
  lineHeight: number;
  title?: string;
}

const HEADING_SCALE: Record<TextStyle, number> = { h1: 2, h2: 1.6, h3: 1.3, h4: 1.1, p: 1, line: 1, quote: 1 };
const INK = rgb(0.1, 0.1, 0.12);
const LINK = rgb(0.1, 0.35, 0.8);
const RULE = rgb(0.8, 0.8, 0.82);
const CODE_BG = rgb(0.95, 0.95, 0.96);

interface Piece {
  text: string;
  font: PDFFont;
  size: number;
  width: number;
  space: boolean;
  run: Run;
}

class Writer {
  doc: PDFDocument;
  fonts: FontCache;
  page!: PDFPage;
  y = 0; // distance from top of page
  constructor(
    doc: PDFDocument,
    private o: LayoutOptions,
  ) {
    this.doc = doc;
    this.fonts = new FontCache(doc);
    this.newPage();
  }
  get width() {
    return this.o.pageSize[0] - this.o.margin * 2;
  }
  get bottom() {
    return this.o.pageSize[1] - this.o.margin;
  }
  newPage() {
    this.page = this.doc.addPage(this.o.pageSize);
    this.y = this.o.margin;
  }
  ensure(height: number) {
    if (this.y + height > this.bottom && this.y > this.o.margin + 0.5) this.newPage();
  }
  pdfY(y: number) {
    return this.o.pageSize[1] - y;
  }

  async font(run: Run, bold = false) {
    if (run.code) return this.fonts.get('courier', !!run.bold || bold, !!run.italic);
    return this.fonts.get(this.o.family, !!run.bold || bold, !!run.italic);
  }

  /** Break runs into measured words and spaces. */
  async pieces(runs: Run[], size: number, bold: boolean): Promise<Piece[]> {
    const out: Piece[] = [];
    for (const run of runs) {
      const font = await this.font(run, bold);
      const s = run.code ? size * 0.92 : size;
      const text = safeText(font, run.text);
      // Split on ASCII spaces only so non-breaking spaces (used for indentation) survive.
      for (const part of text.split(/(\n| +)/)) {
        if (!part) continue;
        if (part === '\n') {
          out.push({ text: '\n', font, size: s, width: 0, space: true, run });
          continue;
        }
        const space = /^ +$/.test(part);
        const t = space ? ' ' : part;
        out.push({ text: t, font, size: s, width: font.widthOfTextAtSize(t, s), space, run });
      }
    }
    return out;
  }

  /** Lay out words into lines of at most `width`, splitting over-long words. */
  wrap(pieces: Piece[], width: number): Piece[][] {
    const lines: Piece[][] = [];
    let line: Piece[] = [];
    let w = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      lines.push(line);
      line = [];
      w = 0;
    };
    for (let p of pieces) {
      if (p.text === '\n') {
        flush();
        continue;
      }
      if (p.space) {
        if (line.length) {
          line.push(p);
          w += p.width;
        }
        continue;
      }
      if (w + p.width > width && line.length) flush();
      if (p.width > width) {
        // Hard-break a very long word.
        let chunk = '';
        for (const ch of p.text) {
          const cw = p.font.widthOfTextAtSize(chunk + ch, p.size);
          if (cw > width && chunk) {
            line.push({ ...p, text: chunk, width: p.font.widthOfTextAtSize(chunk, p.size) });
            flush();
            chunk = ch;
          } else chunk += ch;
        }
        p = { ...p, text: chunk, width: p.font.widthOfTextAtSize(chunk, p.size) };
      }
      line.push(p);
      w += p.width;
    }
    if (line.length || !lines.length) flush();
    return lines;
  }

  drawLine(line: Piece[], x: number, baseline: number) {
    let cx = x;
    let i = 0;
    while (i < line.length) {
      // Merge consecutive pieces that share a font/size/style into one draw call.
      const first = line[i];
      let text = first.text;
      let width = first.width;
      let j = i + 1;
      while (
        j < line.length &&
        line[j].font === first.font &&
        line[j].size === first.size &&
        !!line[j].run.link === !!first.run.link &&
        !!line[j].run.strike === !!first.run.strike &&
        !!line[j].run.code === !!first.run.code
      ) {
        text += line[j].text;
        width += line[j].width;
        j++;
      }
      const color = first.run.link ? LINK : INK;
      if (first.run.code && text.trim()) {
        this.page.drawRectangle({
          x: cx - 1,
          y: this.pdfY(baseline) - first.size * 0.25,
          width: width + 2,
          height: first.size * 1.15,
          color: CODE_BG,
        });
      }
      this.page.drawText(text, { x: cx, y: this.pdfY(baseline), font: first.font, size: first.size, color });
      if (first.run.link || first.run.strike) {
        const ly = first.run.strike ? this.pdfY(baseline) + first.size * 0.3 : this.pdfY(baseline) - first.size * 0.12;
        this.page.drawLine({ start: { x: cx, y: ly }, end: { x: cx + width, y: ly }, thickness: 0.6, color });
      }
      cx += width;
      i = j;
    }
  }

  async text(b: Extract<Block, { kind: 'text' }>) {
    const scale = HEADING_SCALE[b.style];
    const size = this.o.fontSize * scale;
    const heading = b.style.startsWith('h');
    const lh = size * (heading ? 1.25 : this.o.lineHeight);
    const indent = (b.indent ?? 0) * 18 + (b.bullet ? 16 : 0) + (b.style === 'quote' ? 14 : 0);
    const x0 = this.o.margin + indent;
    const pieces = await this.pieces(b.runs, size, heading);
    const lines = this.wrap(pieces, this.width - indent);

    if (heading) {
      this.y += size * (b.style === 'h1' ? 0.6 : 0.8);
      this.ensure(lh * Math.min(lines.length, 2) + this.o.fontSize * 2); // keep headings with following text
    }
    const bodyFont = await this.fonts.get(this.o.family);
    for (let li = 0; li < lines.length; li++) {
      this.ensure(lh);
      const top = this.y;
      const baseline = top + size * 0.95;
      const line = lines[li];
      const lineWidth = line.reduce((s, p) => s + p.width, 0);
      let x = x0;
      if (b.align === 'center') x = x0 + (this.width - indent - lineWidth) / 2;
      if (b.align === 'right') x = x0 + (this.width - indent - lineWidth);
      if (li === 0 && b.bullet) {
        const bt = safeText(bodyFont, b.bullet);
        const bw = bodyFont.widthOfTextAtSize(bt, size);
        this.page.drawText(bt, { x: x0 - 6 - bw, y: this.pdfY(baseline), size, font: bodyFont, color: INK });
      }
      if (b.style === 'quote') {
        this.page.drawRectangle({ x: x0 - 12, y: this.pdfY(top + lh), width: 2.5, height: lh, color: RULE });
      }
      this.drawLine(line, x, baseline);
      this.y += lh;
    }
    if (b.style === 'h1' || b.style === 'h2') {
      this.page.drawLine({
        start: { x: this.o.margin, y: this.pdfY(this.y + 2) },
        end: { x: this.o.margin + this.width, y: this.pdfY(this.y + 2) },
        thickness: b.style === 'h1' ? 1 : 0.5,
        color: RULE,
      });
      this.y += 6;
    }
    this.y += b.style === 'line' || b.bullet ? size * 0.15 : size * 0.6;
  }

  async code(text: string) {
    const font = await this.fonts.get('courier');
    const size = this.o.fontSize * 0.88;
    const lh = size * 1.35;
    const pad = 8;
    const pieces: Piece[] = [];
    for (const rawLine of safeText(font, text).split('\n')) {
      // Preserve indentation by keeping whitespace as a visible word.
      const t = rawLine.length ? rawLine : ' ';
      pieces.push({ text: t, font, size, width: font.widthOfTextAtSize(t, size), space: false, run: { text: t, code: true } });
      pieces.push({ text: '\n', font, size, width: 0, space: true, run: { text: '' } });
    }
    pieces.pop();
    const lines = this.wrap(pieces, this.width - pad * 2);
    this.y += 2;
    for (const line of lines) {
      this.ensure(lh);
      this.page.drawRectangle({
        x: this.o.margin,
        y: this.pdfY(this.y + lh),
        width: this.width,
        height: lh,
        color: CODE_BG,
      });
      const t = line.map((p) => p.text).join('');
      this.page.drawText(t, { x: this.o.margin + pad, y: this.pdfY(this.y + size * 1.05), size, font, color: INK });
      this.y += lh;
    }
    this.y += this.o.fontSize * 0.8;
  }

  hr() {
    this.ensure(16);
    this.y += 8;
    this.page.drawLine({
      start: { x: this.o.margin, y: this.pdfY(this.y) },
      end: { x: this.o.margin + this.width, y: this.pdfY(this.y) },
      thickness: 0.75,
      color: RULE,
    });
    this.y += 10;
  }

  async table(rows: Run[][][], header: boolean) {
    if (!rows.length) return;
    const cols = Math.max(...rows.map((r) => r.length));
    const colW = this.width / cols;
    const pad = 5;
    const size = this.o.fontSize * 0.92;
    const lh = size * 1.3;
    this.y += 4;
    for (let r = 0; r < rows.length; r++) {
      const isHead = header && r === 0;
      const cells: Piece[][][] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(this.wrap(await this.pieces(rows[r][c] ?? [], size, isHead), colW - pad * 2));
      }
      const rowH = Math.max(...cells.map((l) => l.length)) * lh + pad * 2;
      this.ensure(rowH);
      const top = this.y;
      if (isHead) {
        this.page.drawRectangle({ x: this.o.margin, y: this.pdfY(top + rowH), width: this.width, height: rowH, color: CODE_BG });
      }
      for (let c = 0; c < cols; c++) {
        const x = this.o.margin + c * colW;
        this.page.drawRectangle({
          x,
          y: this.pdfY(top + rowH),
          width: colW,
          height: rowH,
          borderColor: RULE,
          borderWidth: 0.6,
        });
        cells[c].forEach((line, i) => this.drawLine(line, x + pad, top + pad + i * lh + size * 0.95));
      }
      this.y += rowH;
    }
    this.y += this.o.fontSize * 0.8;
  }

  async image(src: string, alt?: string) {
    let img: PDFImage;
    try {
      img = await embedImageSrc(this.doc, src);
    } catch {
      if (alt) await this.text({ kind: 'text', style: 'p', runs: [{ text: `[image: ${alt}]`, italic: true }] });
      return;
    }
    // Treat image pixels as CSS px (0.75pt) and scale down to fit the page.
    let w = img.width * 0.75;
    let h = img.height * 0.75;
    const maxH = this.o.pageSize[1] - this.o.margin * 2;
    const k = Math.min(1, this.width / w, maxH / h);
    w *= k;
    h *= k;
    this.ensure(h);
    this.page.drawImage(img, { x: this.o.margin, y: this.pdfY(this.y + h), width: w, height: h });
    this.y += h + this.o.fontSize * 0.8;
  }
}

async function embedImageSrc(doc: PDFDocument, src: string): Promise<PDFImage> {
  const m = src.match(/^data:image\/(png|jpe?g)[^,]*;base64,/i);
  if (m) {
    const bytes = Uint8Array.from(atob(src.slice(m[0].length)), (c) => c.charCodeAt(0));
    return m[1].toLowerCase() === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
  }
  // Anything else the browser can decode (gif, webp, bmp, svg...): convert through a canvas.
  const png = await imageUrlToPng(src);
  return doc.embedPng(png);
}

export function imageUrlToPng(src: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 1;
      c.height = img.naturalHeight || 1;
      c.getContext('2d')!.drawImage(img, 0, 0);
      c.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('encode failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

export async function blocksToPdf(blocks: Block[], o: LayoutOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (o.title) doc.setTitle(o.title);
  doc.setProducer('PDF Maker');
  doc.setCreator('PDF Maker');
  const w = new Writer(doc, o);
  for (const b of blocks) {
    switch (b.kind) {
      case 'text':
        if (b.runs.some((r) => r.text.trim())) await w.text(b);
        else w.y += o.fontSize * o.lineHeight;
        break;
      case 'code':
        await w.code(b.text);
        break;
      case 'hr':
        w.hr();
        break;
      case 'gap':
        w.y += b.size;
        break;
      case 'pagebreak':
        w.newPage();
        break;
      case 'table':
        await w.table(b.rows, b.header);
        break;
      case 'image':
        await w.image(b.src, b.alt);
        break;
    }
  }
  return doc.save();
}

/* ---------- sources → blocks ---------- */

export function plainTextToBlocks(text: string): Block[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line): Block => {
      if (line === '\f') return { kind: 'pagebreak' };
      return { kind: 'text', style: 'line', runs: [{ text: line.replace(/^\s+/, (s) => ' '.repeat(s.length)) }] };
    });
}

export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  walkMd(marked.lexer(md), blocks, 0);
  return blocks;
}

function walkMd(tokens: Token[], out: Block[], indent: number, quote = false) {
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const level = Math.min((t as Tokens.Heading).depth, 4);
        out.push({ kind: 'text', style: `h${level}` as TextStyle, runs: inlineMd((t as Tokens.Heading).tokens) });
        break;
      }
      case 'paragraph':
        out.push({ kind: 'text', style: quote ? 'quote' : 'p', runs: inlineMd((t as Tokens.Paragraph).tokens), indent });
        break;
      case 'text':
        out.push({
          kind: 'text',
          style: quote ? 'quote' : 'p',
          runs: (t as Tokens.Text).tokens ? inlineMd((t as Tokens.Text).tokens!) : [{ text: (t as Tokens.Text).text }],
          indent,
        });
        break;
      case 'code':
        out.push({ kind: 'code', text: (t as Tokens.Code).text });
        break;
      case 'hr':
        out.push({ kind: 'hr' });
        break;
      case 'blockquote':
        walkMd((t as Tokens.Blockquote).tokens, out, indent, true);
        break;
      case 'list': {
        const list = t as Tokens.List;
        const start = typeof list.start === 'number' ? list.start : 1;
        list.items.forEach((item, i) => {
          const bullet = list.ordered ? `${start + i}.` : item.task ? (item.checked ? '[x]' : '[ ]') : '•';
          const [first, ...rest] = item.tokens;
          if (first && (first.type === 'text' || first.type === 'paragraph')) {
            const ft = first as Tokens.Text;
            out.push({ kind: 'text', style: 'p', runs: ft.tokens ? inlineMd(ft.tokens) : [{ text: ft.text }], indent, bullet });
            walkMd(rest, out, indent + 1, quote);
          } else {
            out.push({ kind: 'text', style: 'p', runs: [{ text: '' }], indent, bullet });
            walkMd(item.tokens, out, indent + 1, quote);
          }
        });
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        const rows = [tb.header.map((c) => inlineMd(c.tokens)), ...tb.rows.map((r) => r.map((c) => inlineMd(c.tokens)))];
        out.push({ kind: 'table', rows, header: true });
        break;
      }
      case 'html': {
        const html = (t as Tokens.HTML).text;
        if (/<div[^>]*page-break|<!--\s*pagebreak\s*-->/i.test(html)) out.push({ kind: 'pagebreak' });
        else out.push(...htmlToBlocks(html));
        break;
      }
      case 'space':
        break;
      default:
        if ('text' in t && typeof t.text === 'string') out.push({ kind: 'text', style: 'p', runs: [{ text: t.text }], indent });
    }
  }
}

function inlineMd(tokens: Token[], style: Omit<Run, 'text'> = {}): Run[] {
  const runs: Run[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
        runs.push(...inlineMd((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        runs.push(...inlineMd((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        runs.push(...inlineMd((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        runs.push({ ...style, text: decodeEntities((t as Tokens.Codespan).text), code: true });
        break;
      case 'link':
        runs.push(...inlineMd((t as Tokens.Link).tokens, { ...style, link: true }));
        break;
      case 'br':
        runs.push({ ...style, text: '\n' });
        break;
      case 'image':
        runs.push({ ...style, text: `[${(t as Tokens.Image).text || 'image'}]`, italic: true });
        break;
      case 'text':
        if ((t as Tokens.Text).tokens?.length) runs.push(...inlineMd((t as Tokens.Text).tokens!, style));
        else runs.push({ ...style, text: decodeEntities((t as Tokens.Text).text) });
        break;
      default:
        if ('text' in t && typeof t.text === 'string') runs.push({ ...style, text: decodeEntities(t.text) });
    }
  }
  return runs;
}

function decodeEntities(s: string) {
  if (!s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

/** Convert HTML (e.g. from a .docx via mammoth, or an .html file) into blocks. */
export function htmlToBlocks(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: Block[] = [];
  walkHtml(doc.body, out, 0);
  return out;
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'PRE', 'BLOCKQUOTE', 'HR',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'FIGURE', 'DL', 'DT', 'DD', 'IMG',
]);

function walkHtml(node: Element, out: Block[], indent: number, quote = false) {
  let inline: Node[] = [];
  const flushInline = () => {
    if (inline.length) {
      const runs = inlineHtml(inline);
      if (runs.some((r) => r.text.trim())) out.push({ kind: 'text', style: quote ? 'quote' : 'p', runs, indent });
      inline = [];
    }
  };
  for (const child of [...node.childNodes]) {
    if (child.nodeType !== Node.ELEMENT_NODE || !BLOCK_TAGS.has((child as Element).tagName)) {
      inline.push(child);
      continue;
    }
    flushInline();
    const el = child as HTMLElement;
    const align = alignOf(el);
    switch (el.tagName) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        const level = Math.min(parseInt(el.tagName[1], 10), 4);
        out.push({ kind: 'text', style: `h${level}` as TextStyle, runs: inlineHtml([...el.childNodes]), align });
        break;
      }
      case 'P':
      case 'DT':
      case 'DD':
        if (el.querySelector('img')) {
          walkHtml(el, out, indent, quote);
        } else {
          const style = el.style.pageBreakBefore === 'always' || el.style.breakBefore === 'page';
          if (style) out.push({ kind: 'pagebreak' });
          out.push({ kind: 'text', style: quote ? 'quote' : 'p', runs: inlineHtml([...el.childNodes]), indent, align });
        }
        break;
      case 'UL':
      case 'OL': {
        let n = parseInt(el.getAttribute('start') ?? '1', 10) || 1;
        for (const li of [...el.children]) {
          if (li.tagName !== 'LI') continue;
          const bullet = el.tagName === 'OL' ? `${n++}.` : '•';
          const nested = [...li.childNodes].filter((c) => c.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((c as Element).tagName));
          const own = [...li.childNodes].filter((c) => !nested.includes(c));
          out.push({ kind: 'text', style: 'p', runs: inlineHtml(own), indent, bullet });
          const wrapper = document.createElement('div');
          nested.forEach((c) => wrapper.append(c.cloneNode(true)));
          walkHtml(wrapper, out, indent + 1, quote);
        }
        break;
      }
      case 'LI':
        out.push({ kind: 'text', style: 'p', runs: inlineHtml([...el.childNodes]), indent, bullet: '•' });
        break;
      case 'TABLE': {
        const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => inlineHtml([...td.childNodes])));
        const header = !!el.querySelector('th') || !!el.querySelector('thead');
        out.push({ kind: 'table', rows, header });
        break;
      }
      case 'PRE':
        out.push({ kind: 'code', text: el.textContent ?? '' });
        break;
      case 'BLOCKQUOTE':
        walkHtml(el, out, indent, true);
        break;
      case 'HR':
        out.push({ kind: 'hr' });
        break;
      case 'IMG': {
        const src = el.getAttribute('src');
        if (src) out.push({ kind: 'image', src, alt: el.getAttribute('alt') ?? undefined });
        break;
      }
      default:
        walkHtml(el, out, indent, quote);
    }
  }
  flushInline();
}

function alignOf(el: HTMLElement): 'left' | 'center' | 'right' | undefined {
  const a = (el.style.textAlign || el.getAttribute('align') || '').toLowerCase();
  return a === 'center' || a === 'right' ? a : undefined;
}

function inlineHtml(nodes: Node[], style: Omit<Run, 'text'> = {}): Run[] {
  const runs: Run[] = [];
  for (const n of nodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n.textContent ?? '').replace(/\s+/g, ' ');
      if (text) runs.push({ ...style, text });
      continue;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const el = n as HTMLElement;
    const kids = [...el.childNodes];
    switch (el.tagName) {
      case 'B':
      case 'STRONG':
      case 'TH':
        runs.push(...inlineHtml(kids, { ...style, bold: true }));
        break;
      case 'I':
      case 'EM':
      case 'CITE':
        runs.push(...inlineHtml(kids, { ...style, italic: true }));
        break;
      case 'CODE':
      case 'KBD':
      case 'SAMP':
        runs.push(...inlineHtml(kids, { ...style, code: true }));
        break;
      case 'A':
        runs.push(...inlineHtml(kids, { ...style, link: !!el.getAttribute('href') }));
        break;
      case 'S':
      case 'DEL':
      case 'STRIKE':
        runs.push(...inlineHtml(kids, { ...style, strike: true }));
        break;
      case 'BR':
        runs.push({ ...style, text: '\n' });
        break;
      case 'SCRIPT':
      case 'STYLE':
      case 'IMG':
        break;
      default:
        runs.push(...inlineHtml(kids, style));
    }
  }
  // Trim leading/trailing whitespace of the paragraph.
  if (runs.length) {
    runs[0] = { ...runs[0], text: runs[0].text.replace(/^ +/, '') };
    const last = runs.length - 1;
    runs[last] = { ...runs[last], text: runs[last].text.replace(/ +$/, '') };
  }
  return runs;
}

