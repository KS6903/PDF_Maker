import { X } from 'lucide';
import { h, button, textInput, checkbox, icon } from '../lib/ui';
import { listSignatures, saveSignature, deleteSignature } from '../lib/signatures';

const SCALE = 3; // backing-store resolution so signatures print crisply
const MAX_UPLOAD_SIDE = 2400;

/**
 * Opens a dialog to pick a saved signature, or draw, type or upload a new one.
 * Resolves with a transparent PNG data URL, or null if cancelled.
 * Saved signatures live only in this computer's local storage.
 */
export function signatureDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const W = 560;
    const H = 200;
    const canvas = h('canvas', { class: 'sig-canvas', width: W * SCALE, height: H * SCALE, style: `width:${W}px;height:${H}px` }) as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(SCALE, SCALE);
    let ink = '#1a1a2e';
    let pen = 2.6;
    let mode: 'draw' | 'type' = 'draw';
    let hasInk = false;

    const typed = textInput('', 'Type your name or initials');
    const fontSel = h(
      'select',
      { 'aria-label': 'Signature style', onchange: () => drawTyped() },
      [
        ['"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive', 'Script'],
        ['"Lucida Handwriting", "Segoe Print", cursive', 'Handwriting'],
        ['"Segoe Print", "Comic Sans MS", cursive', 'Casual'],
        ['"Brush Script MT", "Segoe Script", cursive', 'Brush'],
        ['Georgia, "Times New Roman", serif', 'Formal'],
      ].map(([v, l]) => h('option', { value: v }, l)),
    ) as HTMLSelectElement;
    typed.addEventListener('input', () => drawTyped());

    function clear() {
      ctx.clearRect(0, 0, W, H);
      hasInk = false;
    }
    function drawTyped() {
      clear();
      const text = typed.value.trim();
      if (!text) return;
      let size = 80;
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      do {
        ctx.font = `${size}px ${fontSel.value}`;
        size -= 4;
      } while (ctx.measureText(text).width > W - 40 && size > 14);
      ctx.fillText(text, W / 2, H / 2);
      hasInk = true;
    }

    // Freehand drawing with smoothed quadratic curves.
    let last: [number, number] | null = null;
    let mid: [number, number] | null = null;
    const pos = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (mode !== 'draw') return;
      canvas.setPointerCapture(e.pointerId);
      last = pos(e);
      mid = last;
      ctx.beginPath();
      ctx.arc(last[0], last[1], pen / 2, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      hasInk = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!last || !mid || mode !== 'draw') return;
      const p = pos(e);
      const m: [number, number] = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
      ctx.strokeStyle = ink;
      // Pressure-sensitive pens get natural line weight.
      ctx.lineWidth = e.pressure > 0 && e.pointerType === 'pen' ? pen * (0.5 + e.pressure) : pen;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(mid[0], mid[1]);
      ctx.quadraticCurveTo(last[0], last[1], m[0], m[1]);
      ctx.stroke();
      last = p;
      mid = m;
    });
    const stop = () => (last = mid = null);
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    const remember = checkbox('Save to this computer for next time', true);

    // Uploads are used at full resolution rather than squeezed onto the pad.
    const upload = h('input', {
      type: 'file',
      accept: 'image/*',
      hidden: true,
      onchange: () => {
        const f = upload.files?.[0];
        upload.value = '';
        if (!f) return;
        const url = URL.createObjectURL(f);
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, MAX_UPLOAD_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * k));
          c.height = Math.max(1, Math.round(img.naturalHeight * k));
          c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          void finish(trimCanvas(c));
        };
        img.src = url;
      },
    }) as HTMLInputElement;

    const tabs = h('div', { class: 'seg', role: 'tablist' });
    const typeRow = h('div', { class: 'row sig-type-row', hidden: true }, typed, fontSel);
    const penRow = h('div', { class: 'row' });
    const setMode = (m: 'draw' | 'type') => {
      mode = m;
      clear();
      typeRow.hidden = m !== 'type';
      penRow.hidden = m !== 'draw';
      canvas.classList.toggle('typing', m === 'type');
      [...tabs.children].forEach((c, i) => c.setAttribute('aria-selected', String((i === 0) === (m === 'draw'))));
      if (m === 'type') {
        typed.focus();
        drawTyped();
      }
    };
    tabs.append(
      h('button', { type: 'button', role: 'tab', 'aria-selected': 'true', onclick: () => setMode('draw') }, 'Draw'),
      h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => setMode('type') }, 'Type'),
    );

    const custom = h('input', { type: 'color', value: '#1a1a2e', title: 'Any color', 'aria-label': 'Custom ink color' }) as HTMLInputElement;
    const setInk = (c: string, el?: Element) => {
      ink = c;
      swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
      el?.classList.add('on');
      if (mode === 'type') drawTyped();
    };
    const swatches = h(
      'div',
      { class: 'swatches' },
      ['#1a1a2e', '#1f3fae', '#0b6e4f', '#b42318'].map((c, i) =>
        h('button', {
          type: 'button',
          class: `swatch${i === 0 ? ' on' : ''}`,
          style: `background:${c}`,
          'aria-label': `Ink color ${c}`,
          onclick: (e: MouseEvent) => setInk(c, e.currentTarget as Element),
        }),
      ),
      custom,
    );
    custom.addEventListener('input', () => setInk(custom.value));

    penRow.append(
      h('span', { class: 'muted small' }, 'Pen'),
      ...(
        [
          ['Fine', 1.6],
          ['Medium', 2.6],
          ['Bold', 4],
        ] as const
      ).map(([label, w]) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip${w === pen ? ' on' : ''}`,
            onclick: (e: MouseEvent) => {
              pen = w;
              penRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
              (e.currentTarget as Element).classList.add('on');
            },
          },
          label,
        ),
      ),
    );

    const gallery = h('div', { class: 'sig-gallery' });
    const galleryWrap = h('div', { class: 'stack', hidden: true }, h('strong', { class: 'small' }, 'Your saved signatures'), gallery);
    async function renderGallery() {
      const saved = await listSignatures();
      galleryWrap.hidden = !saved.length;
      gallery.replaceChildren(
        ...saved.map((s) =>
          h(
            'div',
            { class: 'sig-item' },
            h('button', { type: 'button', class: 'sig-pick', title: 'Insert this signature', onclick: () => done(s.dataUrl) }, h('img', { src: s.dataUrl, alt: 'Saved signature' })),
            h(
              'button',
              {
                type: 'button',
                class: 'mini sig-del',
                title: 'Delete from this computer',
                'aria-label': 'Delete saved signature',
                onclick: async () => {
                  await deleteSignature(s.id);
                  void renderGallery();
                },
              },
              icon(X, 13),
            ),
          ),
        ),
      );
    }
    void renderGallery();

    const dlg = h('dialog', { class: 'modal sig-modal' }) as HTMLDialogElement;
    const done = (v: string | null) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    async function finish(url: string) {
      if (remember.input.checked) await saveSignature(url);
      done(url);
    }
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    dlg.append(
      h('h2', null, 'Add a signature or initials'),
      galleryWrap,
      h('div', { class: 'row between' }, tabs, swatches),
      typeRow,
      penRow,
      h('div', { class: 'sig-pad' }, canvas, h('div', { class: 'sig-line' })),
      h('div', { class: 'row between' }, remember.el, h('span', { class: 'muted small' }, 'Signatures never leave this computer.')),
      h(
        'div',
        { class: 'row between' },
        h(
          'div',
          { class: 'row' },
          button('Clear', () => (mode === 'type' ? ((typed.value = ''), clear()) : clear()), { kind: 'ghost' }),
          button('Upload image', () => upload.click(), { kind: 'ghost' }),
        ),
        h(
          'div',
          { class: 'row' },
          button('Cancel', () => done(null)),
          button('Insert', () => {
            if (hasInk) void finish(trimCanvas(canvas));
          }, { kind: 'primary' }),
        ),
      ),
      upload,
    );
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Crop a canvas to its non-transparent pixels and return a PNG data URL. */
function trimCanvas(src: HTMLCanvasElement) {
  const ctx = src.getContext('2d')!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let top = height,
    left = width,
    right = 0,
    bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left) return src.toDataURL('image/png');
  const pad = Math.round(Math.max(width, height) * 0.01);
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out.getContext('2d')!.drawImage(src, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
