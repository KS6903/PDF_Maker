import './styles.css';
import { FileText, Home, FilePen } from 'lucide';
import { h, icon, dropzone, withBusy } from './lib/ui';
import { openPdf, type PdfSource } from './lib/pdf';
import type { AppContext, Tool, ToolGroup } from './tools/common';
import { editorTool } from './tools/editor';
import { formsTool } from './tools/forms';
import { watermarkTool } from './tools/watermark';
import { pageNumbersTool } from './tools/pagenumbers';
import { organizeTool } from './tools/organize';
import { mergeTool } from './tools/merge';
import { splitTool } from './tools/split';
import { compressTool } from './tools/compress';
import { createTool } from './tools/create';
import { imagesToPdfTool, pdfToImagesTool } from './tools/images';
import { extractTool } from './tools/extract';
import { protectTool, unlockTool } from './tools/protect';
import { metadataTool } from './tools/metadata';

const TOOLS: Tool[] = [
  editorTool,
  formsTool,
  watermarkTool,
  pageNumbersTool,
  organizeTool,
  mergeTool,
  splitTool,
  compressTool,
  createTool,
  imagesToPdfTool,
  pdfToImagesTool,
  extractTool,
  protectTool,
  unlockTool,
  metadataTool,
];
const GROUPS: ToolGroup[] = ['Edit & sign', 'Organize', 'Convert', 'Secure & info'];

let incoming: PdfSource | undefined;
let cleanup: (() => void) | void;

const ctx: AppContext = {
  tools: TOOLS,
  openTool(id, file) {
    incoming = file;
    if (location.hash === `#/${id}`) route();
    else location.hash = `#/${id}`;
  },
  takeIncoming() {
    const f = incoming;
    incoming = undefined;
    return f;
  },
};

const main = h('main', { id: 'main', tabindex: -1 });
const updateLine = h('div', { class: 'update-line', hidden: true });
const nav = h(
  'nav',
  { class: 'sidebar', 'aria-label': 'Tools' },
  h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon(FileText, 18)), h('span', null, 'PDF Maker')),
  h('a', { class: 'nav-item', href: '#/', 'data-id': '' }, icon(Home, 17), h('span', null, 'All tools')),
  GROUPS.map((g) =>
    h(
      'div',
      { class: 'nav-group' },
      h('div', { class: 'nav-heading' }, g),
      TOOLS.filter((t) => t.group === g).map((t) => h('a', { class: 'nav-item', href: `#/${t.id}`, 'data-id': t.id }, icon(t.icon, 17), h('span', null, t.title))),
    ),
  ),
  h('div', { class: 'nav-foot' }, h('p', null, 'Everything runs on your device. Files are never uploaded.'), updateLine),
);
document.getElementById('app')!.append(nav, main);

function home() {
  const zone = dropzone({
    accept: 'application/pdf,.pdf',
    title: 'Open a PDF to edit',
    hint: 'Drop a file here or click to browse. Everything stays on your computer.',
    icon: FilePen,
    onFiles: async ([file]) => {
      const src = await withBusy('Opening PDF…', () => openPdf(file));
      if (src) ctx.openTool('editor', src);
    },
  });
  return h(
    'div',
    { class: 'home' },
    h('header', { class: 'home-head' }, h('h1', null, 'What do you want to do with your PDF?'), h('p', { class: 'muted' }, 'Edit, sign, convert, merge, split, compress and protect — offline and free.')),
    zone,
    GROUPS.map((g) =>
      h(
        'section',
        { class: 'tool-section' },
        h('h2', null, g),
        h(
          'div',
          { class: 'tool-grid' },
          TOOLS.filter((t) => t.group === g).map((t) =>
            h('a', { class: 'tool-card', href: `#/${t.id}` }, h('span', { class: 'tool-icon' }, icon(t.icon, 22)), h('strong', null, t.title), h('span', null, t.blurb)),
          ),
        ),
      ),
    ),
  );
}

function route() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  const id = location.hash.replace(/^#\/?/, '');
  const tool = TOOLS.find((t) => t.id === id);
  nav.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', (a as HTMLElement).dataset.id === (tool?.id ?? '')));
  main.replaceChildren();
  main.className = tool?.wide ? 'wide' : '';
  document.title = tool ? `${tool.title} · PDF Maker` : 'PDF Maker';
  if (!tool) {
    incoming = undefined;
    main.append(home());
  } else {
    const body = h('div', { class: 'tool-content' });
    if (!tool.wide) {
      main.append(
        h('header', { class: 'tool-head' }, h('span', { class: 'tool-icon' }, icon(tool.icon, 22)), h('div', null, h('h1', null, tool.title), h('p', { class: 'muted' }, tool.blurb))),
      );
    }
    main.append(body);
    cleanup = tool.mount(body, ctx);
  }
  main.scrollTop = 0;
}

/* ---------- desktop app: PDFs opened via "Open with PDF Maker" ---------- */
interface DesktopFile {
  name: string;
  data: Uint8Array;
}
interface UpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
}
interface DesktopBridge {
  getLaunchFile(): Promise<DesktopFile | null>;
  onOpenFile(cb: (f: DesktopFile) => void): void;
  getAppInfo(): Promise<{ version: string; portable: boolean; packaged: boolean; status: UpdateStatus }>;
  checkForUpdates(): Promise<UpdateStatus>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
}
const desktop = (window as unknown as { pdfMaker?: DesktopBridge }).pdfMaker;
async function openInEditor(f: DesktopFile | null) {
  if (!f) return;
  const src = await withBusy('Opening PDF…', () => openPdf({ name: f.name, bytes: new Uint8Array(f.data) }));
  if (src) ctx.openTool('editor', src);
}
if (desktop) {
  void desktop.getLaunchFile().then(openInEditor);
  desktop.onOpenFile((f) => void openInEditor(f));
  void desktop.getAppInfo().then((info) => {
    const label = h('span');
    const check = h('button', { type: 'button', class: 'link-btn', onclick: () => void desktop.checkForUpdates() }, 'Check for updates');
    const show = (s: UpdateStatus) => {
      const extra =
        s.state === 'checking' ? ' · checking…'
        : s.state === 'downloading' ? ` · downloading ${s.version ?? 'update'}${s.percent ? ` (${s.percent}%)` : ''}`
        : s.state === 'ready' ? ` · ${s.version} ready, restart to install`
        : s.state === 'available' ? ` · ${s.version} available`
        : '';
      label.textContent = `Version ${info.version}${extra}`;
      check.hidden = s.state === 'checking' || s.state === 'downloading';
      if (s.state === 'ready') check.textContent = 'Restart to update';
    };
    show(info.status);
    desktop.onUpdateStatus(show);
    updateLine.append(label, check);
    updateLine.hidden = false;
  });
}

window.addEventListener('hashchange', route);
// Don't let a stray file drop outside a drop zone navigate away from the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
route();
