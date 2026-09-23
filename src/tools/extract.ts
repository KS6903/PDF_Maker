import { ScanText, FileType, Copy } from 'lucide';
import { Document, Packer, Paragraph, TextRun, PageBreak } from 'docx';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { h, field, select, textInput, button, toast } from '../lib/ui';
import { loadJs, parseRanges, baseName, type PdfSource, type OutputFile } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';

interface Line {
  text: string;
  size: number;
  y: number;
}

/** Pull text out of each page, grouped into lines and then paragraphs. */
async function extractParagraphs(src: PdfSource, range: string, progress: (t: string) => void) {
  const js = await loadJs(src);
  const pages: Line[][][] = [];
  for (const i of parseRanges(range, js.numPages)) {
    progress(`Reading page ${i + 1}…`);
    const page = await js.getPage(i + 1);
    const content = await page.getTextContent();
    const lines: Line[] = [];
    let cur: Line | null = null;
    let lastEnd = 0;
    for (const raw of content.items) {
      if (!('str' in raw)) continue;
      const it = raw as TextItem;
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      const x = it.transform[4];
      const y = it.transform[5];
      if (!cur || Math.abs(y - cur.y) > size * 0.5) {
        if (cur) lines.push(cur);
        cur = { text: '', size, y };
        lastEnd = x;
      }
      // Insert a space when there's a visible gap between items on the same line.
      if (cur.text && !cur.text.endsWith(' ') && !it.str.startsWith(' ') && x - lastEnd > size * 0.15) cur.text += ' ';
      cur.text += it.str;
      cur.size = Math.max(cur.size, size);
      lastEnd = x + it.width;
      if (it.hasEOL) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);

    // Merge lines into paragraphs: same size and normal line spacing.
    const paras: Line[][] = [];
    let para: Line[] = [];
    for (const line of lines.filter((l) => l.text.trim())) {
      const prev = para[para.length - 1];
      const gap = prev ? prev.y - line.y : 0;
      if (prev && (Math.abs(prev.size - line.size) > 1 || gap > line.size * 1.9 || gap < 0)) {
        paras.push(para);
        para = [];
      }
      para.push(line);
    }
    if (para.length) paras.push(para);
    pages.push(paras);
    page.cleanup();
  }
  await js.loadingTask.destroy();
  return pages;
}

function joinPara(p: Line[]) {
  return p
    .map((l) => l.text.trim())
    .reduce((acc, t) => (acc.endsWith('-') ? acc.slice(0, -1) + t : acc ? `${acc} ${t}` : t), '');
}

export const extractTool: Tool = {
  id: 'extract-text',
  title: 'PDF → Text & Word',
  blurb: 'Extract the text of a PDF to a .txt file or an editable Word document.',
  icon: ScanText,
  group: 'Convert',
  acceptsPdf: true,
  mount(el, ctx) {
    const format = select<'docx' | 'txt'>(
      [
        ['docx', 'Word document (.docx)'],
        ['txt', 'Plain text (.txt)'],
      ],
      'docx',
    );
    const layout = select<'paragraphs' | 'lines'>(
      [
        ['paragraphs', 'Reflow into paragraphs'],
        ['lines', 'Keep original line breaks'],
      ],
      'paragraphs',
    );
    const pages = textInput('', 'All pages');
    const output = h('textarea', { class: 'text-output', readonly: true, hidden: true, 'aria-label': 'Extracted text' }) as HTMLTextAreaElement;
    const copyBtn = button('Copy text', async () => {
      await navigator.clipboard.writeText(output.value);
      toast('Copied to clipboard', 'success');
    }, { icon: Copy, kind: 'ghost' });
    copyBtn.hidden = true;

    simpleTool(el, ctx, {
      actionLabel: 'Extract text',
      actionIcon: FileType,
      busyLabel: 'Extracting text…',
      options: () =>
        h(
          'div',
          { class: 'stack' },
          panel(
            h('div', { class: 'grid' }, field('Save as', format), field('Layout', layout), field('Pages', pages)),
            h('p', { class: 'muted small' }, 'Works for PDFs with real text. Scanned pages are images, so they contain no text to extract.'),
          ),
        ),
      run: async (src, progress) => {
        const data = await extractParagraphs(src, pages.value, progress);
        const byLines = layout.value === 'lines';
        const pageTexts = data.map((paras) => paras.map((p) => (byLines ? p.map((l) => l.text.trimEnd()).join('\n') : joinPara(p))));
        const plain = pageTexts.map((p) => p.join('\n\n')).join('\n\n\f\n\n');
        output.value = plain.replace(/\f/g, '[page break]');
        output.hidden = false;
        copyBtn.hidden = false;
        if (!plain.replace(/\f/g, '').trim()) {
          toast('No text found. This PDF is probably a scan (images only).', 'error');
          return [];
        }
        const name = baseName(src.name);
        let file: OutputFile;
        if (format.value === 'txt') {
          file = { name: `${name}.txt`, data: new Blob([plain], { type: 'text/plain' }), type: 'text/plain' };
        } else {
          const bodySize = median(data.flat().flat().map((l) => l.size)) || 11;
          const children: Paragraph[] = [];
          data.forEach((paras, pi) => {
            paras.forEach((p, k) => {
              const size = p[0].size;
              const heading = size > bodySize * 1.25;
              const text = byLines ? p.map((l) => l.text.trimEnd()) : [joinPara(p)];
              children.push(
                new Paragraph({
                  pageBreakBefore: pi > 0 && k === 0,
                  spacing: { after: 160 },
                  children: text.map(
                    (t, i) => new TextRun({ text: t, bold: heading, size: Math.round(Math.min(Math.max(size, 8), 40) * 2), break: i > 0 ? 1 : 0 }),
                  ),
                }),
              );
            });
            if (!paras.length && pi > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
          });
          const doc = new Document({ sections: [{ children }] });
          file = {
            name: `${name}.docx`,
            data: await Packer.toBlob(doc),
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          };
        }
        return [file];
      },
    });
    el.append(h('div', { class: 'row end' }, copyBtn), output);
  },
};

function median(nums: number[]) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
