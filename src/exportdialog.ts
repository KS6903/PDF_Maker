/**
 * Export the open tab, edits included, as images, Word, text or a PDF copy.
 * Uses the same conversions as the PDF → Images and PDF → Text & Word tools.
 */

import { Share } from 'lucide';
import { h, field, select, textInput, modal, withBusy, toast } from './lib/ui';
import { baseName, pdfOutput, download, zipOutputs, type OutputFile } from './lib/pdf';
import { activeDoc, currentSource } from './lib/documents';
import { canWriteDisk, exportFile, exportFiles, fileNameOf } from './lib/disk';
import { pdfPagesToImages } from './tools/images';
import { pdfToTextFile } from './tools/extract';

type Format = 'png' | 'jpeg' | 'webp' | 'docx' | 'txt' | 'pdf';

const FORMATS: [Format, string][] = [
  ['png', 'PNG image (sharpest)'],
  ['jpeg', 'JPG image (smaller)'],
  ['webp', 'WebP image (smallest)'],
  ['docx', 'Word document (.docx)'],
  ['txt', 'Plain text (.txt)'],
  ['pdf', 'PDF copy'],
];

// Remembered for the next export in this run.
let last: { format: Format; dpi: string; quality: string } = { format: 'png', dpi: '150', quality: '90' };

export async function exportActive() {
  const d = activeDoc();
  if (!d) return toast('Open a PDF first.');

  const format = select<Format>(FORMATS, last.format, () => paint());
  const dpi = select<string>(
    [
      ['72', 'Screen (72 DPI)'],
      ['150', 'Standard (150 DPI)'],
      ['300', 'Print (300 DPI)'],
      ['600', 'High (600 DPI)'],
    ],
    last.dpi,
  );
  const quality = select<string>(
    [
      ['95', 'Best'],
      ['90', 'High'],
      ['75', 'Medium'],
      ['60', 'Small file'],
    ],
    last.quality,
  );
  const pages = textInput('', 'All pages (e.g. 1-3, 5)');
  const dpiField = field('Resolution', dpi);
  const qualityField = field('Quality', quality);
  const pagesField = field('Pages', pages);
  const note = h('p', { class: 'muted small' });
  function paint() {
    const f = format.value;
    const image = f === 'png' || f === 'jpeg' || f === 'webp';
    dpiField.hidden = !image;
    qualityField.hidden = f !== 'jpeg' && f !== 'webp';
    pagesField.hidden = f === 'pdf';
    note.textContent =
      image ? 'Each page becomes its own picture. Several pages go into a folder you choose.'
      : f === 'pdf' ? 'A separate copy with all your edits. The open file stays as it is.'
      : 'Takes the text of the pages. Scanned pages are pictures, so they have no text to take.';
  }
  paint();

  const choice = await modal(
    `Export “${d.src.name}”`,
    h('div', { class: 'stack' }, field('Export as', format), dpiField, qualityField, pagesField, note),
    [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Export', kind: 'primary', value: 'export' },
    ],
    { icon: Share },
  );
  if (choice !== 'export') return;
  const f = format.value as Format;
  last = { format: f, dpi: dpi.value, quality: quality.value };

  const files = await withBusy('Exporting…', async (progress) => {
    const src = await currentSource(d.id);
    if (!src) return null;
    if (f === 'pdf') return [pdfOutput(`${baseName(d.src.name)} copy`, src.bytes)];
    if (f === 'docx' || f === 'txt') {
      const res = await pdfToTextFile(src, { format: f, byLines: false, pages: pages.value }, progress);
      if (!res.file) throw new Error('No text found. This PDF is probably a scan (pictures only), so export it as images instead.');
      return [res.file];
    }
    return pdfPagesToImages(src, { format: f, dpi: +dpi.value, quality: +quality.value, pages: pages.value }, progress);
  });
  if (!files?.length) return;
  await saveExport(files, d.src.path, baseName(d.src.name));
}

async function bytesOf(f: OutputFile) {
  return f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data;
}

async function saveExport(files: OutputFile[], nearPath: string | undefined, zipName: string) {
  if (!canWriteDisk) {
    if (files.length === 1) return download(files[0]);
    const zip = await withBusy('Zipping…', () => zipOutputs(files, zipName));
    if (zip) download(zip);
    return;
  }
  const res =
    files.length === 1
      ? await exportFile(files[0].name, await bytesOf(files[0]), nearPath)
      : await exportFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await bytesOf(f) }))), nearPath);
  if (res.ok) toast(files.length === 1 ? `Exported “${fileNameOf(res.path)}”.` : `Exported ${files.length} files to “${fileNameOf(res.path)}”.`, 'success');
  else if (!res.canceled) toast(`Couldn’t export. ${res.error ?? ''}`, 'error');
}
