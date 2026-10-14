import { Wrench, ArrowUp, ArrowDown, Save, Trash2 } from 'lucide';
import { h, icon, button, field, textInput, toast } from '../lib/ui';
import { CATALOG, entryHash } from '../lib/catalog';
import { getCustomTab, setCustomTab } from '../lib/customtools';
import { panel, type Tool } from './common';

export const customTool: Tool = {
  id: 'custom-tool',
  title: 'Create custom tool',
  blurb: 'Put the tools you use most in a toolbar tab of your own.',
  icon: Wrench,
  group: 'Organize',
  mount(el) {
    const existing = getCustomTab();
    const name = textInput(existing?.name ?? 'My tools', 'Tab name');
    // Each tool once, in catalog order; the custom tool itself is left out.
    const choices = CATALOG.filter((e, i, all) => entryHash(e) && e.tool !== 'custom-tool' && all.findIndex((o) => o.label === e.label) === i);
    let picked: string[] = existing?.labels.filter((l) => choices.some((c) => c.label === l)) ?? [];

    const pickedEl = h('div', { class: 'stack' });
    const choiceEl = h('div', { class: 'choice-grid' });

    function paint() {
      choiceEl.replaceChildren(
        ...choices.map((e) => {
          const on = picked.includes(e.label);
          return h(
            'label',
            { class: `choice${on ? ' on' : ''}` },
            h('input', {
              type: 'checkbox',
              checked: on,
              onchange: () => {
                picked = on ? picked.filter((l) => l !== e.label) : [...picked, e.label];
                paint();
              },
            }),
            h('span', { class: 'tool-icon', style: `--c:${e.color}` }, icon(e.icon, 16)),
            h('span', null, e.label),
          );
        }),
      );
      pickedEl.replaceChildren(
        ...(picked.length
          ? picked.map((label, i) =>
              h(
                'div',
                { class: 'pick-row' },
                h('span', { class: 'step-num' }, String(i + 1)),
                h('span', { class: 'grow' }, label),
                button(null, () => move(i, -1), { icon: ArrowUp, kind: 'ghost', title: 'Move up', disabled: i === 0 }),
                button(null, () => move(i, 1), { icon: ArrowDown, kind: 'ghost', title: 'Move down', disabled: i === picked.length - 1 }),
              ),
            )
          : [h('p', { class: 'muted small' }, 'Tick the tools you want below.')]),
      );
    }
    function move(i: number, d: number) {
      const j = i + d;
      [picked[i], picked[j]] = [picked[j], picked[i]];
      paint();
    }

    el.append(
      panel(
        field('Tab name', name, 'Shown in the toolbar next to Edit, Convert and E-Sign'),
        h('h3', null, 'Order'),
        pickedEl,
        h(
          'div',
          { class: 'row' },
          button('Save tab', () => {
            if (!picked.length) return toast('Pick at least one tool.', 'info');
            setCustomTab({ name: name.value.trim() || 'My tools', labels: picked });
            toast(`“${name.value.trim() || 'My tools'}” is now in the toolbar.`, 'success');
          }, { icon: Save, kind: 'primary' }),
          button('Remove tab', () => {
            setCustomTab(null);
            picked = [];
            paint();
            toast('Removed your tab from the toolbar.', 'success');
          }, { icon: Trash2, kind: 'ghost' }),
        ),
      ),
      panel(h('h3', null, 'Tools'), choiceEl),
    );
    paint();
  },
};
