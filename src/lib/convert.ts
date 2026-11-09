/**
 * Turns whatever file someone drops on Create PDF into PDF pages: documents,
 * spreadsheets, slides, pictures, e-books, emails, code, text and other PDFs.
 * Files are recognised by what is inside them first and by their extension
 * second, so a renamed picture still converts as a picture, and a file Folio
 * can't read says so instead of turning into a page of gibberish.
 */
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFDocument } from '@cantoo/pdf-lib';
import { blocksToPdf, htmlToBlocks, markdownToBlocks, plainTextToBlocks, type Block, type LayoutOptions, type Run } from './layout';
import { sniffImage, decodeImage, embedPageImage, addImagePage, type ImageKind, type ImagePageOptions, type PageImage } from './images';
import { openPdf, loadLib, baseName, type PdfSource } from './pdf';

export type Part =
  | { name: string; label: string; kind: 'doc'; blocks: Block[]; landscape?: boolean }
  | { name: string; label: string; kind: 'images'; images: PageImage[] }
  | { name: string; label: string; kind: 'pdf'; src: PdfSource };

/** What the converter takes, for the help text. */
export const FORMAT_GROUPS: [string, string][] = [
  ['Documents', 'Word (.docx), OpenDocument (.odt), RTF, HTML, Markdown, plain text'],
  ['Spreadsheets', 'Excel (.xlsx), OpenDocument (.ods), CSV, TSV'],
  ['Presentations', 'PowerPoint (.pptx), OpenDocument (.odp)'],
  ['Pictures', 'JPG, PNG, HEIC, WebP, GIF, BMP, TIFF, AVIF, SVG, ICO'],
  ['Other', 'PDF, EPUB e-books, emails (.eml, .mht), JSON, XML, logs and code files'],
];

/** Explains a refused file, so the message is useful rather than "unsupported". */
export class ConvertError extends Error {}

const IMAGE_EXT: Record<string, ImageKind> = {
  jpg: 'jpg', jpeg: 'jpg', jfif: 'jpg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp', ico: 'ico',
  tif: 'tiff', tiff: 'tiff', heic: 'heic', heif: 'heic', avif: 'avif', svg: 'svg',
};
const CODE_EXT = new Set(
  'js mjs cjs ts tsx jsx py rb php java kt kts swift go rs c h cc cpp hpp cs fs vb lua r pl sh bash zsh ps1 psm1 bat cmd sql css scss sass less xml xsl yaml yml toml ini cfg conf properties env gradle make cmake dockerfile tex bib log diff patch srt vtt'.split(' '),
);
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
};

/* ---------- small helpers ---------- */

function ext(name: string) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function decodeText(b: Uint8Array) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    // Older Windows text files.
    return new TextDecoder('windows-1252').decode(b);
  }
}

/** Binary data (zero bytes or many control characters) isn't text, whatever it's called. */
function looksBinary(b: Uint8Array) {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return false;
  const n = Math.min(b.length, 8000);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) odd++;
  }
  return n > 0 && odd / n > 0.02;
}

const para = (text: string, style: 'p' | 'h1' | 'h2' | 'h3' = 'p', bold = false): Block => ({ kind: 'text', style, runs: [{ text, bold }] });

function paragraphs(text: string): Block[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n/)
    .map((line) => (line.trim() ? para(line.trim()) : ({ kind: 'gap', size: 4 } as Block)));
}

function table(rows: string[][], header: boolean): Block {
  return { kind: 'table', rows: rows.map((r) => r.map((c) => [{ text: c } as Run])), header };
}

/** Drop empty trailing rows and columns, which spreadsheets are full of. */
function trimGrid(rows: string[][]) {
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
  let cols = 0;
  for (const r of rows) for (let c = r.length - 1; c >= 0; c--) if (r[c].trim()) { cols = Math.max(cols, c + 1); break; }
  return rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
}

const MAX_ROWS = 5000;
const MAX_COLS = 40;

function sheetBlocks(name: string | null, rows: string[][], notes: string[]): Block[] {
  let grid = trimGrid(rows);
  if (!grid.length) return [];
  if (grid.length > MAX_ROWS) {
    notes.push(`${name ? `“${name}”` : 'The table'} has ${grid.length.toLocaleString()} rows; the first ${MAX_ROWS.toLocaleString()} are included.`);
    grid = grid.slice(0, MAX_ROWS);
  }
  if (grid[0].length > MAX_COLS) {
    notes.push(`${name ? `“${name}”` : 'The table'} has ${grid[0].length} columns; the first ${MAX_COLS} are included.`);
    grid = grid.map((r) => r.slice(0, MAX_COLS));
  }
  // A first row of labels reads as a header.
  const header = grid.length > 1 && grid[0].every((c) => c.trim() && isNaN(Number(c)));
  return [...(name ? [para(name, 'h2')] : []), table(grid, header)];
}

function xml(s: string) {
  return new DOMParser().parseFromString(s, 'application/xml');
}

/** Elements by local name, whatever namespace prefix the file uses. */
function els(root: Element | Document, local: string): Element[] {
  return [...root.getElementsByTagNameNS('*', local)];
}

function kids(el: Element, local?: string) {
  return [...el.children].filter((c) => !local || c.localName === local);
}

function attr(el: Element, local: string) {
  for (const a of [...el.attributes]) if (a.localName === local) return a.value;
  return null;
}

function resolvePath(base: string, rel: string) {
  if (/^[a-z]+:/i.test(rel)) return rel;
  const parts = (rel.startsWith('/') ? [] : base.split('/').slice(0, -1)).concat(decodeURIComponent(rel.split('#')[0]).split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

async function dataUrl(zip: JSZip, path: string) {
  const f = zip.file(path);
  if (!f) return null;
  const mime = MIME[ext(path)];
  if (!mime) return null; // EMF/WMF and the like: no way to draw them here
  return `data:${mime};base64,${await f.async('base64')}`;
}

/* ---------- CSV ---------- */

function parseCsv(text: string): string[][] {
  const first = text.slice(0, text.indexOf('\n') >>> 0 || 2000);
  const delim = ['\t', ';', ','].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/* ---------- RTF ---------- */

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'filetbl', 'revtbl']);

function rtfToText(rtf: string) {
  let out = '';
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false;
  let uc = 1;
  let pendingSkip = 0;
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === '{') {
      stack.push({ skip, uc });
      continue;
    }
    if (ch === '}') {
      ({ skip, uc } = stack.pop() ?? { skip: false, uc: 1 });
      continue;
    }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        if (!skip) out += next;
        i++;
        continue;
      }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        i += 3;
        if (pendingSkip) pendingSkip--;
        else if (!skip) out += new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(hex, 16)]));
        continue;
      }
      if (next === '*') {
        skip = true;
        i++;
        continue;
      }
      if (next === '~') {
        if (!skip) out += ' ';
        i++;
        continue;
      }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const num = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
      if (RTF_SKIP.has(word)) skip = true;
      else if (skip) continue;
      else if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') out += '\n';
      else if (word === 'tab') out += '\t';
      else if (word === 'cell') out += '\t';
      else if (word === 'row') out += '\n';
      else if (word === 'uc' && num !== undefined) uc = num;
      else if (word === 'u' && num !== undefined) {
        out += String.fromCharCode(num < 0 ? num + 65536 : num);
        pendingSkip = uc;
      } else if (word === 'emdash') out += '-';
      else if (word === 'endash') out += '-';
      else if (word === 'bullet') out += '•';
      else if (word === 'lquote' || word === 'rquote') out += "'";
      else if (word === 'ldblquote' || word === 'rdblquote') out += '"';
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    if (pendingSkip) {
      pendingSkip--;
      continue;
    }
    if (!skip) out += ch;
  }
  return out;
}

/* ---------- email ---------- */

interface MimePart {
  headers: Map<string, string>;
  body: string;
}

function splitMime(raw: string): MimePart {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? '' : raw.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers.set(m[1].toLowerCase(), m[2]);
  }
  return { headers, body };
}

function param(header: string | undefined, name: string) {
  const m = header?.match(new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]*))`, 'i'));
  return m ? (m[1] ?? m[2]) : undefined;
}

function decodeBody(p: MimePart): Uint8Array {
  const enc = (p.headers.get('content-transfer-encoding') ?? '').toLowerCase();
  if (enc === 'base64') {
    try {
      return Uint8Array.from(atob(p.body.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    } catch {
      return new Uint8Array();
    }
  }
  let s = p.body;
  if (enc === 'quoted-printable') s = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (enc === 'quoted-printable' && s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(bytes);
}

function charsetText(bytes: Uint8Array, charset?: string) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return decodeText(bytes);
  }
}

/** "=?UTF-8?B?...?=" encoded words in headers. */
function decodeWords(s: string) {
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, mode, text) => {
    const bytes =
      mode.toLowerCase() === 'b'
        ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
        : decodeBody({ headers: new Map([['content-transfer-encoding', 'quoted-printable']]), body: text.replace(/_/g, ' ') });
    return charsetText(bytes, cs);
  });
}

function emailToBlocks(raw: string): Block[] {
  const top = splitMime(raw);
  let html: string | null = null;
  let plain: string | null = null;
  const images = new Map<string, string>();
  const attachments: string[] = [];
  const walk = (p: MimePart, depth = 0) => {
    const type = (p.headers.get('content-type') ?? 'text/plain').toLowerCase();
    const disposition = p.headers.get('content-disposition') ?? '';
    if (type.startsWith('multipart/') && depth < 10) {
      const boundary = param(p.headers.get('content-type'), 'boundary');
      if (!boundary) return;
      for (const chunk of p.body.split(`--${boundary}`).slice(1)) {
        if (chunk.startsWith('--')) break;
        walk(splitMime(chunk.replace(/^\r?\n/, '')), depth + 1);
      }
      return;
    }
    const filename = param(disposition, 'filename') ?? param(p.headers.get('content-type'), 'name');
    if (type.startsWith('image/')) {
      const id = (p.headers.get('content-id') ?? '').replace(/[<>]/g, '');
      const b64 = p.body.replace(/\s+/g, '');
      if (id) images.set(id, `data:${type.split(';')[0]};base64,${b64}`);
      if (filename && !id) attachments.push(decodeWords(filename));
      return;
    }
    if (/attachment/i.test(disposition) || (filename && !type.startsWith('text/'))) {
      if (filename) attachments.push(decodeWords(filename));
      return;
    }
    const text = charsetText(decodeBody(p), param(p.headers.get('content-type'), 'charset'));
    if (type.startsWith('text/html') && html === null) html = text;
    else if (type.startsWith('text/plain') && plain === null) plain = text;
  };
  walk(top);

  const h = (k: string) => decodeWords(top.headers.get(k) ?? '');
  const out: Block[] = [para(h('subject') || '(no subject)', 'h2')];
  for (const [k, label] of [['from', 'From'], ['to', 'To'], ['cc', 'Cc'], ['date', 'Date']]) {
    const v = h(k);
    if (v) out.push({ kind: 'text', style: 'p', runs: [{ text: `${label}: `, bold: true }, { text: v }] });
  }
  if (attachments.length) out.push({ kind: 'text', style: 'p', runs: [{ text: 'Attachments: ', bold: true }, { text: attachments.join(', ') }] });
  out.push({ kind: 'hr' });
  const body = html as string | null;
  if (body !== null) out.push(...htmlToBlocks(body.replace(/cid:([^"'\s>]+)/g, (m, id) => images.get(id) ?? m)));
  else out.push(...paragraphs(plain ?? ''));
  return out;
}

/* ---------- Office Open XML ---------- */

async function rels(zip: JSZip, path: string) {
  const dir = path.split('/').slice(0, -1).join('/');
  const file = `${dir}/_rels/${path.split('/').pop()}.rels`;
  const map = new Map<string, string>();
  const text = await zip.file(file)?.async('string');
  if (!text) return map;
  for (const r of els(xml(text), 'Relationship')) {
    const target = r.getAttribute('Target') ?? '';
    map.set(r.getAttribute('Id') ?? '', r.getAttribute('TargetMode') === 'External' ? target : resolvePath(path, target));
  }
  return map;
}

const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

async function xlsxToBlocks(zip: JSZip, notes: string[]): Promise<Block[]> {
  const wbPath = 'xl/workbook.xml';
  const wb = xml((await zip.file(wbPath)!.async('string')) ?? '');
  const links = await rels(zip, wbPath);
  const shared = els(xml((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '<sst/>'), 'si').map((si) => els(si, 't').map((t) => t.textContent ?? '').join(''));

  // Which cell styles are dates, so serial numbers can be shown as dates.
  const styles = xml((await zip.file('xl/styles.xml')?.async('string')) ?? '<styleSheet/>');
  const customDates = new Set(
    els(styles, 'numFmt')
      .filter((f) => /[dmy]/i.test((f.getAttribute('formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '')))
      .map((f) => Number(f.getAttribute('numFmtId'))),
  );
  const xfs = els(styles, 'cellXfs')[0];
  const dateStyle = xfs ? kids(xfs, 'xf').map((xf) => { const id = Number(xf.getAttribute('numFmtId')); return DATE_FORMATS.has(id) || customDates.has(id); }) : [];

  const out: Block[] = [];
  const sheets = els(wb, 'sheet');
  for (const [si, sheet] of sheets.entries()) {
    const target = links.get(attr(sheet, 'id') ?? '');
    const text = target && (await zip.file(target)?.async('string'));
    if (!text) continue;
    const grid: string[][] = [];
    for (const row of els(xml(text), 'row')) {
      const r = Number(row.getAttribute('r') ?? grid.length + 1) - 1;
      if (r >= MAX_ROWS + 1) break;
      const cells: string[] = (grid[r] = []);
      let next = 0;
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r');
        const col = ref ? [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : next;
        next = col + 1;
        if (col >= MAX_COLS + 1) continue;
        const t = c.getAttribute('t');
        const v = kids(c, 'v')[0]?.textContent ?? '';
        let value: string;
        if (t === 's') value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = els(c, 't').map((x) => x.textContent ?? '').join('');
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'e') value = v;
        else if (v && dateStyle[Number(c.getAttribute('s') ?? 0)]) {
          const d = new Date(Math.round((Number(v) - 25569) * 86400000));
          value = Number(v) % 1 ? d.toLocaleString(undefined, { timeZone: 'UTC' }) : d.toLocaleDateString(undefined, { timeZone: 'UTC' });
        } else value = v ? String(+Number(v).toPrecision(12)) : '';
        cells[col] = value;
      }
      for (let i = 0; i < cells.length; i++) cells[i] ??= '';
    }
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    const blocks = sheetBlocks(sheets.length > 1 ? sheet.getAttribute('name') : null, grid, notes);
    if (!blocks.length) continue;
    if (out.length && si > 0) out.push({ kind: 'pagebreak' });
    out.push(...blocks);
  }
  return out;
}

async function pptxToBlocks(zip: JSZip): Promise<Block[]> {
  const presPath = 'ppt/presentation.xml';
  const pres = xml(await zip.file(presPath)!.async('string'));
  const links = await rels(zip, presPath);
  const out: Block[] = [];
  const ids = els(pres, 'sldId');
  for (const [i, sld] of ids.entries()) {
    const path = links.get(attr(sld, 'id') ?? '');
    const text = path && (await zip.file(path)?.async('string'));
    if (!text) continue;
    const slide = xml(text);
    const slideLinks = await rels(zip, path);
    if (out.length) out.push({ kind: 'pagebreak' });
    let titled = false;
    for (const sp of els(slide, 'sp')) {
      const ph = els(sp, 'ph')[0];
      const isTitle = ph && /title|ctrTitle/i.test(ph.getAttribute('type') ?? '');
      for (const p of els(sp, 'p')) {
        const line = els(p, 't').map((t) => t.textContent ?? '').join('');
        if (!line.trim()) continue;
        if (isTitle && !titled) {
          out.push(para(line, 'h2'));
          titled = true;
        } else {
          const lvl = Number(els(p, 'pPr')[0]?.getAttribute('lvl') ?? 0);
          out.push({ kind: 'text', style: 'p', runs: [{ text: line }], indent: lvl, bullet: ph && !isTitle ? '•' : undefined });
        }
      }
    }
    if (!titled) out.splice(out.length - 0, 0);
    for (const tbl of els(slide, 'tbl')) {
      out.push(table(els(tbl, 'tr').map((tr) => els(tr, 'tc').map((tc) => els(tc, 't').map((t) => t.textContent ?? '').join(''))), true));
    }
    for (const blip of els(slide, 'blip')) {
      const target = slideLinks.get(attr(blip, 'embed') ?? '');
      const src = target && (await dataUrl(zip, target));
      if (src) out.push({ kind: 'image', src });
    }
    if (!out.length || out[out.length - 1].kind === 'pagebreak') out.push(para(`Slide ${i + 1}`, 'h2'));
  }
  return out;
}

/* ---------- OpenDocument ---------- */

/** Inline text of an ODF paragraph, with its spaces, tabs and line breaks. */
function odfText(el: Element): string {
  let s = '';
  for (const n of [...el.childNodes]) {
    if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
    else if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as Element;
      if (e.localName === 's') s += ' '.repeat(Number(attr(e, 'c') ?? 1));
      else if (e.localName === 'tab') s += '\t';
      else if (e.localName === 'line-break') s += '\n';
      else if (e.localName !== 'note' && e.localName !== 'annotation') s += odfText(e);
    }
  }
  return s;
}

async function odfToHtml(zip: JSZip, root: Element, into: HTMLElement) {
  for (const el of kids(root)) {
    const name = el.localName;
    if (name === 'h') {
      const h = document.createElement(`h${Math.min(4, Number(attr(el, 'outline-level') ?? 1))}`);
      h.textContent = odfText(el);
      into.append(h);
    } else if (name === 'p') {
      for (const frame of els(el, 'image')) {
        const src = await dataUrl(zip, attr(frame, 'href') ?? '');
        if (src) into.append(Object.assign(document.createElement('img'), { src }));
      }
      const p = document.createElement('p');
      for (const [i, line] of odfText(el).split('\n').entries()) {
        if (i) p.append(document.createElement('br'));
        p.append(line);
      }
      into.append(p);
    } else if (name === 'list') {
      const ul = document.createElement('ul');
      for (const item of kids(el, 'list-item')) {
        const li = document.createElement('li');
        await odfToHtml(zip, item, li);
        ul.append(li);
      }
      into.append(ul);
    } else if (name === 'table') {
      const t = document.createElement('table');
      for (const row of els(el, 'table-row')) {
        const tr = document.createElement('tr');
        for (const cell of kids(row, 'table-cell')) {
          const td = document.createElement('td');
          td.textContent = kids(cell, 'p').map(odfText).join(' ');
          tr.append(td);
        }
        t.append(tr);
      }
      into.append(t);
    } else if (name === 'section' || name === 'frame' || name === 'text-box' || name === 'list-item' || name === 'list-header') {
      await odfToHtml(zip, el, into);
    } else if (name === 'image') {
      const src = await dataUrl(zip, attr(el, 'href') ?? '');
      if (src) into.append(Object.assign(document.createElement('img'), { src }));
    }
  }
}

function odsToBlocks(content: Document, notes: string[]): Block[] {
  const out: Block[] = [];
  const tables = els(content, 'table').filter((t) => t.parentElement?.localName === 'spreadsheet');
  for (const t of tables) {
    const grid: string[][] = [];
    for (const row of els(t, 'table-row')) {
      const cells: string[] = [];
      for (const cell of kids(row).filter((c) => c.localName === 'table-cell' || c.localName === 'covered-table-cell')) {
        const text = kids(cell, 'p').map(odfText).join(' ');
        // Repeats pad sheets out to a million empty cells; only repeat real content.
        const repeat = text ? Math.min(Number(attr(cell, 'number-columns-repeated') ?? 1), MAX_COLS) : 1;
        for (let i = 0; i < repeat && cells.length <= MAX_COLS; i++) cells.push(text);
      }
      const rowsRepeat = cells.some((c) => c.trim()) ? Math.min(Number(attr(row, 'number-rows-repeated') ?? 1), 100) : 1;
      for (let i = 0; i < rowsRepeat; i++) grid.push([...cells]);
      if (grid.length > MAX_ROWS + 1) break;
    }
    const blocks = sheetBlocks(tables.length > 1 ? attr(t, 'name') : null, grid, notes);
    if (!blocks.length) continue;
    if (out.length) out.push({ kind: 'pagebreak' });
    out.push(...blocks);
  }
  return out;
}

/* ---------- EPUB ---------- */

async function epubToBlocks(zip: JSZip): Promise<{ blocks: Block[]; title?: string }> {
  const container = xml((await zip.file('META-INF/container.xml')?.async('string')) ?? '');
  const opfPath = els(container, 'rootfile')[0]?.getAttribute('full-path');
  const opfText = opfPath && (await zip.file(opfPath)?.async('string'));
  if (!opfPath || !opfText) throw new ConvertError('This e-book is missing its table of contents, so Folio can’t read it.');
  const opf = xml(opfText);
  const manifest = new Map(els(opf, 'item').map((i) => [i.getAttribute('id'), resolvePath(opfPath, i.getAttribute('href') ?? '')]));
  const title = els(opf, 'title')[0]?.textContent ?? undefined;
  const out: Block[] = [];
  for (const ref of els(opf, 'itemref')) {
    const path = manifest.get(ref.getAttribute('idref'));
    const text = path && (await zip.file(path)?.async('string'));
    if (!path || !text) continue;
    const page = new DOMParser().parseFromString(text, 'text/html');
    for (const img of [...page.querySelectorAll('img[src], image')]) {
      const href = img.getAttribute('src') ?? img.getAttribute('xlink:href') ?? img.getAttribute('href');
      const src = href && (await dataUrl(zip, resolvePath(path, href)));
      if (src) {
        const replacement = page.createElement('img');
        replacement.src = src;
        (img.closest('svg') ?? img).replaceWith(replacement);
      }
    }
    const blocks = htmlToBlocks(page.body.innerHTML);
    if (!blocks.length) continue;
    if (out.length) out.push({ kind: 'pagebreak' });
    out.push(...blocks);
  }
  return { blocks: out, title };
}

/* ---------- the dispatcher ---------- */

async function fromZip(bytes: Uint8Array, name: string, notes: string[]): Promise<Omit<Extract<Part, { kind: 'doc' }>, 'name'>> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ConvertError(`“${name}” looks like a damaged zip archive.`);
  }
  if (zip.file('word/document.xml')) {
    const r = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    return { kind: 'doc', label: 'Word document', blocks: htmlToBlocks(r.value) };
  }
  if (zip.file('xl/workbook.xml')) return { kind: 'doc', label: 'Excel spreadsheet', blocks: await xlsxToBlocks(zip, notes), landscape: true };
  if (zip.file('ppt/presentation.xml')) return { kind: 'doc', label: 'PowerPoint presentation', blocks: await pptxToBlocks(zip), landscape: true };
  const mimetype = ((await zip.file('mimetype')?.async('string')) ?? '').trim();
  if (mimetype === 'application/epub+zip') {
    const { blocks } = await epubToBlocks(zip);
    return { kind: 'doc', label: 'E-book', blocks };
  }
  if (mimetype.startsWith('application/vnd.oasis.opendocument.')) {
    const content = xml((await zip.file('content.xml')?.async('string')) ?? '');
    if (/spreadsheet/.test(mimetype)) return { kind: 'doc', label: 'OpenDocument spreadsheet', blocks: odsToBlocks(content, notes), landscape: true };
    const body = els(content, /presentation/.test(mimetype) ? 'presentation' : 'text')[0];
    if (!body) throw new ConvertError(`“${name}” has no content Folio can read.`);
    if (/presentation/.test(mimetype)) {
      const blocks: Block[] = [];
      for (const pg of kids(body, 'page')) {
        const div = document.createElement('div');
        await odfToHtml(zip, pg, div);
        if (blocks.length) blocks.push({ kind: 'pagebreak' });
        blocks.push(...htmlToBlocks(div.innerHTML));
      }
      return { kind: 'doc', label: 'OpenDocument presentation', blocks, landscape: true };
    }
    const div = document.createElement('div');
    await odfToHtml(zip, body, div);
    return { kind: 'doc', label: 'OpenDocument text', blocks: htmlToBlocks(div.innerHTML) };
  }
  throw new ConvertError(`“${name}” is a zip archive, not a document. Unzip it and add the files inside.`);
}

const OLD_OFFICE: Record<string, string> = {
  doc: 'old Word (.doc)',
  xls: 'old Excel (.xls)',
  ppt: 'old PowerPoint (.ppt)',
  msg: 'Outlook (.msg)',
  pub: 'Publisher (.pub)',
  vsd: 'Visio (.vsd)',
};

/**
 * Read one file. Throws a ConvertError with a plain explanation when the file
 * is something Folio can't turn into pages, and returns null if a password
 * prompt for a PDF was cancelled.
 */
export async function convertFile(file: File): Promise<{ part: Part; notes: string[] } | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name;
  const e = ext(name);
  const notes: string[] = [];
  const done = (part: Omit<Part, 'name'>) => ({ part: { ...part, name } as Part, notes });

  if (!bytes.length) throw new ConvertError(`“${name}” is empty.`);
  if (String.fromCharCode(...bytes.subarray(0, 1024)).includes('%PDF-')) {
    const src = await openPdf({ name, bytes });
    if (!src) return null;
    return done({ kind: 'pdf', label: `PDF · ${src.pageCount} page${src.pageCount === 1 ? '' : 's'}`, src });
  }

  const kind = sniffImage(bytes) ?? (IMAGE_EXT[e] === 'heic' || IMAGE_EXT[e] === 'svg' ? IMAGE_EXT[e] : null);
  if (kind) {
    const images = await decodeImage(bytes, kind);
    return done({ kind: 'images', label: images.length > 1 ? `${kind.toUpperCase()} picture · ${images.length} pages` : `${kind.toUpperCase()} picture`, images });
  }

  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) return done(await fromZip(bytes, name, notes));
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    const what = OLD_OFFICE[e] ?? 'old Microsoft Office';
    throw new ConvertError(`“${name}” is an ${what} file, a format only Office reads. Open it in Office and save it as the newer .docx, .xlsx or .pptx, then convert that.`);
  }

  const text = decodeText(bytes);
  if (text.trimStart().startsWith('{\\rtf')) return done({ kind: 'doc', label: 'Rich text', blocks: paragraphs(rtfToText(text)) });
  if (looksBinary(bytes)) {
    throw new ConvertError(`Folio can’t turn “${name}” into pages: it isn’t a document, picture or text file it knows${e ? ` (.${e})` : ''}.`);
  }

  if (e === 'html' || e === 'htm' || e === 'xhtml' || /^\s*(<!doctype html|<html[\s>])/i.test(text)) return done({ kind: 'doc', label: 'Web page', blocks: htmlToBlocks(text) });
  if (e === 'md' || e === 'markdown') return done({ kind: 'doc', label: 'Markdown', blocks: markdownToBlocks(text) });
  if (e === 'eml' || e === 'mht' || e === 'mhtml' || (/^(received|from|return-path|mime-version|message-id):/im.test(text.slice(0, 2000)) && /\nsubject:/i.test(text.slice(0, 4000)))) {
    return done({ kind: 'doc', label: 'Email', blocks: emailToBlocks(text) });
  }
  if (e === 'csv' || e === 'tsv') {
    const blocks = sheetBlocks(null, parseCsv(text), notes);
    return done({ kind: 'doc', label: e.toUpperCase(), blocks: blocks.length ? blocks : paragraphs(text), landscape: (blocks[0]?.kind === 'table' && blocks[0].rows[0]?.length > 6) || undefined });
  }
  if (e === 'json' || e === 'geojson') {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not valid JSON: show it as written */
    }
    return done({ kind: 'doc', label: 'JSON', blocks: [{ kind: 'code', text: pretty }] });
  }
  if (CODE_EXT.has(e)) return done({ kind: 'doc', label: `${e.toUpperCase()} file`, blocks: [{ kind: 'code', text: text.replace(/\t/g, '    ') }] });
  return done({ kind: 'doc', label: 'Text', blocks: plainTextToBlocks(text) });
}

/** All the parts as PDF pages, in order. */
export async function partsToPdf(parts: Part[], layout: LayoutOptions, pictures: ImagePageOptions): Promise<Uint8Array> {
  if (parts.length === 1 && parts[0].kind === 'doc') return blocksToPdf(parts[0].blocks, layout);
  const out = await PDFDocument.create();
  if (layout.title) out.setTitle(layout.title);
  out.setProducer('Folio');
  out.setCreator('Folio');
  for (const part of parts) {
    if (part.kind === 'images') {
      for (const img of part.images) addImagePage(out, await embedPageImage(out, img), pictures);
      continue;
    }
    const doc = part.kind === 'pdf' ? await loadLib(part.src) : await PDFDocument.load(await blocksToPdf(part.blocks, { ...layout, title: baseName(part.name) }));
    for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
  }
  return out.save();
}
