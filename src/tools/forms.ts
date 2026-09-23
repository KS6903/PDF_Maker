import { ClipboardList } from 'lucide';
import { PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList, type PDFField } from '@cantoo/pdf-lib';
import { h, checkbox, field } from '../lib/ui';
import { loadLib, pdfOutput, baseName } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';
import { rememberEntry, suggestEntries } from '../lib/autofill';
import { normalizeLabel } from '../lib/detect';

type Getter = () => void; // applies the UI value to the pdf-lib field of a freshly loaded doc

export const formsTool: Tool = {
  id: 'fill-forms',
  title: 'Fill forms',
  blurb: 'Fill in PDF form fields, then optionally lock them in place.',
  icon: ClipboardList,
  group: 'Edit & sign',
  acceptsPdf: true,
  mount(el, ctx) {
    let values = new Map<string, () => string | boolean | string[]>();
    const flatten = checkbox('Flatten (make the answers permanent and non-editable)');

    simpleTool(el, ctx, {
      actionLabel: 'Save filled PDF',
      busyLabel: 'Saving form…',
      options: async (src) => {
        values = new Map();
        const doc = await loadLib(src);
        const fields = doc.getForm().getFields();
        if (!fields.length) {
          return panel(
            h('p', null, 'This PDF has no fillable form fields.'),
            h('p', { class: 'muted' }, 'To type onto a regular PDF, use the Edit & sign tool and add text boxes wherever you need them.'),
          );
        }
        const controls = fields.map((f) => control(f)).filter((c): c is HTMLElement => !!c);
        return panel(h('div', { class: 'grid' }, controls), flatten.el);
      },
      run: async (src) => {
        const doc = await loadLib(src);
        const form = doc.getForm();
        const apply: Getter[] = [];
        for (const f of form.getFields()) {
          const get = values.get(f.getName());
          if (!get) continue;
          const v = get();
          apply.push(() => {
            if (f instanceof PDFTextField) f.setText(String(v) || undefined);
            else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck());
            else if (f instanceof PDFDropdown) (v ? f.select(String(v)) : f.clear());
            else if (f instanceof PDFRadioGroup) (v ? f.select(String(v)) : f.clear());
            else if (f instanceof PDFOptionList) f.select(v as string[]);
          });
        }
        apply.forEach((a) => a());
        if (flatten.input.checked) form.flatten();
        return [pdfOutput(`${baseName(src.name)}-filled`, await doc.save())];
      },
    });

    function control(f: PDFField): HTMLElement | null {
      const name = f.getName();
      const label = name.split('.').pop() || name;
      if (f instanceof PDFTextField) {
        const multi = f.isMultiline();
        const input = h(multi ? 'textarea' : 'input', { value: f.getText() ?? '', maxlength: f.getMaxLength() ?? undefined }) as HTMLInputElement;
        if (f.isReadOnly()) input.disabled = true;
        // Offer entries remembered on this computer (name, email, address…).
        const key = normalizeLabel(label);
        let list: HTMLDataListElement | null = null;
        if (!multi) {
          const id = `af-${Math.random().toString(36).slice(2)}`;
          list = h('datalist', { id }, suggestEntries('', key, 12).map((e) => h('option', { value: e.value })));
          input.setAttribute('list', id);
        }
        values.set(name, () => {
          if (input.value.trim()) rememberEntry(input.value, key);
          return input.value;
        });
        return h('div', null, field(label, input), list);
      }
      if (f instanceof PDFCheckBox) {
        const c = checkbox(label, f.isChecked());
        values.set(name, () => c.input.checked);
        return h('div', { class: 'field' }, c.el);
      }
      if (f instanceof PDFDropdown || f instanceof PDFRadioGroup) {
        const opts = f.getOptions();
        const current = f instanceof PDFDropdown ? f.getSelected()[0] : f.getSelected();
        const s = h('select', null, h('option', { value: '' }, '—'), opts.map((o) => h('option', { value: o }, o))) as HTMLSelectElement;
        s.value = current ?? '';
        values.set(name, () => s.value);
        return field(label, s);
      }
      if (f instanceof PDFOptionList) {
        const s = h('select', { multiple: true }, f.getOptions().map((o) => h('option', { value: o }, o))) as HTMLSelectElement;
        const sel = new Set(f.getSelected());
        [...s.options].forEach((o) => (o.selected = sel.has(o.value)));
        values.set(name, () => [...s.selectedOptions].map((o) => o.value));
        return field(label, s);
      }
      return null;
    }
  },
};
