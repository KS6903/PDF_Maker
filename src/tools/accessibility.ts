import { Accessibility, CircleCheck, TriangleAlert, Info } from 'lucide';
import { PDFDict, PDFHexString, PDFName, type PDFDocument } from '@cantoo/pdf-lib';
import { h, icon, field, select, textInput, checkbox } from '../lib/ui';
import { loadLib, loadJs, pdfOutput, baseName, textOf, type PdfSource } from '../lib/pdf';
import { ocrDocument, pageHasText } from '../lib/ocr';
import { simpleTool, panel, type Tool } from './common';

const LANGUAGES: [string, string][] = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['es-ES', 'Spanish'],
  ['it-IT', 'Italian'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['pt-PT', 'Portuguese (Portugal)'],
  ['nl-NL', 'Dutch'],
  ['sv-SE', 'Swedish'],
  ['da-DK', 'Danish'],
  ['nb-NO', 'Norwegian'],
  ['fi-FI', 'Finnish'],
  ['pl-PL', 'Polish'],
  ['cs-CZ', 'Czech'],
  ['ru-RU', 'Russian'],
  ['uk-UA', 'Ukrainian'],
  ['tr-TR', 'Turkish'],
  ['el-GR', 'Greek'],
  ['ar', 'Arabic'],
  ['he-IL', 'Hebrew'],
  ['hi-IN', 'Hindi'],
  ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
  ['other', 'Other…'],
];

/** "billing_address.zipCode" → "Zip code" */
function humanize(name: string) {
  const last = name.split('.').pop() ?? name;
  const words = last
    .replace(/\[\d+\]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

interface Finding {
  tone: 'ok' | 'warn' | 'info';
  text: string;
}

function bookmarkEveryPage(doc: PDFDocument) {
  const ctx = doc.context;
  const outlinesRef = ctx.nextRef();
  const refs = doc.getPages().map(() => ctx.nextRef());
  doc.getPages().forEach((page, i) => {
    const item = ctx.obj({ Title: PDFHexString.fromText(`Page ${i + 1}`), Parent: outlinesRef, Dest: [page.ref, 'Fit'] });
    if (i > 0) item.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < refs.length - 1) item.set(PDFName.of('Next'), refs[i + 1]);
    ctx.assign(refs[i], item);
  });
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
}

export const accessibilityTool: Tool = {
  id: 'accessibility',
  title: 'Prepare for accessibility',
  blurb: 'Check a PDF for screen readers and fix its title, language, tab order and field labels.',
  icon: Accessibility,
  group: 'Secure & info',
  acceptsPdf: true,
  mount(el, ctx) {
    const title = textInput('', 'A title that describes the document');
    const lang = select<string>(LANGUAGES, 'en-US', (v) => (otherLang.hidden = v !== 'other'));
    const otherLang = textInput('', 'Language code, e.g. ca-ES');
    otherLang.hidden = true;
    const displayTitle = checkbox('Show the title instead of the file name', true);
    const tabs = checkbox('Tab through fields and links in reading order', true);
    const tooltips = checkbox('Label form fields that have no description', true);
    const bookmarks = checkbox('Add a bookmark for each page');
    const ocr = checkbox('Recognise text on scanned pages (OCR)', true);
    let scanned: number[] = [];

    simpleTool(el, ctx, {
      actionLabel: 'Apply fixes',
      actionIcon: Accessibility,
      busyLabel: 'Fixing…',
      options: async (src: PdfSource) => {
        const doc = await loadLib(src);
        const js = await loadJs(src);
        scanned = [];
        try {
          for (let n = 1; n <= js.numPages; n++) {
            const page = await js.getPage(n);
            if (!(await pageHasText(page))) scanned.push(n - 1);
            page.cleanup();
          }
        } finally {
          await js.loadingTask.destroy();
        }

        const catalog = doc.catalog;
        const langText = textOf(catalog.get(PDFName.of('Lang'))).trim();
        const markInfo = catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict);
        const tagged = !!catalog.get(PDFName.of('StructTreeRoot')) && markInfo?.get(PDFName.of('Marked'))?.toString() === 'true';
        const fields = doc.getForm().getFields();
        const unlabeled = fields.filter((f) => !f.acroField.dict.has(PDFName.of('TU')));
        const hasOutline = !!catalog.get(PDFName.of('Outlines'));
        const prefs = catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict);
        const showsTitle = prefs?.get(PDFName.of('DisplayDocTitle'))?.toString() === 'true';
        const pagesWithAnnots = doc.getPages().filter((p) => p.node.Annots()?.size());
        const tabsMissing = pagesWithAnnots.filter((p) => !p.node.get(PDFName.of('Tabs')));

        title.value = doc.getTitle() || baseName(src.name).replace(/[_-]+/g, ' ');
        const known = LANGUAGES.find(([code]) => code.toLowerCase() === langText.toLowerCase());
        lang.value = known ? known[0] : langText ? 'other' : LANGUAGES.find(([c]) => c === navigator.language)?.[0] ?? 'en-US';
        otherLang.value = known ? '' : langText;
        otherLang.hidden = lang.value !== 'other';
        displayTitle.input.checked = true;
        bookmarks.input.checked = !hasOutline && doc.getPageCount() > 20;
        ocr.el.hidden = !scanned.length;

        const findings: Finding[] = [
          doc.getTitle() ? { tone: 'ok', text: `Title: “${doc.getTitle()}”` } : { tone: 'warn', text: 'No title. Screen readers announce the file name instead.' },
          langText ? { tone: 'ok', text: `Language: ${langText}` } : { tone: 'warn', text: 'No language set, so screen readers may read it with the wrong voice.' },
          showsTitle ? { tone: 'ok', text: 'Readers show the title in the window.' } : { tone: 'warn', text: 'Readers show the file name rather than the title.' },
          scanned.length
            ? { tone: 'warn', text: `${scanned.length} page${scanned.length === 1 ? ' has' : 's have'} no text (scanned), so nothing on ${scanned.length === 1 ? 'it' : 'them'} can be read aloud.` }
            : { tone: 'ok', text: 'Every page has real text.' },
          fields.length
            ? unlabeled.length
              ? { tone: 'warn', text: `${unlabeled.length} of ${fields.length} form field${fields.length === 1 ? '' : 's'} ${unlabeled.length === 1 ? 'has' : 'have'} no description for screen readers.` }
              : { tone: 'ok', text: 'Every form field has a description.' }
            : null,
          tabsMissing.length ? { tone: 'warn', text: `${tabsMissing.length} page${tabsMissing.length === 1 ? '' : 's'} with fields or links ${tabsMissing.length === 1 ? 'has' : 'have'} no set tab order.` } : null,
          doc.getPageCount() > 20 && !hasOutline ? { tone: 'warn', text: 'A long document with no bookmarks is hard to move around in.' } : null,
          tagged
            ? { tone: 'ok', text: 'The file is tagged, so its reading order and structure are recorded.' }
            : {
                tone: 'info',
                text: 'The file is not tagged. Screen readers will guess the reading order from the page. Tags are best made where the document was written, for example by saving from Word with “Document structure tags for accessibility” on.',
              },
        ].filter((f): f is Finding => !!f);

        return h(
          'div',
          { class: 'stack' },
          panel(
            h('h3', null, 'Check'),
            h(
              'ul',
              { class: 'a11y-list' },
              findings.map((f) => h('li', { class: f.tone }, icon(f.tone === 'ok' ? CircleCheck : f.tone === 'warn' ? TriangleAlert : Info, 16), h('span', null, f.text))),
            ),
          ),
          panel(
            h('h3', null, 'Fixes'),
            h('div', { class: 'grid' }, field('Title', title), field('Language', lang), otherLang),
            h('div', { class: 'stack' }, displayTitle.el, tabs.el, tooltips.el, bookmarks.el, ocr.el),
          ),
        );
      },
      run: async (src, progress) => {
        const doc = await loadLib(src);
        const done: string[] = [];
        const catalog = doc.catalog;
        if (title.value.trim()) {
          doc.setTitle(title.value.trim(), { showInWindowTitleBar: displayTitle.input.checked });
          done.push('title');
        }
        const code = lang.value === 'other' ? otherLang.value.trim() : lang.value;
        if (code) {
          doc.setLanguage(code);
          done.push('language');
        }
        if (tabs.input.checked) {
          const tagged = !!catalog.get(PDFName.of('StructTreeRoot'));
          for (const p of doc.getPages()) if (p.node.Annots()?.size()) p.node.set(PDFName.of('Tabs'), PDFName.of(tagged ? 'S' : 'R'));
          done.push('tab order');
        }
        if (tooltips.input.checked) {
          let n = 0;
          for (const f of doc.getForm().getFields()) {
            if (f.acroField.dict.has(PDFName.of('TU'))) continue;
            f.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(humanize(f.getName())));
            n++;
          }
          if (n) done.push(`${n} field label${n === 1 ? '' : 's'}`);
        }
        if (bookmarks.input.checked && !catalog.get(PDFName.of('Outlines')) && doc.getPageCount()) {
          bookmarkEveryPage(doc);
          done.push('bookmarks');
        }
        if (ocr.input.checked && scanned.length) {
          const js = await loadJs(src);
          try {
            const res = await ocrDocument(doc, js, { pages: scanned, dpi: 200, skipText: true, progress });
            if (res.done) done.push(`text on ${res.done} scanned page${res.done === 1 ? '' : 's'}`);
          } finally {
            await js.loadingTask.destroy();
          }
        }
        return {
          files: [pdfOutput(`${baseName(src.name)}-accessible`, await doc.save())],
          note: done.length ? `Set ${done.join(', ')}.` : 'Nothing needed changing.',
        };
      },
    });
  },
};
