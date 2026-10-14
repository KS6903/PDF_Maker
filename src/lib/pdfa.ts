/**
 * Conversion to PDF/A-2b, the archiving standard: everything needed to show
 * the file is inside it, colours are defined, and nothing in it runs or plays.
 *
 * Pages that already qualify keep their text and vectors. Pages that can't be
 * made to qualify here (fonts that aren't embedded, CMYK colour, old LZW
 * compression) are flattened into images, which always qualify.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { loadLib, loadJs, rasterizePage, canvasToBlob, replacePageWithImage, pruneUnreachable, type PdfSource } from './pdf';
import { findScripts, stripJavaScript } from './scripts';
import { srgbProfile } from './icc';

const N = (s: string) => PDFName.of(s);

function resolve(doc: PDFDocument, obj: PDFObject | undefined) {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function streamText(s: PDFStream) {
  const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents();
  return new TextDecoder('latin1').decode(bytes);
}

function filters(s: PDFStream) {
  const f = s.dict.get(N('Filter'));
  return f ? f.toString() : '';
}

const CMYK_OPERATOR = /(?:^|\s)(?:[-+]?(?:\d+\.?\d*|\.\d+)\s+){4}[kK](?=\s|$)/;

/** Why a page can't stay as it is, or an empty list when it can. */
function pageProblems(doc: PDFDocument, page: PDFPage): string[] {
  const problems = new Set<string>();
  const seen = new Set<PDFObject>();

  const checkContent = (s: PDFStream) => {
    if (/LZWDecode|Crypt/.test(filters(s))) problems.add('old LZW compression');
    try {
      const text = streamText(s);
      if (CMYK_OPERATOR.test(text) || /\/DeviceCMYK\b|\/CMYK\b/.test(text)) problems.add('CMYK colour');
    } catch {
      problems.add('content Folio can’t read');
    }
  };

  const checkFont = (font: PDFDict) => {
    const subtype = font.get(N('Subtype'))?.toString();
    if (subtype === '/Type3') return walkResources(resolve(doc, font.get(N('Resources'))));
    let target = font;
    if (subtype === '/Type0') {
      const kids = resolve(doc, font.get(N('DescendantFonts')));
      const first = kids instanceof PDFArray ? resolve(doc, kids.get(0)) : undefined;
      if (first instanceof PDFDict) target = first;
    }
    const fd = resolve(doc, target.get(N('FontDescriptor')));
    if (!(fd instanceof PDFDict) || !(fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3')))) problems.add('fonts that aren’t embedded');
  };

  function walkResources(res: PDFObject | undefined) {
    if (!(res instanceof PDFDict) || seen.has(res)) return;
    seen.add(res);
    const fonts = resolve(doc, res.get(N('Font')));
    if (fonts instanceof PDFDict) for (const f of fonts.values()) {
      const fd = resolve(doc, f);
      if (fd instanceof PDFDict && !seen.has(fd)) {
        seen.add(fd);
        checkFont(fd);
      }
    }
    const spaces = resolve(doc, res.get(N('ColorSpace')));
    if (spaces instanceof PDFDict) for (const cs of spaces.values()) {
      if (/DeviceCMYK/.test(String(resolve(doc, cs)))) problems.add('CMYK colour');
    }
    for (const group of ['XObject', 'Pattern', 'Shading']) {
      const dict = resolve(doc, res.get(N(group)));
      if (!(dict instanceof PDFDict)) continue;
      for (const v of dict.values()) {
        const obj = resolve(doc, v);
        if (seen.has(obj!)) continue;
        seen.add(obj!);
        const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
        if (!d) continue;
        if (/DeviceCMYK/.test(String(resolve(doc, d.get(N('ColorSpace')))))) problems.add('CMYK colour');
        if (obj instanceof PDFStream) {
          if (/LZWDecode|Crypt/.test(filters(obj))) problems.add('old LZW compression');
          const sub = d.get(N('Subtype'))?.toString();
          if (sub === '/Form' || d.has(N('PatternType'))) {
            if (sub === '/Form' || d.get(N('PatternType'))?.toString() === '1') checkContent(obj);
            walkResources(resolve(doc, d.get(N('Resources'))));
          }
          if (sub === '/PS' || d.has(N('OPI')) || d.has(N('Ref'))) problems.add('printer-only content');
        }
      }
    }
  }

  const contents = resolve(doc, page.node.get(N('Contents')));
  for (const c of contents instanceof PDFArray ? contents.asArray() : [contents]) {
    const s = resolve(doc, c);
    if (s instanceof PDFStream) checkContent(s);
  }
  walkResources(page.node.Resources());
  if (/DeviceCMYK/.test(String(resolve(doc, page.node.get(N('Group')))))) problems.add('CMYK colour');

  // Annotation appearances are drawn too, so they count.
  for (const ref of page.node.Annots()?.asArray() ?? []) {
    const annot = resolve(doc, ref);
    if (!(annot instanceof PDFDict)) continue;
    const n = resolve(doc, resolve(doc, annot.get(N('AP'))) instanceof PDFDict ? (resolve(doc, annot.get(N('AP'))) as PDFDict).get(N('N')) : undefined);
    const streams = n instanceof PDFStream ? [n] : n instanceof PDFDict ? n.values().map((v) => resolve(doc, v)) : [];
    for (const s of streams) {
      if (!(s instanceof PDFStream)) continue;
      checkContent(s);
      walkResources(resolve(doc, s.dict.get(N('Resources'))));
    }
  }
  return [...problems];
}

const FORBIDDEN_ACTIONS = new Set(['/Launch', '/Sound', '/Movie', '/ResetForm', '/ImportData', '/JavaScript', '/Hide', '/SetOCGState', '/Rendition', '/Trans', '/GoTo3DView']);
const FORBIDDEN_ANNOTS = new Set(['/3D', '/Sound', '/Screen', '/Movie', '/FileAttachment', '/RichMedia']);

/** Remove what PDF/A forbids anywhere in the file. Returns what was taken out. */
function clean(doc: PDFDocument) {
  const removed: string[] = [];
  const scripts = stripJavaScript(doc);
  if (scripts) removed.push(`${scripts} script${scripts === 1 ? '' : 's'}`);

  const names = resolve(doc, doc.catalog.get(N('Names')));
  if (names instanceof PDFDict && names.has(N('EmbeddedFiles'))) {
    names.delete(N('EmbeddedFiles'));
    removed.push('attached files');
  }

  let actions = 0;
  let associated = 0;
  const visited = new Set<PDFObject>();
  const visit = (obj: PDFObject | undefined) => {
    if (!obj || visited.has(obj)) return;
    visited.add(obj);
    if (obj instanceof PDFDict) {
      // Associated files (/AF) are a PDF/A-3 feature; they keep attachments reachable.
      if (obj.has(N('AF'))) {
        obj.delete(N('AF'));
        associated++;
      }
      if (obj.has(N('AA'))) {
        obj.delete(N('AA'));
        actions++;
      }
      for (const key of ['A', 'OpenAction']) {
        const a = resolve(doc, obj.get(N(key)));
        if (a instanceof PDFDict && FORBIDDEN_ACTIONS.has(String(a.get(N('S'))))) {
          obj.delete(N(key));
          actions++;
        }
      }
      // Images must not ask readers to smooth them, and transfer functions are device-specific.
      if (obj.get(N('Interpolate'))?.toString() === 'true') obj.set(N('Interpolate'), doc.context.obj(false));
      if (obj.get(N('Type'))?.toString() === '/ExtGState') {
        obj.delete(N('TR'));
        if (obj.has(N('TR2')) && obj.get(N('TR2'))?.toString() !== '/Default') obj.delete(N('TR2'));
      }
      for (const v of obj.values()) if (!(v instanceof PDFRef)) visit(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) if (!(v instanceof PDFRef)) visit(v);
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj);
  if (actions) removed.push(`${actions} automatic action${actions === 1 ? '' : 's'}`);
  if (associated && !removed.includes('attached files')) removed.push('attached files');

  const acro = resolve(doc, doc.catalog.get(N('AcroForm')));
  if (acro instanceof PDFDict) {
    if (acro.has(N('XFA'))) removed.push('the XFA form layer');
    acro.delete(N('XFA'));
    acro.delete(N('NeedAppearances'));
  }

  const oc = resolve(doc, doc.catalog.get(N('OCProperties')));
  const d = oc instanceof PDFDict ? resolve(doc, oc.get(N('D'))) : undefined;
  if (d instanceof PDFDict) {
    d.delete(N('AS'));
    if (!d.has(N('Name'))) d.set(N('Name'), PDFHexString.fromText('Default'));
  }
  return removed;
}

/** Annotations must print, show, and carry a normal appearance only. */
function fixAnnotations(doc: PDFDocument, page: PDFPage) {
  const annots = page.node.Annots();
  if (!annots) return 0;
  let dropped = 0;
  const keep: PDFObject[] = [];
  for (const ref of annots.asArray()) {
    const a = resolve(doc, ref);
    if (!(a instanceof PDFDict)) continue;
    const sub = String(a.get(N('Subtype')));
    const ap = resolve(doc, a.get(N('AP')));
    if (FORBIDDEN_ANNOTS.has(sub) || (!(ap instanceof PDFDict && ap.has(N('N'))) && sub !== '/Popup' && sub !== '/Link')) {
      dropped++;
      continue;
    }
    const flags = (a.get(N('F')) as PDFNumber | undefined)?.asNumber() ?? 0;
    a.set(N('F'), doc.context.obj((flags | 4) & ~(1 | 2 | 32 | 256)));
    if (ap instanceof PDFDict) {
      ap.delete(N('D'));
      ap.delete(N('R'));
    }
    keep.push(ref);
  }
  page.node.set(N('Annots'), doc.context.obj(keep));
  return dropped;
}

function xml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isoSeconds(d: Date) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Info dictionary and XMP metadata saying the same thing, plus the PDF/A claim. */
function writeMetadata(doc: PDFDocument) {
  const title = doc.getTitle() ?? '';
  const author = doc.getAuthor() ?? '';
  const subject = doc.getSubject() ?? '';
  const keywords = doc.getKeywords() ?? '';
  const creator = doc.getCreator() ?? '';
  const created = doc.getCreationDate() ?? new Date();
  const now = new Date();
  // Whole seconds on both sides, so the two records match exactly.
  const createdAt = new Date(Math.floor(created.getTime() / 1000) * 1000);
  const modifiedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);

  const producer = 'Folio';
  doc.setProducer(producer);
  doc.setCreationDate(createdAt);
  doc.setModificationDate(modifiedAt);
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    info.delete(N('Trapped'));
    for (const [key, value] of [['Title', title], ['Author', author], ['Subject', subject], ['Keywords', keywords], ['Creator', creator]] as const) {
      if (value) info.set(N(key), PDFHexString.fromText(value));
      else info.delete(N(key));
    }
  }

  const alt = (v: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${xml(v)}</rdf:li></rdf:Alt>`;
  const packet = [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    '<pdfaid:part>2</pdfaid:part>',
    '<pdfaid:conformance>B</pdfaid:conformance>',
    '<dc:format>application/pdf</dc:format>',
    title ? `<dc:title>${alt(title)}</dc:title>` : '',
    author ? `<dc:creator><rdf:Seq><rdf:li>${xml(author)}</rdf:li></rdf:Seq></dc:creator>` : '',
    subject ? `<dc:description>${alt(subject)}</dc:description>` : '',
    `<xmp:CreateDate>${isoSeconds(createdAt)}</xmp:CreateDate>`,
    `<xmp:ModifyDate>${isoSeconds(modifiedAt)}</xmp:ModifyDate>`,
    `<xmp:MetadataDate>${isoSeconds(modifiedAt)}</xmp:MetadataDate>`,
    creator ? `<xmp:CreatorTool>${xml(creator)}</xmp:CreatorTool>` : '',
    `<pdf:Producer>${producer}</pdf:Producer>`,
    keywords ? `<pdf:Keywords>${xml(keywords)}</pdf:Keywords>` : '',
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ]
    .filter(Boolean)
    .join('\n');
  // PDF/A wants the metadata stream readable as is, without compression.
  const meta = doc.context.stream(new TextEncoder().encode(packet), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(N('Metadata'), doc.context.register(meta));
}

function writeOutputIntent(doc: PDFDocument) {
  const profile = doc.context.flateStream(srgbProfile(), { N: 3 });
  const intent = doc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFHexString.fromText('sRGB IEC61966-2.1'),
    Info: PDFHexString.fromText('sRGB IEC61966-2.1'),
    DestOutputProfile: doc.context.register(profile),
  });
  doc.catalog.set(N('OutputIntents'), doc.context.obj([intent]));
}

function writeId(doc: PDFDocument) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(hex), PDFHexString.of(hex)]);
}

export interface PdfACheck {
  pages: { index: number; problems: string[] }[];
  scripts: number;
  attachments: boolean;
  encrypted: boolean;
  claimsPdfA: boolean;
}

/** What conversion will have to change, without changing anything. */
export async function checkPdfA(src: PdfSource): Promise<PdfACheck> {
  const doc = await loadLib(src);
  const names = resolve(doc, doc.catalog.get(N('Names')));
  const meta = resolve(doc, doc.catalog.get(N('Metadata')));
  let claimsPdfA = false;
  try {
    claimsPdfA = meta instanceof PDFStream && /pdfaid:part/.test(streamText(meta));
  } catch {
    /* unreadable metadata just means no claim */
  }
  return {
    pages: doc.getPages().map((p, index) => ({ index, problems: pageProblems(doc, p) })),
    scripts: findScripts(doc).length,
    attachments: names instanceof PDFDict && names.has(N('EmbeddedFiles')),
    encrypted: src.password !== undefined,
    claimsPdfA,
  };
}

export interface PdfAResult {
  bytes: Uint8Array;
  kept: number;
  flattened: number;
  removed: string[];
}

export async function convertToPdfA(src: PdfSource, opts: { mode: 'auto' | 'images'; dpi?: number }, progress: (t: string) => void): Promise<PdfAResult> {
  const doc = await loadLib(src);
  progress('Removing what archives can’t contain…');
  const removed = clean(doc);
  const pages = doc.getPages();
  const flatten = pages.map((p) => opts.mode === 'images' || pageProblems(doc, p).length > 0);

  if (flatten.some(Boolean)) {
    // Form fields whose widgets live on a flattened page would point at nothing.
    const doomed = new Set<string>();
    pages.forEach((p, i) => flatten[i] && p.node.Annots()?.asArray().forEach((r) => doomed.add(String(r))));
    const form = doc.getForm();
    for (const f of form.getFields()) {
      if (f.acroField.getWidgets().some((w) => doomed.has(String(doc.context.getObjectRef(w.dict))))) {
        try {
          form.removeField(f);
        } catch {
          /* the widget goes with the page either way */
        }
      }
    }
    const js = await loadJs(src);
    try {
      const scale = (opts.dpi ?? 200) / 72;
      const total = flatten.filter(Boolean).length;
      let k = 0;
      for (const [i, page] of pages.entries()) {
        if (!flatten[i]) continue;
        progress(`Flattening page ${i + 1} (${++k} of ${total})…`);
        const pjs = await js.getPage(i + 1);
        const vp = pjs.getViewport({ scale: 1 });
        const canvas = await rasterizePage(pjs, scale);
        const jpg = await doc.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer()));
        replacePageWithImage(page, jpg, vp.width, vp.height);
        canvas.width = canvas.height = 0;
        pjs.cleanup();
      }
    } finally {
      await js.loadingTask.destroy();
    }
  }

  let dropped = 0;
  for (const p of pages) dropped += fixAnnotations(doc, p);
  if (dropped) removed.push(`${dropped} annotation${dropped === 1 ? '' : 's'} that can’t be archived`);

  progress('Writing archive metadata…');
  writeMetadata(doc);
  writeOutputIntent(doc);
  writeId(doc);
  pruneUnreachable(doc);
  const bytes = await doc.save();
  const flattened = flatten.filter(Boolean).length;
  return { bytes, kept: pages.length - flattened, flattened, removed };
}
