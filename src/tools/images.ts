import { Images, ImageDown, ChevronUp, ChevronDown, X, ImagePlus, FileImage, Move } from 'lucide';
import { PDFDocument } from '@cantoo/pdf-lib';
import { h, button, dropzone, withBusy, field, select, numberInput, textInput, toast, errorMessage } from '../lib/ui';
import { loadJs, rasterizePage, canvasToBlob, parseRanges, pdfOutput, baseName, PAGE_SIZE_OPTIONS, type OutputFile, type PdfSource } from '../lib/pdf';
import { pictureKind, decodeImage, embedPageImage, addImagePage, layoutPicture, cropPageImage, isCropped, type ImagePageOptions, type PageImage, type PictureAdjust } from '../lib/images';
import { adjustPicture, pageDrawing } from '../lib/placepicture';
import { resultsPanel, simpleTool, panel, type Tool } from './common';

export interface ImgItem {
  name: string;
  img: PageImage;
  url: string;
  /** Pixel size, upright. */
  px: number;
  py: number;
  adjust: PictureAdjust;
}

/** Read picture files into ready-to-place items. Files that aren't pictures are named in one message. */
export async function readPictures(files: File[]): Promise<ImgItem[]> {
  const out: ImgItem[] = [];
  const refused: string[] = [];
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const kind = pictureKind(bytes, f.name);
      if (!kind) {
        refused.push(f.name);
        continue;
      }
      const pages = await decodeImage(bytes, kind);
      for (const [i, img] of pages.entries()) {
        const url = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type === 'jpg' ? 'image/jpeg' : 'image/png' }));
        const el = new Image();
        el.src = url;
        await el.decode();
        out.push({ name: pages.length > 1 ? `${f.name} (page ${i + 1})` : f.name, img, url, px: el.naturalWidth, py: el.naturalHeight, adjust: {} });
      }
    } catch (err) {
      toast(`${f.name}: ${errorMessage(err)}`, 'error');
    }
  }
  if (refused.length) toast(`Not a picture, so left out: ${refused.join(', ')}`, 'error');
  return out;
}

export const imagesToPdfTool: Tool = {
  id: 'images-to-pdf',
  title: 'Images → PDF',
  blurb: 'Turn photos, scans and screenshots (JPG, PNG, HEIC, WebP…) into a PDF, sized and placed how you want.',
  icon: Images,
  group: 'Convert',
  mount(el, ctx) {
    const items: ImgItem[] = [];
    const list = h('div', { class: 'image-list' });
    const results = resultsPanel(ctx);
    const size = select<string>([['fit', 'Same as each image'], ...PAGE_SIZE_OPTIONS], 'a4', () => render());
    const orient = select<'auto' | 'portrait' | 'landscape'>(
      [
        ['auto', 'Automatic (match image)'],
        ['portrait', 'Portrait'],
        ['landscape', 'Landscape'],
      ],
      'auto',
      () => render(),
    );
    const margin = numberInput(24, { min: 0, max: 200 });
    margin.addEventListener('input', () => render());
    const fitMode = select<'fit' | 'fill'>(
      [
        ['fit', 'Fit whole image on page'],
        ['fill', 'Fill page (crop edges)'],
      ],
      'fit',
      () => render(),
    );
    const name = textInput('images', 'File name');
    const build = button('Create PDF', () => run(), { icon: FileImage, kind: 'primary', disabled: true });
    const hint = h('p', { class: 'muted small' }, 'Click a page, or its ', h('strong', null, 'Adjust'), ' button, to crop, resize, move or turn that picture. Pictures you have adjusted keep their size and spot when you change the settings above.');
    const options = panel(
      h('div', { class: 'grid' }, field('Page size', size), field('Orientation', orient), field('Margin (pt)', margin), field('Image placement', fitMode, 'For pictures you haven’t adjusted'), field('File name', name)),
      hint,
    );
    options.hidden = true;

    const zone = dropzone({
      accept: 'image/*,.heic,.heif,.tif,.tiff,.avif,.svg',
      multiple: true,
      title: 'Choose images or drop them here',
      hint: 'JPG, PNG, HEIC, WebP, GIF, BMP, TIFF, SVG. One page per image',
      icon: ImagePlus,
      onFiles: (files) => void add(files),
    });

    async function add(files: File[]) {
      const read = await withBusy('Reading pictures…', () => readPictures(files));
      if (!read?.length) return;
      items.push(...read);
      if (!name.value.trim() || name.value === 'images') name.value = items.length === 1 ? baseName(items[0].name) : 'images';
      render();
    }

    function pageOptions(): ImagePageOptions {
      return { size: size.value, orientation: orient.value as ImagePageOptions['orientation'], margin: Math.max(0, +margin.value || 0), placement: fitMode.value as 'fit' | 'fill' };
    }

    async function adjust(it: ImgItem) {
      const res = await adjustPicture(it, pageOptions(), it.adjust);
      if (!res) return;
      it.adjust = res;
      render();
    }

    function render() {
      const o = pageOptions();
      list.replaceChildren(
        ...items.map((it, i) => {
          const drawing = pageDrawing(it);
          drawing.draw(layoutPicture(o, it.px, it.py, it.adjust), o, it.adjust);
          drawing.svg.setAttribute('aria-label', `${it.name} on its page`);
          const adjusted = !!it.adjust.placement || !!it.adjust.rotate || isCropped(it.adjust.crop);
          return h(
            'figure',
            { class: 'image-card' },
            h('button', { type: 'button', class: 'image-thumb', title: 'Crop, resize, move or turn this picture', onclick: () => void adjust(it) }, drawing.svg),
            h('figcaption', { title: it.name }, `${i + 1}. ${it.name}`, adjusted ? h('span', { class: 'image-badge' }, 'Adjusted') : null),
            h(
              'div',
              { class: 'image-actions' },
              button('Adjust', () => void adjust(it), { icon: Move, title: 'Crop, resize, move or turn this picture', kind: 'ghost' }),
              button(null, () => move(i, -1), { icon: ChevronUp, title: 'Move earlier', kind: 'ghost', disabled: i === 0 }),
              button(null, () => move(i, 1), { icon: ChevronDown, title: 'Move later', kind: 'ghost', disabled: i === items.length - 1 }),
              button(null, () => {
                URL.revokeObjectURL(it.url);
                items.splice(i, 1);
                render();
              }, { icon: X, title: 'Remove', kind: 'ghost' }),
            ),
          );
        }),
      );
      build.disabled = !items.length;
      options.hidden = !items.length;
      zone.classList.toggle('compact', items.length > 0);
    }
    function move(i: number, d: number) {
      const [it] = items.splice(i, 1);
      items.splice(i + d, 0, it);
      render();
    }

    async function run() {
      const o = pageOptions();
      const out = await withBusy('Creating PDF…', async (p) => {
        const doc = await PDFDocument.create();
        for (const [i, it] of items.entries()) {
          p(`Adding image ${i + 1} of ${items.length}…`);
          addImagePage(doc, await embedPageImage(doc, await cropPageImage(it.img, it.adjust.crop)), o, it.adjust);
        }
        return doc.save();
      });
      if (out) results.show([pdfOutput(name.value.trim() || 'images', out)]);
    }

    el.append(zone, options, list, h('div', { class: 'actions' }, build), results.el);

    // Pictures handed over from File Explorer, or from Create PDF when the file turned out to be a picture.
    const handed = ctx.takeIncomingFiles();
    if (handed?.length) void add(handed);
    return () => items.forEach((it) => URL.revokeObjectURL(it.url));
  },
};

/** Render the chosen pages (all when `pageSpec` is blank) to image files. */
export async function pdfPagesToImages(
  src: PdfSource,
  opts: { format: 'png' | 'jpeg' | 'webp'; dpi: number; quality: number; pages: string },
  progress: (text: string) => void,
): Promise<OutputFile[]> {
  const js = await loadJs(src);
  try {
    const idx = parseRanges(opts.pages, js.numPages);
    const fmt = opts.format;
    const ext = fmt === 'jpeg' ? 'jpg' : fmt;
    const files: OutputFile[] = [];
    for (const [k, i] of idx.entries()) {
      progress(`Rendering page ${k + 1} of ${idx.length}…`);
      const page = await js.getPage(i + 1);
      const canvas = await rasterizePage(page, opts.dpi / 72);
      const blob = await canvasToBlob(canvas, `image/${fmt}`, opts.quality / 100);
      canvas.width = canvas.height = 0;
      page.cleanup();
      files.push({ name: idx.length === 1 && js.numPages === 1 ? `${baseName(src.name)}.${ext}` : `${baseName(src.name)}-page-${i + 1}.${ext}`, data: blob, type: `image/${fmt}` });
    }
    return files;
  } finally {
    await js.loadingTask.destroy();
  }
}

export const pdfToImagesTool: Tool = {
  id: 'pdf-to-images',
  title: 'PDF → Images',
  blurb: 'Save pages as high-quality PNG or JPG images.',
  icon: ImageDown,
  group: 'Convert',
  acceptsPdf: true,
  mount(el, ctx) {
    const format = select<'png' | 'jpeg' | 'webp'>(
      [
        ['png', 'PNG (sharpest)'],
        ['jpeg', 'JPG (smaller)'],
        ['webp', 'WebP (smallest)'],
      ],
      'png',
    );
    const dpi = select<string>(
      [
        ['72', 'Screen (72 DPI)'],
        ['150', 'Standard (150 DPI)'],
        ['300', 'Print (300 DPI)'],
        ['600', 'High (600 DPI)'],
      ],
      '150',
    );
    const quality = numberInput(90, { min: 10, max: 100 });
    const pages = textInput('', 'All pages (e.g. 1-3, 5)');

    simpleTool(el, ctx, {
      actionLabel: 'Convert to images',
      busyLabel: 'Rendering pages…',
      options: () =>
        panel(h('div', { class: 'grid' }, field('Format', format), field('Resolution', dpi), field('Quality (JPG/WebP %)', quality), field('Pages', pages))),
      run: (src, progress) => pdfPagesToImages(src, { format: format.value as 'png' | 'jpeg' | 'webp', dpi: +dpi.value, quality: +quality.value, pages: pages.value }, progress),
    });
  },
};
