import { Braces, Plus, Trash2 } from 'lucide';
import { h, button, field, textInput, checkbox } from '../lib/ui';
import { loadLib, pdfOutput, baseName, pruneUnreachable } from '../lib/pdf';
import { findScripts, setDocumentScripts, setScriptCode, stripJavaScript } from '../lib/scripts';
import { simpleTool, panel, type Tool } from './common';

interface Draft {
  name: HTMLInputElement;
  code: HTMLTextAreaElement;
  removed: boolean;
}

function codeBox(value: string) {
  return h('textarea', { class: 'code-box', rows: Math.min(14, Math.max(4, value.split('\n').length + 1)), spellcheck: false, value }) as HTMLTextAreaElement;
}

export const javascriptTool: Tool = {
  id: 'javascript',
  title: 'Use JavaScript',
  blurb: 'See, edit, add or remove the scripts inside a PDF. Folio never runs them.',
  icon: Braces,
  group: 'Secure & info',
  acceptsPdf: true,
  mount(el, ctx) {
    let existing: { code: HTMLTextAreaElement; name?: HTMLInputElement; removed: boolean }[] = [];
    let added: Draft[] = [];
    const removeAll = checkbox('Remove all JavaScript from this file');

    simpleTool(el, ctx, {
      actionLabel: 'Save PDF',
      busyLabel: 'Saving…',
      options: async (src) => {
        const doc = await loadLib(src);
        const scripts = findScripts(doc);
        existing = [];
        added = [];
        removeAll.input.checked = false;

        const list = h('div', { class: 'stack' });
        scripts.forEach((s) => {
          const entry = { code: codeBox(s.code), name: s.name !== undefined ? textInput(s.name, 'Script name') : undefined, removed: false };
          existing.push(entry);
          const card: HTMLElement = h(
            'div',
            { class: 'script-card' },
            h(
              'div',
              { class: 'row between' },
              h('strong', null, s.label),
              button('Remove', () => {
                entry.removed = !entry.removed;
                card.classList.toggle('removed', entry.removed);
                (card.querySelector('.btn span') as HTMLElement).textContent = entry.removed ? 'Keep' : 'Remove';
              }, { icon: Trash2, kind: 'ghost' }),
            ),
            entry.name ? field('Name', entry.name) : null,
            entry.code,
          );
          list.append(card);
        });

        const addedList = h('div', { class: 'stack' });
        const addScript = () => {
          const draft: Draft = { name: textInput(`script${added.length + 1}`, 'Script name'), code: codeBox(''), removed: false };
          added.push(draft);
          const card: HTMLElement = h(
            'div',
            { class: 'script-card' },
            h('div', { class: 'row between' }, h('strong', null, 'New document script'), button(null, () => ((draft.removed = true), card.remove()), { icon: Trash2, kind: 'ghost', title: 'Discard this script' })),
            field('Name', draft.name),
            draft.code,
          );
          addedList.append(card);
          draft.code.focus();
        };

        removeAll.input.onchange = () => list.classList.toggle('removed', removeAll.input.checked);
        return h(
          'div',
          { class: 'stack' },
          panel(
            h(
              'p',
              null,
              scripts.length
                ? `This file has ${scripts.length} script${scripts.length === 1 ? '' : 's'}.`
                : 'This file has no JavaScript.',
            ),
            h('p', { class: 'muted small' }, 'Folio never runs these scripts. Readers such as Acrobat do, so only keep scripts you trust. Document scripts run when the file opens.'),
            scripts.length ? removeAll.el : null,
          ),
          scripts.length ? list : null,
          addedList,
          h('div', null, button('Add a document script', addScript, { icon: Plus })),
        );
      },
      run: async (src) => {
        const doc = await loadLib(src);
        let note: string;
        if (removeAll.input.checked) {
          const n = stripJavaScript(doc);
          pruneUnreachable(doc);
          note = `Removed ${n} script${n === 1 ? '' : 's'}.`;
        } else {
          const scripts = findScripts(doc);
          const docScripts: { name: string; code: string }[] = [];
          let changed = 0;
          scripts.forEach((s, i) => {
            const e = existing[i];
            if (!e) return;
            if (s.name !== undefined) {
              if (!e.removed) docScripts.push({ name: e.name?.value.trim() || s.name, code: e.code.value });
              else changed++;
              return;
            }
            if (e.removed) {
              s.remove();
              changed++;
            } else if (e.code.value !== s.code) {
              setScriptCode(s.action, e.code.value);
              changed++;
            }
          });
          for (const d of added.filter((d) => !d.removed && d.code.value.trim())) docScripts.push({ name: d.name.value.trim() || 'script', code: d.code.value });
          const before = scripts.filter((s) => s.name !== undefined);
          const docChanged =
            docScripts.length !== before.length || docScripts.some((d, i) => d.name !== before[i]?.name || d.code !== before[i]?.code);
          if (docChanged) setDocumentScripts(doc, docScripts);
          note = changed || docChanged ? 'Scripts saved.' : 'Nothing was changed, so this is the same file.';
          pruneUnreachable(doc);
        }
        return { files: [pdfOutput(`${baseName(src.name)}-scripts`, await doc.save())], note };
      },
    });
  },
};
