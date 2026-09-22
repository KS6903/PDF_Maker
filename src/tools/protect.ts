import { Lock, LockOpen } from 'lucide';
import { h, field, textInput, checkbox, toast } from '../lib/ui';
import { loadLib, pdfOutput, baseName } from '../lib/pdf';
import { simpleTool, panel, type Tool } from './common';

export const protectTool: Tool = {
  id: 'protect',
  title: 'Protect with password',
  blurb: 'Encrypt a PDF (AES-256) and control printing and copying.',
  icon: Lock,
  group: 'Secure & info',
  acceptsPdf: true,
  mount(el, ctx) {
    const pw = textInput('', 'Password to open the file', 'password');
    const pw2 = textInput('', 'Repeat password', 'password');
    const owner = textInput('', 'Optional — defaults to the open password', 'password');
    const print = checkbox('Allow printing', true);
    const copy = checkbox('Allow copying text and images', false);
    const modify = checkbox('Allow editing', false);
    const annotate = checkbox('Allow comments & form filling', true);

    simpleTool(el, ctx, {
      actionLabel: 'Encrypt PDF',
      actionIcon: Lock,
      busyLabel: 'Encrypting…',
      options: () =>
        panel(
          h('div', { class: 'grid' }, field('Password', pw), field('Confirm password', pw2)),
          field('Owner password (for changing permissions)', owner),
          h('div', { class: 'checks' }, print.el, copy.el, modify.el, annotate.el),
        ),
      run: async (src) => {
        if (!pw.value) throw new Error('Enter a password.');
        if (pw.value !== pw2.value) throw new Error('The passwords don’t match.');
        const doc = await loadLib(src);
        doc.encrypt({
          userPassword: pw.value,
          ownerPassword: owner.value || pw.value,
          permissions: {
            printing: print.input.checked ? 'highResolution' : false,
            copying: copy.input.checked,
            modifying: modify.input.checked,
            annotating: annotate.input.checked,
            fillingForms: annotate.input.checked,
            contentAccessibility: true,
            documentAssembly: modify.input.checked,
          },
        });
        const out = await doc.save();
        toast('Encrypted. Keep your password safe — it can’t be recovered.', 'success');
        return [pdfOutput(`${baseName(src.name)}-protected`, out)];
      },
    });
  },
};

export const unlockTool: Tool = {
  id: 'unlock',
  title: 'Remove password',
  blurb: 'Save an unlocked copy of a PDF you have the password for.',
  icon: LockOpen,
  group: 'Secure & info',
  acceptsPdf: true,
  mount(el, ctx) {
    simpleTool(el, ctx, {
      actionLabel: 'Remove protection',
      actionIcon: LockOpen,
      busyLabel: 'Decrypting…',
      options: (src) =>
        panel(
          h(
            'p',
            null,
            src.password
              ? 'Password accepted. The unlocked copy will open without a password and without restrictions.'
              : 'This file opens without a password. Any owner restrictions (printing, copying, editing) will be removed.',
          ),
        ),
      run: async (src) => {
        const doc = await loadLib(src);
        return [pdfOutput(`${baseName(src.name)}-unlocked`, await doc.save())];
      },
    });
  },
};
