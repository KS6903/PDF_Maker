import { BadgeCheck, KeyRound, CircleCheck, CircleX, Info, Trash2 } from 'lucide';
import { h, icon, button, field, select, textInput, numberInput, checkbox, modal, withBusy, toast } from '../lib/ui';
import { pdfOutput, baseName, download } from '../lib/pdf';
import { readPfx, createDigitalId, signPdf, listSignatures, type SignatureInfo } from '../lib/sign';
import { simpleTool, panel, type Tool } from './common';

/** Digital IDs remembered on this computer: their .pfx files, still locked by their own passwords. */
interface StoredId {
  id: string;
  name: string;
  pfx: string;
}

const STORE_KEY = 'folio.digitalIds';

function storedIds(): StoredId[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function storeIds(list: StoredId[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    toast('Could not remember the digital ID on this computer.', 'error');
  }
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function signatureRow(s: SignatureInfo) {
  const [tone, glyph, headline] =
    s.intact === false ? ['bad', CircleX, 'Changed since it was signed']
    : s.genuine === false ? ['bad', CircleX, 'Signature doesn’t match the signer’s certificate']
    : s.intact && s.genuine ? ['ok', CircleCheck, 'Valid, and unchanged since signing']
    : ['info', Info, s.note ?? 'Could not be fully checked'];
  const details = [
    s.signedAt ? `Signed ${s.signedAt.toLocaleString()}` : null,
    s.reason ? `Reason: ${s.reason}` : null,
    s.selfSigned ? 'Self-signed: no authority vouches for who the signer is.' : s.issuer ? `Certificate issued by ${s.issuer}. Folio doesn’t check certificate authorities.` : null,
    s.intact && !s.coversWholeFile ? 'Changes were added to the file after this signature.' : null,
  ].filter(Boolean);
  return h(
    'li',
    { class: tone },
    icon(glyph, 16),
    h('div', null, h('strong', null, `${s.signer}`), h('span', null, ` · ${headline}`), details.length ? h('small', { class: 'muted' }, details.join(' ')) : null),
  );
}

export const certificateTool: Tool = {
  id: 'certificate',
  title: 'Use a certificate',
  blurb: 'Sign a PDF with a digital ID, and check the signatures already in it.',
  icon: BadgeCheck,
  group: 'Edit & sign',
  acceptsPdf: true,
  mount(el, ctx) {
    let ids = storedIds();
    let loaded: { name: string; bytes: Uint8Array } | null = null;

    const idPick = h('select', { 'aria-label': 'Digital ID' }) as HTMLSelectElement;
    const password = textInput('', 'Password for the digital ID', 'password');
    const remember = checkbox('Remember this digital ID on this computer', true);
    const reason = select<string>(
      [
        ['I am the author of this document', 'I am the author of this document'],
        ['I approve this document', 'I approve this document'],
        ['I have reviewed this document', 'I have reviewed this document'],
        ['I agree to the terms of this document', 'I agree to the terms of this document'],
        ['', 'No reason'],
      ],
      'I approve this document',
    );
    const location = textInput('', 'Optional, e.g. London');
    const contact = textInput('', 'Optional, e.g. an email address');
    const visible = checkbox('Show a signature box on the page', true);
    const page = numberInput(1, { min: 1 });
    const corner = select<'bl' | 'br' | 'tl' | 'tr'>(
      [
        ['br', 'Bottom right'],
        ['bl', 'Bottom left'],
        ['tr', 'Top right'],
        ['tl', 'Top left'],
      ],
      'br',
    );
    const forget = button('Forget', () => {
      ids = ids.filter((i) => i.id !== idPick.value);
      storeIds(ids);
      paintIds();
    }, { icon: Trash2, kind: 'ghost', title: 'Forget this digital ID' });

    const fileInput = h('input', {
      type: 'file',
      accept: '.pfx,.p12,application/x-pkcs12',
      hidden: true,
      onchange: async () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (!f) return paintIds();
        loaded = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
        paintIds('file');
        password.focus();
      },
    }) as HTMLInputElement;

    function paintIds(select?: string) {
      const keep = select ?? idPick.value;
      idPick.replaceChildren(
        // A neutral first choice, so picking "Load…" always registers as a change.
        ...(ids.length || loaded ? [] : [h('option', { value: '' }, 'Choose a digital ID…')]),
        ...ids.map((i) => h('option', { value: i.id }, i.name)),
        ...(loaded ? [h('option', { value: 'file' }, `${loaded.name} (loaded)`)] : []),
        h('option', { value: 'load' }, 'Load a .pfx or .p12 file…'),
        h('option', { value: 'new' }, 'Create a new digital ID…'),
      );
      const usable = (v: string) => v !== 'load' && v !== 'new' && [...idPick.options].some((o) => o.value === v);
      idPick.value = usable(keep) ? keep : ids[0]?.id ?? (loaded ? 'file' : '');
      remember.el.hidden = idPick.value !== 'file';
      forget.hidden = !ids.some((i) => i.id === idPick.value);
    }
    idPick.addEventListener('change', () => {
      if (idPick.value === 'load') {
        fileInput.click();
        // Step back at once: a cancelled picker sends no event, and the choice must stay pickable.
        paintIds();
      }
      else if (idPick.value === 'new') void createId();
      else paintIds();
    });

    async function createId() {
      const name = textInput('', 'Your full name');
      const email = textInput('', 'Optional', 'email');
      const org = textInput('', 'Optional');
      const pw = textInput('', 'At least 6 characters', 'password');
      const pw2 = textInput('', 'Repeat password', 'password');
      const years = select<string>([['1', '1 year'], ['3', '3 years'], ['5', '5 years'], ['10', '10 years']], '5');
      const body = h(
        'div',
        { class: 'stack' },
        h('p', { class: 'muted small' }, 'A self-signed digital ID. Readers show your signatures as made by this ID, but only people who choose to trust it see you as verified.'),
        h('div', { class: 'grid' }, field('Name', name), field('Email', email), field('Organization', org), field('Valid for', years), field('Password', pw), field('Confirm password', pw2)),
      );
      const res = await modal('Create a digital ID', body, [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Create', value: 'ok', kind: 'primary' },
      ], { icon: KeyRound });
      if (res !== 'ok') return paintIds();
      if (!name.value.trim()) return (toast('Enter your name.', 'error'), paintIds());
      if (pw.value.length < 6) return (toast('Use a password of at least 6 characters.', 'error'), paintIds());
      if (pw.value !== pw2.value) return (toast('The passwords don’t match.', 'error'), paintIds());
      const made = await withBusy('Creating digital ID…', () =>
        createDigitalId({ name: name.value.trim(), email: email.value.trim() || undefined, organization: org.value.trim() || undefined, password: pw.value, years: +years.value }),
      );
      if (!made) return paintIds();
      const stored: StoredId = { id: `id${Date.now()}`, name: made.id.name, pfx: toBase64(made.pfx) };
      ids.push(stored);
      storeIds(ids);
      paintIds(stored.id);
      password.value = pw.value;
      download({ name: `${made.id.name} digital ID.pfx`, data: made.pfx, type: 'application/x-pkcs12' });
      toast('Digital ID created. A backup copy (.pfx) was saved too; keep it and its password safe.', 'success');
    }

    simpleTool(el, ctx, {
      actionLabel: 'Sign PDF',
      actionIcon: BadgeCheck,
      busyLabel: 'Signing…',
      options: async (src) => {
        const existing = await listSignatures(src);
        page.max = String(src.pageCount);
        page.value = String(src.pageCount);
        paintIds();
        const posRow = h('div', { class: 'grid' }, field('Page', page), field('Corner', corner));
        visible.input.onchange = () => (posRow.hidden = !visible.input.checked);
        return h(
          'div',
          { class: 'stack' },
          existing.length
            ? panel(h('h3', null, `Signatures in this file (${existing.length})`), h('ul', { class: 'sig-status' }, existing.map(signatureRow)))
            : null,
          panel(
            h('h3', null, 'Digital ID'),
            h('div', { class: 'row' }, h('div', { class: 'grow' }, idPick), forget, fileInput),
            field('Password', password),
            remember.el,
            h('p', { class: 'muted small' }, 'IDs from Windows: open certmgr, export your certificate with its private key as a .pfx file, and load it here.'),
          ),
          panel(h('h3', null, 'Details'), h('div', { class: 'grid' }, field('Reason', reason), field('Location', location), field('Contact', contact))),
          panel(h('h3', null, 'Appearance'), visible.el, posRow),
        );
      },
      run: async (src) => {
        const choice = idPick.value;
        const stored = ids.find((i) => i.id === choice);
        const bytes = stored ? fromBase64(stored.pfx) : choice === 'file' && loaded ? loaded.bytes : null;
        if (!bytes) throw new Error('Choose a digital ID to sign with.');
        const id = readPfx(bytes, password.value);
        const out = await signPdf(src, id, {
          reason: reason.value || undefined,
          location: location.value.trim() || undefined,
          contact: contact.value.trim() || undefined,
          visible: visible.input.checked ? { page: +page.value || 1, corner: corner.value as 'bl' | 'br' | 'tl' | 'tr' } : undefined,
        });
        if (choice === 'file' && loaded && remember.input.checked && !ids.some((i) => i.name === id.name && i.pfx === toBase64(loaded!.bytes))) {
          const entry: StoredId = { id: `id${Date.now()}`, name: id.name, pfx: toBase64(loaded.bytes) };
          ids.push(entry);
          storeIds(ids);
          loaded = null;
          paintIds(entry.id);
        }
        return {
          files: [pdfOutput(`${baseName(src.name)}-signed`, out)],
          note: `Signed by ${id.name}. Any later change to the file shows up as a broken signature.`,
        };
      },
    });
    paintIds();
  },
};
