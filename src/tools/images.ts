import { Images, ImageDown, ChevronUp, ChevronDown, X, ImagePlus, FileImage } from 'lucide';
import { PDFDocument, type PDFImage } from '@cantoo/pdf-lib';
import { h, button, dropzone, withBusy, field, select, numberInput, textInput } from '../lib/ui';
import { imageUrlToPng } from '../lib/layout';
import {
  loadJs,
  rasterizePage,
  canvasToBlob,
  parseRanges,
  pdfOutput,
  baseName,
  PAGE_SIZES,
  PAGE_SIZE_OPTIONS,
  type OutputFile,
} from '../lib/pdf';
import { resultsPanel, simpleTool, panel, type Tool } from './common';

interface ImgItem {
  file: File;
  url: string;
}

export const imagesToPdfTool: Tool = {
  id: 'images-to-pdf',
  title: 'Images → PDF',
  blurb: 'Turn photos, scans and screenshots (JPG, PNG, WebP…) into a PDF.',
  icon: Images,
  group: 'Convert',
  mount(el, ctx) {
    const items: ImgItem[] = [];
    const list = h('div', { class: 'image-list' });
    const results = resultsPanel(ctx);
    const size = select<string>([['fit', 'Same as each image'], ...PAGE_SIZE_OPTIONS], 'a4');
    const orient = select<'auto' | 'portrait' | 'landscape'>(
      [
        ['auto', 'Automatic (match image)'],
        ['portrait', 'Portrait'],
        ['landscape', 'Landscape'],
      ],
      'auto',
    );
    const margin = numberInput(24, { min: 0, max: 200 });
    const fitMode = select<'fit' | 'fill'>(
      [
        ['fit', 'Fit whole image on page'],
        ['fill', 'Fill page (crop edges)'],
      ],
      'fit',
    );
    const name = textInput('images', 'File name');
    const build = button('Create PDF', () => run(), { icon: FileImage, kind: 'primary', disabled: true });
    const options = panel(
      h('div', { class: 'grid' }, field('Page size', size), field('Orientation', orient), field('Margin (pt)', margin), field('Image placement', fitMode), field('File name', name)),
    );
    options.hidden = true;

    const zone = dropzone({
      accept: 'image/*',
      multiple: true,
      title: 'Choose images or drop them here',
      hint: 'JPG, PNG, WebP, GIF, BMP, SVG. One page per image',
      icon: ImagePlus,
      onFiles: (files) => {
        for (const f of files) if (f.type.startsWith('image/')) items.push({ file: f, url: URL.createObjectURL(f) });
        render();
      },
    });

    function render() {
      list.replaceChildren(
        ...items.map((it, i) =>
          h(
            'figure',
            { class: 'image-card' },
            h('img', { src: it.url, alt: it.file.name }),
            h('figcaption', null, `${i + 1}. ${it.file.name}`),
            h(
              'div',
              { class: 'image-actions' },
              button(null, () => move(i, -1), { icon: ChevronUp, title: 'Move earlier', kind: 'ghost', disabled: i === 0 }),
              button(null, () => move(i, 1), { icon: ChevronDown, title: 'Move later', kind: 'ghost', disabled: i === items.length - 1 }),
              button(null, () => {
                URL.revokeObjectURL(it.url);
                items.splice(i, 1);
                render();
              }, { icon: X, title: 'Remove', kind: 'ghost' }),
            ),
          ),
        ),
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
      const out = await withBusy('Creating PDF…', async (p) => {
        const doc = await PDFDocument.create();
        for (const [i, it] of items.entries()) {
          p(`Adding image ${i + 1} of ${items.length}…`);
          const img = await embedImageFile(doc, it.file, it.url);
          const iw = img.width * 0.75; // px → pt at 96 dpi
          const ih = img.height * 0.75;
          let pw: number, ph: number;
          if (size.value === 'fit') {
            [pw, ph] = [iw + +margin.value * 2, ih + +margin.value * 2];
          } else {
            [pw, ph] = PAGE_SIZES[size.value];
            const land = orient.value === 'landscape' || (orient.value === 'auto' && img.width > img.height);
            if (land) [pw, ph] = [ph, pw];
          }
          const page = doc.addPage([pw, ph]);
          const m = +margin.value;
          const bw = pw - m * 2;
          const bh = ph - m * 2;
          const k = fitMode.value === 'fill' ? Math.max(bw / iw, bh / ih) : Math.min(bw / iw, bh / ih);
          const w = iw * k;
          const hh = ih * k;
          page.drawImage(img, { x: m + (bw - w) / 2, y: m + (bh - hh) / 2, width: w, height: hh });
        }
        return doc.save();
      });
      if (out) results.show([pdfOutput(name.value.trim() || 'images', out)]);
    }

    el.append(zone, options, list, h('div', { class: 'actions' }, build), results.el);
  },
};

async function embedImageFile(doc: PDFDocument, file: File, url: string): Promise<PDFImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  try {
    if (isJpg) return await doc.embedJpg(bytes);
    if (isPng) return await doc.embedPng(bytes);
  } catch {
    /* fall through to canvas conversion (e.g. CMYK or unusual encodings) */
  }
  return doc.embedPng(await imageUrlToPng(url));
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
      run: async (src, progress) => {
        const js = await loadJs(src);
        const idx = parseRanges(pages.value, js.numPages);
        const fmt = format.value;
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const files: OutputFile[] = [];
        for (const [k, i] of idx.entries()) {
          progress(`Rendering page ${k + 1} of ${idx.length}…`);
          const page = await js.getPage(i + 1);
          const canvas = await rasterizePage(page, +dpi.value / 72);
          const blob = await canvasToBlob(canvas, `image/${fmt}`, +quality.value / 100);
          canvas.width = canvas.height = 0;
          page.cleanup();
          files.push({ name: `${baseName(src.name)}-page-${i + 1}.${ext}`, data: blob, type: `image/${fmt}` });
        }
        await js.loadingTask.destroy();
        return files;
      },
    });
  },
};
