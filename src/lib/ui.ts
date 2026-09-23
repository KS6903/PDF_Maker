import { createElement, type IconNode } from 'lucide';

type Child = Node | string | number | null | undefined | false;
type Children = Child | Children[];
type Props = Record<string, unknown>;

/** Tiny hyperscript helper: h('div', { class: 'x', onclick }, child, ...) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Children[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (key === 'style') {
        el.setAttribute('style', String(value));
      } else if (key in el && typeof value !== 'string') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else if (key === 'value' || key === 'checked') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Children[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function icon(node: IconNode, size = 18): SVGElement {
  const svg = createElement(node);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

export function button(
  label: string | null,
  onClick: (e: MouseEvent) => void,
  opts: { icon?: IconNode; kind?: 'primary' | 'ghost' | 'danger' | 'default'; title?: string; disabled?: boolean } = {},
) {
  return h(
    'button',
    {
      type: 'button',
      class: `btn ${opts.kind ?? 'default'}${label ? '' : ' icon-only'}`,
      title: opts.title ?? label ?? undefined,
      // Visible text is the accessible name; only icon-only buttons need a label.
      'aria-label': label ? undefined : (opts.title ?? undefined),
      disabled: opts.disabled,
      onclick: onClick,
    },
    opts.icon ? icon(opts.icon, 16) : null,
    label ? h('span', null, label) : null,
  );
}

/* ---------- form fields ---------- */

export function field(label: string, control: HTMLElement, hint?: string) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('small', null, hint) : null);
}

export function select<T extends string>(options: [T, string][], value: T, onChange?: (v: T) => void) {
  const s = h('select', { onchange: () => onChange?.(s.value as T) }, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  return s;
}

export function numberInput(value: number, opts: { min?: number; max?: number; step?: number } = {}) {
  return h('input', { type: 'number', value: String(value), min: opts.min, max: opts.max, step: opts.step ?? 1 }) as HTMLInputElement;
}

export function textInput(value = '', placeholder = '', type = 'text') {
  return h('input', { type, value, placeholder }) as HTMLInputElement;
}

export function checkbox(label: string, checked = false) {
  const input = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
  const el = h('label', { class: 'check' }, input, h('span', null, label));
  return { el, input };
}

/* ---------- file drop zone ---------- */

export function dropzone(opts: {
  accept: string;
  multiple?: boolean;
  title: string;
  hint?: string;
  icon: IconNode;
  compact?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = h('input', {
    type: 'file',
    accept: opts.accept,
    multiple: opts.multiple ?? false,
    hidden: true,
    onchange: () => {
      if (input.files?.length) opts.onFiles([...input.files]);
      input.value = '';
    },
  }) as HTMLInputElement;
  const zone = h(
    'div',
    {
      class: `dropzone${opts.compact ? ' compact' : ''}`,
      tabindex: 0,
      role: 'button',
      onclick: () => input.click(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          input.click();
        }
      },
      ondragover: (e: DragEvent) => {
        e.preventDefault();
        zone.classList.add('over');
      },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        zone.classList.remove('over');
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) opts.onFiles(opts.multiple ? files : files.slice(0, 1));
      },
    },
    icon(opts.icon, opts.compact ? 20 : 32),
    h('strong', null, opts.title),
    opts.hint ? h('span', null, opts.hint) : null,
    input,
  );
  return zone;
}

/* ---------- toasts, busy overlay, dialogs ---------- */

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const t = h('div', { class: `toast ${kind}` }, message);
  host.append(t);
  setTimeout(() => t.classList.add('leaving'), kind === 'error' ? 6000 : 3500);
  setTimeout(() => t.remove(), kind === 'error' ? 6400 : 3900);
}

export async function withBusy<T>(message: string, fn: (progress: (text: string) => void) => Promise<T>): Promise<T | undefined> {
  const label = h('span', null, message);
  // Each call owns its overlay, so nested calls can't remove each other's.
  const busyEl = h('div', { class: 'busy' }, h('div', { class: 'busy-card' }, h('div', { class: 'spinner' }), label));
  document.body.append(busyEl);
  // Let the overlay paint before heavy synchronous work starts.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    return await fn((text) => (label.textContent = text));
  } catch (err) {
    console.error(err);
    toast(errorMessage(err), 'error');
    return undefined;
  } finally {
    busyEl.remove();
  }
}

export function errorMessage(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/encrypt/i.test(msg)) return 'This PDF is encrypted. Unlock it first with the Unlock tool.';
  if (/invalid pdf|failed to parse|no pdf header/i.test(msg)) return 'That file does not look like a valid PDF.';
  return msg || 'Something went wrong.';
}

export function modal(title: string, body: HTMLElement, actions: { label: string; kind?: 'primary' | 'default'; value: string }[]) {
  return new Promise<string | null>((resolve) => {
    const dlg = h('dialog', { class: 'modal' }) as HTMLDialogElement;
    const close = (v: string | null) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.append(
      h('h2', null, title),
      body,
      h(
        'div',
        { class: 'modal-actions' },
        actions.map((a) => button(a.label, () => close(a.value), { kind: a.kind ?? 'default' })),
      ),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector<HTMLElement>('input, textarea, select');
    first?.focus();
  });
}

export async function askPassword(fileName: string, retry: boolean): Promise<string | null> {
  const input = textInput('', 'Password', 'password');
  const body = h(
    'div',
    { class: 'stack' },
    h('p', null, retry ? `Wrong password for “${fileName}”. Try again.` : `“${fileName}” is password protected.`),
    input,
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (body.closest('dialog')?.querySelector('.btn.primary') as HTMLButtonElement)?.click();
  });
  const res = await modal('Enter password', body, [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Open', value: 'ok', kind: 'primary' },
  ]);
  return res === 'ok' ? input.value : null;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
