import { FileBadge } from 'lucide';
import { h, field, select } from '../lib/ui';
import { pdfOutput, baseName } from '../lib/pdf';
import { checkPdfA, convertToPdfA } from '../lib/pdfa';
import { simpleTool, panel, type Tool } from './common';

export const standardsTool: Tool = {
  id: 'pdf-standards',
  title: 'Apply PDF standards',
  blurb: 'Convert to PDF/A for long-term archiving.',
  icon: FileBadge,
  group: 'Convert',
  acceptsPdf: true,
  mount(el, ctx) {
    const mode = select<'auto' | 'images'>(
      [
        ['auto', 'Keep text where possible'],
        ['images', 'Flatten every page to an image'],
      ],
      'auto',
    );
    const dpi = select<string>(
      [
        ['200', 'Standard (200 DPI)'],
        ['300', 'High (300 DPI)'],
        ['150', 'Small file (150 DPI)'],
      ],
      '200',
    );

    simpleTool(el, ctx, {
      actionLabel: 'Convert to PDF/A',
      actionIcon: FileBadge,
      busyLabel: 'Converting…',
      options: async (src) => {
        const check = await checkPdfA(src);
        const bad = check.pages.filter((p) => p.problems.length);
        const reasons = [...new Set(bad.flatMap((p) => p.problems))];
        const findings: string[] = [];
        if (check.claimsPdfA) findings.push('The file already says it is PDF/A. Converting again refreshes it.');
        if (bad.length) {
          findings.push(
            `${bad.length} of ${check.pages.length} page${check.pages.length === 1 ? '' : 's'} use ${reasons.join(', ')}. With “Keep text where possible” those pages become images; the rest keep their text.`,
          );
        } else {
          findings.push('Every page can keep its text and vector graphics.');
        }
        if (check.scripts) findings.push(`${check.scripts} script${check.scripts === 1 ? '' : 's'} will be removed. Archives can’t contain code.`);
        if (check.attachments) findings.push('Attached files will be removed. PDF/A-2b only allows attachments that are archives themselves.');
        if (check.encrypted) findings.push('The password will be removed. Archived files can’t be encrypted.');
        return h(
          'div',
          { class: 'stack' },
          panel(
            h('h3', null, 'PDF/A-2b'),
            h('p', { class: 'muted small' }, 'The archiving standard: fonts and colours are built in, and nothing in the file runs, plays or links outside it, so it opens the same way in decades.'),
            h('ul', { class: 'findings' }, findings.map((f) => h('li', null, f))),
          ),
          panel(h('div', { class: 'grid' }, field('Pages', mode), field('Detail for flattened pages', dpi))),
        );
      },
      run: async (src, progress) => {
        const res = await convertToPdfA(src, { mode: mode.value as 'auto' | 'images', dpi: +dpi.value }, progress);
        const parts = [
          res.flattened ? `${res.kept} page${res.kept === 1 ? '' : 's'} kept as they were, ${res.flattened} flattened to images.` : 'Every page kept its text.',
          res.removed.length ? `Removed ${res.removed.join(', ')}.` : '',
          'For audited archiving, confirm the file with a validator such as veraPDF.',
        ];
        return { files: [pdfOutput(`${baseName(src.name)}-pdfa`, res.bytes)], note: parts.filter(Boolean).join(' ') };
      },
    });
  },
};
