import { h, button, textInput } from '../lib/ui';

const STORE_KEY = 'pdfmaker.signature';

/**
 * Opens a dialog to draw, type or upload a signature.
 * Resolves with a trimmed transparent PNG data URL, or null if cancelled.
 */
export function signatureDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const W = 560;
    const H = 200;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = h('canvas', { class: 'sig-canvas', width: W * ratio, height: H * ratio, style: `width:${W}px;height:${H}px` }) as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(ratio, ratio);
    let ink = '#1a1a2e';
    let mode: 'draw' | 'type' = 'draw';
    let hasInk = false;

    const typed = textInput('', 'Type your name');
    const fontSel = h(
      'select',
      { 'aria-label': 'Signature style', onchange: () => drawTyped() },
      [
        ['"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive', 'Script'],
        ['"Lucida Handwriting", "Segoe Print", cursive', 'Handwriting'],
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
      let size = 72;
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      do {
        ctx.font = `${size}px ${fontSel.value}`;
        size -= 4;
      } while (ctx.measureText(text).width > W - 40 && size > 16);
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
      ctx.arc(last[0], last[1], 1.2, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      hasInk = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!last || !mid || mode !== 'draw') return;
      const p = pos(e);
      const m: [number, number] = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.6;
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

    const upload = h('input', {
      type: 'file',
      accept: 'image/*',
      hidden: true,
      onchange: () => {
        const f = upload.files?.[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        const img = new Image();
        img.onload = () => {
          clear();
          const k = Math.min((W - 20) / img.width, (H - 20) / img.height, 1);
          ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
          hasInk = true;
          URL.revokeObjectURL(url);
        };
        img.src = url;
      },
    }) as HTMLInputElement;

    const tabs = h('div', { class: 'seg', role: 'tablist' });
    const typeRow = h('div', { class: 'row', hidden: true }, typed, fontSel);
    const setMode = (m: 'draw' | 'type') => {
      mode = m;
      clear();
      typeRow.hidden = m !== 'type';
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

    const swatches = h(
      'div',
      { class: 'swatches' },
      ['#1a1a2e', '#1f3fae', '#0b6e4f'].map((c, i) =>
        h('button', {
          type: 'button',
          class: `swatch${i === 0 ? ' on' : ''}`,
          style: `background:${c}`,
          'aria-label': `Ink color ${c}`,
          onclick: (e: MouseEvent) => {
            ink = c;
            swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
            (e.currentTarget as HTMLElement).classList.add('on');
            if (mode === 'type') drawTyped();
          },
        }),
      ),
    );

    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORE_KEY);
    } catch {
      /* storage unavailable */
    }

    const dlg = h('dialog', { class: 'modal sig-modal' }) as HTMLDialogElement;
    const done = (v: string | null) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    dlg.append(
      h('h2', null, 'Add your signature'),
      h('div', { class: 'row between' }, tabs, swatches),
      typeRow,
      h('div', { class: 'sig-pad' }, canvas, h('div', { class: 'sig-line' })),
      h(
        'div',
        { class: 'row between' },
        h(
          'div',
          { class: 'row' },
          button('Clear', () => (mode === 'type' ? ((typed.value = ''), clear()) : clear()), { kind: 'ghost' }),
          button('Upload image', () => upload.click(), { kind: 'ghost' }),
          saved ? button('Use saved signature', () => done(saved), { kind: 'ghost' }) : null,
        ),
        h(
          'div',
          { class: 'row' },
          button('Cancel', () => done(null)),
          button('Insert', () => {
            if (!hasInk) return;
            const url = trimCanvas(canvas);
            try {
              localStorage.setItem(STORE_KEY, url);
            } catch {
              /* storage unavailable or full */
            }
            done(url);
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
  const pad = 6;
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
