import { Video, Paperclip, Download, Film } from 'lucide';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFString, type PDFDocument, type PDFRef } from '@cantoo/pdf-lib';
import { h, icon, button, field, select, numberInput, textInput, dropzone, formatBytes, toast } from '../lib/ui';
import { loadLib, pdfOutput, baseName, canvasToBlob, download, visualFrame, visualRect, uprightMatrix, textOf } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';

interface Media {
  file: File;
  bytes: Uint8Array;
  poster: HTMLCanvasElement;
  /** Height over width of the poster. */
  ratio: number;
}

/** A still from about a second in, or null if the browser can't decode the video. */
async function videoFrame(file: File): Promise<HTMLCanvasElement | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error('unreadable'));
      setTimeout(() => reject(new Error('timeout')), 8000);
    });
    v.currentTime = Math.min(1, (v.duration || 0) / 10);
    await new Promise<void>((resolve) => {
      v.onseeked = () => resolve();
      setTimeout(resolve, 3000);
    });
    const scale = Math.min(1, 960 / (v.videoWidth || 960));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.videoWidth * scale));
    c.height = Math.max(1, Math.round(v.videoHeight * scale));
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return c;
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

/** The picture shown on the page: a video still with a play button, or a labelled card. */
async function makePoster(file: File): Promise<{ poster: HTMLCanvasElement; ratio: number }> {
  const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|avi|mkv)$/i.test(file.name);
  const isAudio = file.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|oga|flac|aac)$/i.test(file.name);
  const still = isVideo ? await videoFrame(file) : null;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  if (still) {
    c.width = still.width;
    c.height = still.height;
    g.drawImage(still, 0, 0);
  } else {
    c.width = 960;
    c.height = isVideo ? 540 : 240;
    const grad = g.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, isAudio ? '#3b2a7a' : '#1f3a5f');
    grad.addColorStop(1, isAudio ? '#7b3fa6' : '#2c6c8f');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    if (isAudio) {
      // A waveform-like row of bars.
      g.fillStyle = 'rgba(255,255,255,0.35)';
      for (let i = 0; i < 60; i++) {
        const bh = 20 + Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)) * 110;
        g.fillRect(250 + i * 11, c.height / 2 - bh / 2, 6, bh);
      }
    }
  }
  const r = Math.min(c.width, c.height) * 0.16;
  const cx = isAudio && !still ? r * 1.6 : c.width / 2;
  const cy = c.height / 2;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(cx - r * 0.35, cy - r * 0.5);
  g.lineTo(cx + r * 0.55, cy);
  g.lineTo(cx - r * 0.35, cy + r * 0.5);
  g.closePath();
  g.fill();
  // File name along the bottom.
  const bar = Math.max(28, c.height * 0.12);
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(0, c.height - bar, c.width, bar);
  g.fillStyle = '#fff';
  g.font = `${Math.round(bar * 0.5)}px "Segoe UI", Arial, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(file.name, bar * 0.4, c.height - bar / 2, c.width - bar * 0.8);
  return { poster: c, ratio: c.height / c.width };
}

/** Add a file to the document's attachment list (the EmbeddedFiles name tree). */
function listAttachment(doc: PDFDocument, name: string, spec: PDFRef) {
  const ctx = doc.context;
  const N = (s: string) => PDFName.of(s);
  let names = doc.catalog.lookupMaybe(N('Names'), PDFDict);
  if (!names) {
    names = ctx.obj({});
    doc.catalog.set(N('Names'), names);
  }
  let tree = names.lookupMaybe(N('EmbeddedFiles'), PDFDict);
  if (!tree) {
    tree = ctx.obj({ Names: [] });
    names.set(N('EmbeddedFiles'), tree);
  }
  // Large trees split into kids; the annotation still carries the file then.
  if (tree.has(N('Kids'))) return;
  const arr = tree.lookupMaybe(N('Names'), PDFArray) ?? ctx.obj([]);
  const pairs: [string, unknown][] = [];
  for (let i = 0; i + 1 < arr.size(); i += 2) pairs.push([textOf(ctx.lookup(arr.get(i))), arr.get(i + 1)]);
  let key = name;
  for (let i = 2; pairs.some(([k]) => k === key); i++) key = `${name} (${i})`;
  pairs.push([key, spec]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  tree.set(N('Names'), ctx.obj(pairs.flatMap(([k, v]) => [PDFHexString.fromText(k), v as PDFRef])));
}

export const richMediaTool: Tool = {
  id: 'rich-media',
  title: 'Add rich media',
  blurb: 'Embed a video, sound or any file on a page, shown with a poster frame.',
  icon: Video,
  group: 'Edit & sign',
  acceptsPdf: true,
  mount(el, ctx) {
    let media: Media | null = null;
    const page = numberInput(1, { min: 1 });
    const place = select<string>(
      [
        ['center', 'Middle of the page'],
        ['top', 'Top of the page'],
        ['bottom', 'Bottom of the page'],
      ],
      'center',
    );
    const width = numberInput(320, { min: 40, max: 1200 });
    const caption = textInput('', 'What it is, for readers and screen readers');
    const preview = h('div', { class: 'media-preview' });

    const zone = dropzone({
      accept: 'video/*,audio/*,*/*',
      title: 'Choose a video, sound or other file',
      hint: 'It is stored inside the PDF',
      icon: Film,
      compact: true,
      onFiles: async ([file]) => {
        if (file.size > 200 * 1024 * 1024) return toast('That file is over 200 MB, which is too big to embed sensibly.', 'error');
        const { poster, ratio } = await makePoster(file);
        media = { file, bytes: new Uint8Array(await file.arrayBuffer()), poster, ratio };
        if (!caption.value) caption.value = file.name;
        poster.classList.add('media-poster');
        preview.replaceChildren(poster, h('p', { class: 'muted small' }, `${file.name} · ${formatBytes(file.size)}`));
      },
    });

    simpleTool(el, ctx, {
      actionLabel: 'Embed on page',
      actionIcon: Paperclip,
      busyLabel: 'Embedding…',
      options: async (src) => {
        const doc = await loadLib(src);
        page.max = String(src.pageCount);
        const existing = doc.getAttachments();
        return h(
          'div',
          { class: 'stack' },
          panel(zone, preview),
          panel(h('div', { class: 'grid' }, field('Page', page), field('Position', place), field('Width (pt)', width), field('Description', caption))),
          h(
            'p',
            { class: 'muted small' },
            'Readers show the poster on the page; clicking it opens the file with the computer’s own player. Nothing plays inside the PDF itself, so it works in any reader that supports attachments.',
          ),
          existing.length
            ? panel(
                h('h3', null, `Already attached (${existing.length})`),
                h(
                  'div',
                  { class: 'stack' },
                  existing.map((a) =>
                    h(
                      'div',
                      { class: 'file-chip' },
                      icon(Paperclip, 18),
                      h('div', null, h('strong', null, a.name), h('span', null, formatBytes(a.data.byteLength))),
                      button('Save', () => download({ name: a.name, data: a.data, type: a.mimeType ?? 'application/octet-stream' }), { icon: Download, kind: 'ghost' }),
                    ),
                  ),
                ),
              )
            : null,
        );
      },
      run: async (src) => {
        if (!media) throw new Error('Choose a file to embed first.');
        const m = media;
        const doc = await loadLib(src);
        const ctx2 = doc.context;
        const N = (s: string) => PDFName.of(s);
        const target = doc.getPage(Math.max(0, Math.min(doc.getPageCount() - 1, (+page.value || 1) - 1)));
        const frame = visualFrame(target);

        const now = new Date();
        const fileStream = ctx2.flateStream(m.bytes, { Type: 'EmbeddedFile', Params: { Size: m.bytes.byteLength } });
        fileStream.dict.set(N('Subtype'), N(m.file.type || 'application/octet-stream'));
        (fileStream.dict.get(N('Params')) as PDFDict).set(N('ModDate'), PDFString.fromDate(now));
        const fileRef = ctx2.register(fileStream);
        const spec = ctx2.obj({ Type: 'Filespec', EF: { F: fileRef, UF: fileRef }, AFRelationship: 'Supplement' });
        spec.set(N('F'), PDFString.of(m.file.name.replace(/[^\x20-\x7e]/g, '_')));
        spec.set(N('UF'), PDFHexString.fromText(m.file.name));
        if (caption.value) spec.set(N('Desc'), PDFHexString.fromText(caption.value));
        const specRef = ctx2.register(spec);
        listAttachment(doc, m.file.name, specRef);

        const w = Math.min(+width.value || 320, frame.width - 24);
        const hgt = w * m.ratio;
        const x = (frame.width - w) / 2;
        const y = place.value === 'top' ? 36 : place.value === 'bottom' ? frame.height - 36 - hgt : (frame.height - hgt) / 2;
        const png = await doc.embedPng(new Uint8Array(await (await canvasToBlob(m.poster, 'image/png')).arrayBuffer()));
        const ap = ctx2.register(
          ctx2.stream(`q ${w} 0 0 ${hgt} 0 0 cm /Poster Do Q`, {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, w, hgt],
            Matrix: uprightMatrix(frame.rotation),
            Resources: { XObject: { Poster: png.ref } },
          }),
        );
        const annot = ctx2.obj({
          Type: 'Annot',
          Subtype: 'FileAttachment',
          Rect: visualRect(target, x, y, w, hgt),
          FS: specRef,
          Name: 'Paperclip',
          F: 4,
          AP: { N: ap },
          P: target.ref,
        });
        annot.set(N('Contents'), PDFHexString.fromText(caption.value || m.file.name));
        annot.set(N('M'), PDFString.fromDate(now));
        target.node.addAnnot(ctx2.register(annot));
        return {
          files: [pdfOutput(`${baseName(src.name)}-media`, await doc.save())],
          note: `${m.file.name} (${formatBytes(m.bytes.byteLength)}) is embedded on page ${doc.getPages().indexOf(target) + 1}.`,
        };
      },
    });
  },
};
