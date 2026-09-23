import './styles.css';
import { Home, LayoutGrid, Search, FolderOpen } from 'lucide';
import { h, icon, button } from './lib/ui';
import type { PdfSource } from './lib/pdf';
import type { AppContext, Tool, ToolGroup } from './tools/common';
import { renderHome, renderAllTools, toolIcon, openInEditor, TOOL_COLORS } from './home';
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

/* ---------- top navbar ---------- */
const openInput = h('input', {
  type: 'file',
  accept: 'application/pdf,.pdf',
  hidden: true,
  onchange: () => {
    const f = openInput.files?.[0];
    openInput.value = '';
    if (f) void openInEditor(ctx, f);
  },
}) as HTMLInputElement;

const searchInput = h('input', {
  type: 'search',
  class: 'search-input',
  placeholder: 'Find a tool',
  'aria-label': 'Find a tool',
  autocomplete: 'off',
}) as HTMLInputElement;
const searchResults = h('div', { class: 'search-results', role: 'listbox', hidden: true });
let searchIndex = 0;

function matches(q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return TOOLS;
  return TOOLS.filter((t) => `${t.title} ${t.blurb} ${t.group}`.toLowerCase().includes(s));
}
function renderSearch() {
  const list = matches(searchInput.value).slice(0, 8);
  searchIndex = Math.min(searchIndex, Math.max(0, list.length - 1));
  searchResults.replaceChildren(
    ...(list.length
      ? list.map((t, i) =>
          h(
            'a',
            {
              class: `search-item${i === searchIndex ? ' active' : ''}`,
              href: `#/${t.id}`,
              role: 'option',
              'aria-selected': String(i === searchIndex),
              onmousedown: (e: MouseEvent) => e.preventDefault(), // keep focus until the click navigates
              onclick: () => closeSearch(),
            },
            toolIcon(t, 16),
            h('span', null, h('strong', null, t.title), h('small', null, t.blurb)),
          ),
        )
      : [h('div', { class: 'search-empty' }, 'No matching tools')]),
  );
  searchResults.hidden = false;
}
function closeSearch() {
  searchResults.hidden = true;
  searchInput.value = '';
  searchInput.blur();
}
searchInput.addEventListener('focus', () => ((searchIndex = 0), renderSearch()));
searchInput.addEventListener('input', () => ((searchIndex = 0), renderSearch()));
searchInput.addEventListener('blur', () => setTimeout(() => (searchResults.hidden = true), 120));
searchInput.addEventListener('keydown', (e) => {
  const list = matches(searchInput.value).slice(0, 8);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % Math.max(1, list.length);
    renderSearch();
  } else if (e.key === 'Enter' && list[searchIndex]) {
    location.hash = `#/${list[searchIndex].id}`;
    closeSearch();
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput.focus();
  }
});

const tabs = [
  { hash: '', label: 'Home', icon: Home },
  { hash: 'tools', label: 'All tools', icon: LayoutGrid },
].map((t) => h('a', { class: 'nav-tab', href: `#/${t.hash}`, 'data-tab': t.hash }, icon(t.icon, 16), h('span', null, t.label)));

const topbar = h(
  'header',
  { class: 'topbar' },
  h('a', { class: 'brand', href: '#/' }, h('img', { class: 'brand-mark', src: './icon.svg', alt: '', width: 28, height: 28 }), h('span', null, 'PDF Maker')),
  h('nav', { class: 'nav-tabs', 'aria-label': 'Main' }, tabs),
  h('div', { class: 'search' }, icon(Search, 16), searchInput, h('kbd', null, 'Ctrl K'), searchResults),
  h('span', { class: 'spacer' }),
  button('Open file', () => openInput.click(), { icon: FolderOpen, kind: 'primary' }),
  openInput,
);

/* ---------- sidebar (tool list) ---------- */
const main = h('main', { id: 'main', tabindex: -1 });
const updateLine = h('div', { class: 'update-line', hidden: true });
const nav = h(
  'nav',
  { class: 'sidebar', 'aria-label': 'Tools' },
  GROUPS.map((g) =>
    h(
      'div',
      { class: 'nav-group' },
      h('div', { class: 'nav-heading' }, g),
      TOOLS.filter((t) => t.group === g).map((t) =>
        h('a', { class: 'nav-item', href: `#/${t.id}`, 'data-id': t.id, style: `--c:${TOOL_COLORS[t.id]}` }, icon(t.icon, 17), h('span', null, t.title)),
      ),
    ),
  ),
  h('div', { class: 'nav-foot' }, h('p', null, 'Everything runs on your device. Files are never uploaded.'), updateLine),
);
document.getElementById('app')!.append(topbar, nav, main);

function route() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  const id = location.hash.replace(/^#\/?/, '');
  const tool = TOOLS.find((t) => t.id === id);
  nav.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', (a as HTMLElement).dataset.id === tool?.id));
  tabs.forEach((a) => a.classList.toggle('active', !tool && a.dataset.tab === (id === 'tools' ? 'tools' : '')));
  main.replaceChildren();
  main.className = tool?.wide ? 'wide' : '';
  document.title = tool ? `${tool.title} · PDF Maker` : id === 'tools' ? 'All tools · PDF Maker' : 'PDF Maker';
  if (!tool) {
    incoming = undefined;
    main.append(id === 'tools' ? renderAllTools(TOOLS, GROUPS) : renderHome(ctx, TOOLS));
  } else {
    const body = h('div', { class: 'tool-content' });
    if (!tool.wide) {
      main.append(h('header', { class: 'tool-head' }, toolIcon(tool), h('div', null, h('h1', null, tool.title), h('p', { class: 'muted' }, tool.blurb))));
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
function openLaunchFile(f: DesktopFile | null) {
  if (f) void openInEditor(ctx, { name: f.name, bytes: new Uint8Array(f.data) });
}
if (desktop) {
  void desktop.getLaunchFile().then(openLaunchFile);
  desktop.onOpenFile(openLaunchFile);
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
// A PDF dropped anywhere outside a tool's drop zone opens in the editor.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return; // a drop zone already handled it
  e.preventDefault();
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (file && !TOOLS.find((t) => t.wide && location.hash === `#/${t.id}`)) void openInEditor(ctx, file);
});
route();
