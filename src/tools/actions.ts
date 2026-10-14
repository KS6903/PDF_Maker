import { Workflow, Plus, Trash2, ArrowUp, ArrowDown, Play, Save, FileText, X } from 'lucide';
import { PDFName, degrees, type PDFDocument } from '@cantoo/pdf-lib';
import { h, button, field, select, textInput, numberInput, dropzone, icon, withBusy, toast, formatBytes } from '../lib/ui';
import { openPdf, loadLib, loadJs, pdfOutput, baseName, pruneUnreachable, type OutputFile, type PdfSource } from '../lib/pdf';
import { ocrDocument } from '../lib/ocr';
import { stripJavaScript } from '../lib/scripts';
import { convertToPdfA } from '../lib/pdfa';
import { addWatermark, type WatermarkLayout } from './watermark';
import { addPageNumbers, type NumberPosition } from './pagenumbers';
import { compressPdf } from './compress';
import { resultsPanel, panel, type Tool } from './common';

type StepType =
  | 'ocr'
  | 'watermark'
  | 'page-numbers'
  | 'rotate'
  | 'flatten-forms'
  | 'remove-javascript'
  | 'strip-metadata'
  | 'properties'
  | 'pdfa'
  | 'compress'
  | 'protect';

interface Step {
  type: StepType;
  opts: Record<string, string>;
}

interface Action {
  id: string;
  name: string;
  steps: Step[];
  builtIn?: boolean;
}

interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'password' | 'color';
  value: string;
  options?: [string, string][];
}

interface StepSpec {
  label: string;
  fields: FieldSpec[];
  /** Turns one version of the file into the next. */
  run(src: PdfSource, o: Record<string, string>, progress: (t: string) => void): Promise<Uint8Array>;
}

async function edit(src: PdfSource, fn: (doc: PDFDocument) => void | Promise<void>) {
  const doc = await loadLib(src);
  await fn(doc);
  return doc.save();
}

const STEPS: Record<StepType, StepSpec> = {
  ocr: {
    label: 'Recognize text (OCR)',
    fields: [{ key: 'dpi', label: 'Detail', type: 'select', value: '200', options: [['150', 'Fast'], ['200', 'Standard'], ['300', 'Fine print']] }],
    async run(src, o, progress) {
      const doc = await loadLib(src);
      const js = await loadJs(src);
      try {
        await ocrDocument(doc, js, { pages: doc.getPageIndices(), dpi: +o.dpi || 200, skipText: true, progress });
      } finally {
        await js.loadingTask.destroy();
      }
      return doc.save();
    },
  },
  watermark: {
    label: 'Add a watermark',
    fields: [
      { key: 'text', label: 'Text', type: 'text', value: 'CONFIDENTIAL' },
      { key: 'layout', label: 'Placement', type: 'select', value: 'center', options: [['center', 'Centered'], ['tile', 'Tiled'], ['top', 'Top'], ['bottom', 'Bottom']] },
      { key: 'color', label: 'Colour', type: 'color', value: '#d23a2a' },
      { key: 'opacity', label: 'Opacity (%)', type: 'number', value: '25' },
    ],
    run: (src, o) =>
      edit(src, (doc) =>
        addWatermark(doc, { text: o.text, family: 'helvetica', size: 64, color: o.color, opacity: +o.opacity || 25, rotation: 45, layout: o.layout as WatermarkLayout, pages: '' }),
      ),
  },
  'page-numbers': {
    label: 'Add page numbers',
    fields: [
      { key: 'format', label: 'Text', type: 'text', value: 'Page {n} of {total}' },
      { key: 'position', label: 'Position', type: 'select', value: 'bc', options: [['bc', 'Bottom center'], ['br', 'Bottom right'], ['bl', 'Bottom left'], ['tc', 'Top center'], ['tr', 'Top right'], ['tl', 'Top left']] },
    ],
    run: (src, o) =>
      edit(src, (doc) =>
        addPageNumbers(doc, { format: o.format, position: o.position as NumberPosition, start: 1, size: 10, margin: 28, family: 'helvetica', color: '#333333', pages: '' }),
      ),
  },
  rotate: {
    label: 'Rotate pages',
    fields: [{ key: 'angle', label: 'Turn', type: 'select', value: '90', options: [['90', 'Right (90°)'], ['180', 'Upside down'], ['270', 'Left (90°)']] }],
    run: (src, o) =>
      edit(src, (doc) => {
        for (const p of doc.getPages()) p.setRotation(degrees((p.getRotation().angle + (+o.angle || 0)) % 360));
      }),
  },
  'flatten-forms': {
    label: 'Flatten form fields',
    fields: [],
    run: (src) => edit(src, (doc) => doc.getForm().flatten()),
  },
  'remove-javascript': {
    label: 'Remove JavaScript',
    fields: [],
    run: (src) =>
      edit(src, (doc) => {
        stripJavaScript(doc);
        pruneUnreachable(doc);
      }),
  },
  'strip-metadata': {
    label: 'Remove hidden metadata',
    fields: [],
    run: (src) =>
      edit(src, (doc) => {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        doc.setCreator('');
        doc.setProducer('');
        doc.catalog.delete(PDFName.of('Metadata'));
      }),
  },
  properties: {
    label: 'Set document properties',
    fields: [
      { key: 'author', label: 'Author', type: 'text', value: '' },
      { key: 'subject', label: 'Subject', type: 'text', value: '' },
    ],
    run: (src, o) =>
      edit(src, (doc) => {
        if (o.author) doc.setAuthor(o.author);
        if (o.subject) doc.setSubject(o.subject);
      }),
  },
  pdfa: {
    label: 'Convert to PDF/A (archiving)',
    fields: [],
    run: async (src, _o, progress) => (await convertToPdfA(src, { mode: 'auto' }, progress)).bytes,
  },
  compress: {
    label: 'Compress',
    fields: [{ key: 'mode', label: 'Compression', type: 'select', value: 'lossless', options: [['lossless', 'Lossless'], ['balanced', 'Balanced'], ['strong', 'Strong']] }],
    run: (src, o, progress) => compressPdf(src, (o.mode as 'lossless' | 'balanced' | 'strong') || 'lossless', progress),
  },
  protect: {
    label: 'Protect with a password',
    fields: [{ key: 'password', label: 'Password', type: 'password', value: '' }],
    run: (src, o) =>
      edit(src, (doc) => {
        if (!o.password) throw new Error('The password step has no password.');
        doc.encrypt({ userPassword: o.password, ownerPassword: o.password, permissions: { printing: 'highResolution', copying: false, modifying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false } });
      }),
  },
};

const STEP_ORDER = Object.keys(STEPS) as StepType[];

function defaults(type: StepType): Step {
  return { type, opts: Object.fromEntries(STEPS[type].fields.map((f) => [f.key, f.value])) };
}

const BUILT_IN: Action[] = [
  { id: 'share', name: 'Prepare for sharing', builtIn: true, steps: [defaults('remove-javascript'), defaults('strip-metadata'), defaults('flatten-forms'), defaults('compress')] },
  { id: 'searchable', name: 'Make scans searchable', builtIn: true, steps: [defaults('ocr'), defaults('compress')] },
  { id: 'draft', name: 'Mark as draft', builtIn: true, steps: [{ type: 'watermark', opts: { ...defaults('watermark').opts, text: 'DRAFT' } }, defaults('page-numbers')] },
  { id: 'archive', name: 'Archive', builtIn: true, steps: [defaults('remove-javascript'), defaults('pdfa')] },
];

const STORE_KEY = 'folio.guidedActions';

function loadSaved(): Action[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as Action[];
    return Array.isArray(list) ? list.filter((a) => a && Array.isArray(a.steps) && a.steps.every((s) => s.type in STEPS)) : [];
  } catch {
    return [];
  }
}

function storeSaved(list: Action[]) {
  try {
    // Passwords are never written to disk; the step asks again next time.
    const clean = list.map((a) => ({ ...a, steps: a.steps.map((s) => (s.type === 'protect' ? { ...s, opts: { password: '' } } : s)) }));
    localStorage.setItem(STORE_KEY, JSON.stringify(clean));
  } catch {
    toast('Could not save the action on this computer.', 'error');
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'done';
}

export const actionsTool: Tool = {
  id: 'actions',
  title: 'Use guided actions',
  blurb: 'Run a saved sequence of tools over a batch of files in one go.',
  icon: Workflow,
  group: 'Organize',
  acceptsPdf: true,
  mount(el, ctx) {
    let saved = loadSaved();
    let current: Action = structuredClone(BUILT_IN[0]);
    let files: File[] = [];
    const results = resultsPanel(ctx);

    const picker = h('select', { 'aria-label': 'Action' }) as HTMLSelectElement;
    const name = textInput('', 'Action name');
    const stepsEl = h('div', { class: 'stack' });
    const filesEl = h('div', { class: 'file-list' });

    function all() {
      return [...BUILT_IN, ...saved];
    }

    function paintPicker() {
      picker.replaceChildren(
        h('optgroup', { label: 'Built in' }, BUILT_IN.map((a) => h('option', { value: a.id }, a.name))),
        ...(saved.length ? [h('optgroup', { label: 'Saved' }, saved.map((a) => h('option', { value: a.id }, a.name)))] : []),
      );
      picker.value = current.id;
    }
    picker.addEventListener('change', () => {
      const found = all().find((a) => a.id === picker.value);
      if (found) current = structuredClone(found);
      paint();
    });

    function control(f: FieldSpec, step: Step) {
      const value = step.opts[f.key] ?? f.value;
      let c: HTMLInputElement | HTMLSelectElement;
      if (f.type === 'select') c = select<string>(f.options ?? [], value);
      else if (f.type === 'number') c = numberInput(+value || 0);
      else if (f.type === 'color') c = h('input', { type: 'color', value }) as HTMLInputElement;
      else c = textInput(value, '', f.type === 'password' ? 'password' : 'text');
      c.addEventListener('input', () => (step.opts[f.key] = c.value));
      c.addEventListener('change', () => (step.opts[f.key] = c.value));
      return field(f.label, c);
    }

    function paint() {
      name.value = current.name;
      paintPicker();
      stepsEl.replaceChildren(
        ...current.steps.map((step, i) => {
          const spec = STEPS[step.type];
          const move = (d: number) => {
            const j = i + d;
            if (j < 0 || j >= current.steps.length) return;
            [current.steps[i], current.steps[j]] = [current.steps[j], current.steps[i]];
            paint();
          };
          return h(
            'div',
            { class: 'step-card' },
            h(
              'div',
              { class: 'step-head' },
              h('span', { class: 'step-num' }, String(i + 1)),
              h('strong', null, spec.label),
              h('span', { class: 'spacer' }),
              button(null, () => move(-1), { icon: ArrowUp, kind: 'ghost', title: 'Move up', disabled: i === 0 }),
              button(null, () => move(1), { icon: ArrowDown, kind: 'ghost', title: 'Move down', disabled: i === current.steps.length - 1 }),
              button(null, () => (current.steps.splice(i, 1), paint()), { icon: Trash2, kind: 'ghost', title: 'Remove step' }),
            ),
            spec.fields.length ? h('div', { class: 'grid' }, spec.fields.map((f) => control(f, step))) : null,
          );
        }),
        ...(current.steps.length ? [] : [h('p', { class: 'muted' }, 'No steps yet. Add one below.')]),
      );
    }

    const adder = select<string>([['', 'Add a step…'], ...STEP_ORDER.map((t): [string, string] => [t, STEPS[t].label])], '', (t) => {
      if (!t) return;
      current.steps.push(defaults(t as StepType));
      adder.value = '';
      paint();
    });

    function saveAction() {
      const label = name.value.trim() || 'My action';
      if (!current.steps.length) return toast('Add at least one step first.', 'info');
      if (current.builtIn || !saved.some((a) => a.id === current.id)) {
        current = { ...structuredClone(current), id: `a${Date.now()}`, name: label, builtIn: undefined };
        saved.push(structuredClone(current));
      } else {
        current.name = label;
        saved = saved.map((a) => (a.id === current.id ? structuredClone(current) : a));
      }
      storeSaved(saved);
      paint();
      toast(`Saved “${label}”.`, 'success');
    }

    function deleteAction() {
      if (current.builtIn) return toast('Built-in actions can’t be deleted.', 'info');
      saved = saved.filter((a) => a.id !== current.id);
      storeSaved(saved);
      current = structuredClone(BUILT_IN[0]);
      paint();
    }

    function paintFiles() {
      filesEl.replaceChildren(
        ...files.map((f, i) =>
          h(
            'div',
            { class: 'file-chip' },
            icon(FileText, 20),
            h('div', null, h('strong', null, f.name), h('span', null, formatBytes(f.size))),
            button(null, () => (files.splice(i, 1), paintFiles()), { icon: X, kind: 'ghost', title: 'Remove file' }),
          ),
        ),
      );
    }

    async function run() {
      if (!current.steps.length) return toast('Add at least one step first.', 'info');
      if (!files.length) return toast('Choose the PDFs to run this action on.', 'info');
      const protect = current.steps.find((s) => s.type === 'protect');
      if (protect && !protect.opts.password) return toast('Enter the password for the “Protect with a password” step.', 'info');
      results.hide();
      const action = structuredClone(current);
      const failed: string[] = [];
      const outputs = await withBusy('Running…', async (progress) => {
        const out: OutputFile[] = [];
        for (const [fi, file] of files.entries()) {
          const first = await openPdf(file);
          if (!first) {
            failed.push(file.name);
            continue;
          }
          let src: PdfSource = first;
          try {
            for (const [si, step] of action.steps.entries()) {
              const prefix = `${file.name} (${fi + 1}/${files.length}) · step ${si + 1}: ${STEPS[step.type].label}`;
              progress(prefix);
              const bytes = await STEPS[step.type].run(src, step.opts, (t) => progress(`${prefix} · ${t}`));
              src = { name: src.name, bytes, password: step.type === 'protect' ? step.opts.password : src.password, pageCount: src.pageCount };
            }
            out.push(pdfOutput(`${baseName(file.name)}-${slug(action.name)}`, src.bytes));
          } catch (err) {
            console.error(err);
            failed.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return out;
      });
      if (!outputs) return;
      if (failed.length) toast(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be processed: ${failed.join('; ')}`, 'error');
      if (outputs.length) results.show(outputs, `Ran “${action.name}” (${action.steps.length} step${action.steps.length === 1 ? '' : 's'}) on ${outputs.length} file${outputs.length === 1 ? '' : 's'}.`);
    }

    const zone = dropzone({
      accept: 'application/pdf,.pdf',
      multiple: true,
      compact: true,
      title: 'Choose PDFs or drop them here',
      hint: 'The action runs on each file in turn',
      icon: FileText,
      onFiles: (list) => {
        files.push(...list.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf'));
        paintFiles();
      },
    });
    const handed = ctx.takeIncomingFiles();
    if (handed?.length) files.push(...handed);
    const incoming = ctx.takeIncoming();
    if (incoming) files.push(new File([incoming.bytes as BlobPart], incoming.name, { type: 'application/pdf' }));

    el.append(
      panel(
        h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Action', picker)), button('New action', () => ((current = { id: `a${Date.now()}`, name: 'My action', steps: [] }), paint()), { icon: Plus }), button('Delete', deleteAction, { icon: Trash2, kind: 'ghost' })),
      ),
      panel(field('Name', name), stepsEl, h('div', { class: 'row' }, adder, button('Save action', saveAction, { icon: Save }))),
      panel(h('h3', null, 'Files'), zone, filesEl),
      h('div', { class: 'actions' }, button('Run action', () => void run(), { icon: Play, kind: 'primary' })),
      results.el,
    );
    paint();
    paintFiles();
  },
};
