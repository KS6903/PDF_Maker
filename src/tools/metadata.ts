import { Info } from 'lucide';
import { PDFName } from '@cantoo/pdf-lib';
import { h, field, textInput, checkbox, formatBytes } from '../lib/ui';
import { loadLib, pdfOutput, baseName } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';

export const metadataTool: Tool = {
  id: 'metadata',
  title: 'Properties & metadata',
  blurb: 'See page sizes and edit the title, author, subject and keywords.',
  icon: Info,
  group: 'Secure & info',
  acceptsPdf: true,
  mount(el, ctx) {
    const title = textInput();
    const author = textInput();
    const subject = textInput();
    const keywords = textInput('', 'Comma separated');
    const creator = textInput();
    const producer = textInput();
    const strip = checkbox('Remove all metadata (for privacy)');
    strip.input.addEventListener('change', () => {
      for (const i of [title, author, subject, keywords, creator, producer]) i.disabled = strip.input.checked;
    });

    simpleTool(el, ctx, {
      actionLabel: 'Save properties',
      busyLabel: 'Saving…',
      options: async (src) => {
        const doc = await loadLib(src);
        title.value = doc.getTitle() ?? '';
        author.value = doc.getAuthor() ?? '';
        subject.value = doc.getSubject() ?? '';
        keywords.value = doc.getKeywords() ?? '';
        creator.value = doc.getCreator() ?? '';
        producer.value = doc.getProducer() ?? '';
        const sizes = new Map<string, number>();
        for (const p of doc.getPages()) {
          const { width, height } = p.getSize();
          const key = `${Math.round(width)} × ${Math.round(height)} pt (${((width / 72) * 25.4).toFixed(0)} × ${((height / 72) * 25.4).toFixed(0)} mm)`;
          sizes.set(key, (sizes.get(key) ?? 0) + 1);
        }
        const fmt = (d?: Date) => (d ? d.toLocaleString() : '—');
        const facts: [string, string][] = [
          ['Pages', String(doc.getPageCount())],
          ['File size', formatBytes(src.bytes.byteLength)],
          ['Page sizes', [...sizes].map(([k, n]) => `${k}${sizes.size > 1 ? ` × ${n}` : ''}`).join('; ')],
          ['Created', fmt(doc.getCreationDate())],
          ['Modified', fmt(doc.getModificationDate())],
          ['Encrypted', src.password !== undefined ? 'Yes (password protected)' : 'No'],
          ['Form fields', String(doc.getForm().getFields().length)],
        ];
        return h(
          'div',
          { class: 'stack' },
          panel(h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
          panel(
            h(
              'div',
              { class: 'grid' },
              field('Title', title),
              field('Author', author),
              field('Subject', subject),
              field('Keywords', keywords),
              field('Creator app', creator),
              field('Producer', producer),
            ),
            strip.el,
          ),
        );
      },
      run: async (src) => {
        const doc = await loadLib(src);
        if (strip.input.checked) {
          doc.setTitle('');
          doc.setAuthor('');
          doc.setSubject('');
          doc.setKeywords([]);
          doc.setCreator('');
          doc.setProducer('');
          doc.catalog.delete(PDFName.of('Metadata'));
        } else {
          doc.setTitle(title.value);
          doc.setAuthor(author.value);
          doc.setSubject(subject.value);
          doc.setKeywords(keywords.value.split(',').map((k) => k.trim()).filter(Boolean));
          doc.setCreator(creator.value);
          doc.setProducer(producer.value);
        }
        doc.setModificationDate(new Date());
        return [pdfOutput(`${baseName(src.name)}`, await doc.save())];
      },
    });
  },
};
