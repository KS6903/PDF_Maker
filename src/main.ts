import './styles.css';
import { ChevronDown, ChevronUp, FolderOpen, House, Menu as MenuIcon, Monitor, Moon, PanelLeft, Plus, Printer, Search, Sun, X } from 'lucide';
import { h, icon, button, toast } from './lib/ui';
import { initTheme, getTheme, setTheme, type ThemeMode } from './lib/theme';
import { CATALOG, RIBBON, byLabel, entryHash, type CatalogEntry } from './lib/catalog';
import type { PdfSource } from './lib/pdf';
import type { AppContext, Tool } from './tools/common';
import { renderHome, renderAllTools, openInEditor, setShellIntegration } from './home';
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

initTheme();

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

let incoming: PdfSource | undefined;
let incomingFiles: File[] | undefined;
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
  takeIncomingFiles() {
    const f = incomingFiles;
    incomingFiles = undefined;
    return f;
  },
};

/* ---------- shared file picker ---------- */
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

/* ---------- app bar: menu, home, document tabs, create ---------- */
const menuPanel = h('div', { class: 'menu-panel', hidden: true, role: 'menu' });
const menuBtn = h(
  'button',
  {
    type: 'button',
    class: 'appbar-btn menu-btn',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      toggleMenu(menuPanel.hidden === true);
    },
  },
  icon(MenuIcon, 18),
  h('span', null, 'Menu'),
);

function toggleMenu(open: boolean) {
  menuPanel.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
}
document.addEventListener('click', () => toggleMenu(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleMenu(false);
});
menuPanel.addEventListener('click', (e) => e.stopPropagation());

const versionLine = h('div', { class: 'menu-note' }, 'Running in a browser');
const updateAction = h('button', { type: 'button', class: 'menu-item', hidden: true }, 'Check for updates');

/** Three-way theme picker. The choice is remembered across restarts. */
const themeButtons = ([
  ['system', 'System', Monitor],
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
] as [ThemeMode, string, Parameters<typeof icon>[0]][]).map(([value, label, glyph]) =>
  h(
    'button',
    {
      type: 'button',
      class: 'theme-opt',
      'data-theme-opt': value,
      'aria-pressed': String(getTheme() === value),
      onclick: () => {
        setTheme(value);
        paintTheme();
      },
    },
    icon(glyph, 15),
    h('span', null, label),
  ),
);
function paintTheme() {
  for (const b of themeButtons) b.setAttribute('aria-pressed', String(getTheme() === b.dataset.themeOpt));
}

menuPanel.append(
  h('button', { type: 'button', class: 'menu-item', onclick: () => openInput.click() }, icon(FolderOpen, 16), h('span', null, 'Open a PDF')),
  h('div', { class: 'menu-sep' }),
  h('div', { class: 'menu-label' }, 'Appearance'),
  h('div', { class: 'theme-row' }, themeButtons),
  h('div', { class: 'menu-sep' }),
  versionLine,
  updateAction,
);

const docTabs = h('div', { class: 'doc-tabs', role: 'tablist', 'aria-label': 'Open documents' });

const appbar = h(
  'header',
  { class: 'appbar' },
  h('div', { class: 'menu-wrap' }, menuBtn, menuPanel),
  h('a', { class: 'appbar-btn icon-only', href: '#/', title: 'Home', 'aria-label': 'Home' }, icon(House, 18)),
  docTabs,
  h('a', { class: 'tab-add', href: '#/create', title: 'Create a PDF' }, icon(Plus, 16), h('span', null, 'Create')),
  h('span', { class: 'spacer' }),
  openInput,
);

/* ---------- ribbon: tool tabs and the find box ---------- */
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
  const live = CATALOG.filter((e) => !!e.tool);
  if (!s) return live;
  return live.filter((e) => e.label.toLowerCase().includes(s) || (TOOLS.find((t) => t.id === e.tool)?.blurb ?? '').toLowerCase().includes(s));
}
function renderSearch() {
  const list = matches(searchInput.value).slice(0, 8);
  searchIndex = Math.min(searchIndex, Math.max(0, list.length - 1));
  searchResults.replaceChildren(
    ...(list.length
      ? list.map((e, i) =>
          h(
            'a',
            {
              class: `search-item${i === searchIndex ? ' active' : ''}`,
              href: entryHash(e) ?? '#/',
              role: 'option',
              'aria-selected': String(i === searchIndex),
              onmousedown: (ev: MouseEvent) => ev.preventDefault(), // keep focus until the click navigates
              onclick: () => closeSearch(),
            },
            entryIcon(e, 16),
            h('span', null, h('strong', null, e.label), h('small', null, TOOLS.find((t) => t.id === e.tool)?.blurb ?? '')),
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
    const target = entryHash(list[searchIndex]);
    if (target) location.hash = target;
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

let ribbonTab = 'tools';
const ribbonTabs = RIBBON.map((t) =>
  h(
    'button',
    {
      type: 'button',
      class: 'ribbon-tab',
      'data-ribbon': t.id,
      onclick: () => {
        ribbonTab = t.id;
        paintRibbon();
        setPanelOpen(true);
      },
    },
    t.label,
  ),
);
function paintRibbon() {
  for (const b of ribbonTabs) b.classList.toggle('active', b.dataset.ribbon === ribbonTab);
  renderPanel();
}

const panelToggle = h(
  'button',
  { type: 'button', class: 'appbar-btn icon-only', title: 'Show or hide the tools panel', 'aria-label': 'Show or hide the tools panel', onclick: () => setPanelOpen(panel.hidden === true) },
  icon(PanelLeft, 18),
);

const ribbon = h(
  'nav',
  { class: 'ribbon', 'aria-label': 'Tool groups' },
  panelToggle,
  h('div', { class: 'ribbon-tabs' }, ribbonTabs),
  h('span', { class: 'spacer' }),
  h('div', { class: 'search' }, icon(Search, 16), searchInput, h('kbd', null, 'Ctrl K'), searchResults),
  button(null, () => window.print(), { icon: Printer, kind: 'ghost', title: 'Print' }),
  button('Open file', () => openInput.click(), { icon: FolderOpen, kind: 'primary' }),
);

/* ---------- left panel: All tools ---------- */
const panelList = h('div', { class: 'panel-list' });
let showMore = false;
const moreBtn = h('button', { type: 'button', class: 'view-more', onclick: () => ((showMore = !showMore), renderPanel()) });

const panel = h(
  'aside',
  { class: 'toolpanel', 'aria-label': 'All tools' },
  h(
    'div',
    { class: 'panel-head' },
    h('h2', null, 'All tools'),
    h('button', { type: 'button', class: 'panel-close', title: 'Close', 'aria-label': 'Close the tools panel', onclick: () => setPanelOpen(false) }, icon(X, 16)),
  ),
  panelList,
);

function setPanelOpen(open: boolean) {
  panel.hidden = !open;
  panelToggle.setAttribute('aria-pressed', String(open));
}

function entryIcon(e: CatalogEntry, size = 20) {
  return h('span', { class: 'tool-icon', style: `--c:${e.color}` }, icon(e.icon, size));
}

function entryRow(e: CatalogEntry) {
  const target = entryHash(e);
  const current = location.hash.replace(/^#\/?/, '');
  if (!target) {
    return h(
      'button',
      {
        type: 'button',
        class: `panel-item not-ready ${e.status}`,
        title: e.note ?? '',
        onclick: () => toast(e.note ?? 'This tool is not available.', 'info'),
      },
      entryIcon(e),
      h('span', { class: 'panel-label' }, e.label),
      h('span', { class: 'panel-badge' }, e.status === 'planned' ? 'Soon' : 'n/a'),
    );
  }
  return h(
    'a',
    { class: `panel-item${target === `#/${current}` ? ' active' : ''}`, href: target },
    entryIcon(e),
    h('span', { class: 'panel-label' }, e.label),
  );
}

function renderPanel() {
  const tab = RIBBON.find((t) => t.id === ribbonTab);
  if (tab && tab.entries.length) {
    panelList.replaceChildren(...tab.entries.map((label) => byLabel.get(label)).filter((e): e is CatalogEntry => !!e).map(entryRow));
    return;
  }
  const shown = showMore ? CATALOG : CATALOG.filter((e) => !e.more);
  moreBtn.replaceChildren(h('span', null, showMore ? 'View less' : 'View more'), icon(showMore ? ChevronUp : ChevronDown, 14));
  panelList.replaceChildren(...shown.map(entryRow), moreBtn);
}

/* ---------- assemble ---------- */
const main = h('main', { id: 'main', tabindex: -1 });
const workarea = h('div', { class: 'workarea' }, panel, main);
document.getElementById('app')!.append(appbar, ribbon, workarea);
setPanelOpen(true);
paintRibbon();

function route() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  toggleMenu(false);
  const id = location.hash.replace(/^#\/?/, '');
  const tool = TOOLS.find((t) => t.id === id);
  // Guard on `tool`, otherwise this matches the first entry that has no tool at all.
  const entry = tool ? CATALOG.find((e) => e.tool === tool.id) : undefined;
  const label = entry?.label ?? tool?.title;
  renderPanel();
  main.replaceChildren();
  main.className = tool?.wide ? 'wide' : '';
  document.title = label ? `${label} · PDF Maker` : id === 'tools' ? 'All tools · PDF Maker' : 'PDF Maker';
  renderDocTabs(label ?? (id === 'tools' ? 'All tools' : 'Home'));
  if (!tool) {
    incoming = undefined;
    main.append(id === 'tools' ? renderAllTools(TOOLS) : renderHome(ctx, TOOLS));
  } else {
    const body = h('div', { class: 'tool-content' });
    if (!tool.wide) {
      main.append(
        h(
          'header',
          { class: 'tool-head' },
          entry ? entryIcon(entry, 24) : null,
          h('div', null, h('h1', null, label ?? tool.title), h('p', { class: 'muted' }, tool.blurb)),
        ),
      );
    }
    main.append(body);
    cleanup = tool.mount(body, ctx);
  }
  main.scrollTop = 0;
}

/** The app bar tab strip. The editor manages its own document tabs inside its view. */
function renderDocTabs(label: string) {
  docTabs.replaceChildren(h('span', { class: 'doc-tab active' }, h('span', { class: 'doc-tab-name' }, label)));
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
interface LaunchPayload {
  mode: 'edit' | 'merge' | 'compress' | 'images' | 'create' | null;
  files: DesktopFile[];
}
interface DesktopBridge {
  getLaunchFiles(): Promise<LaunchPayload | null>;
  onOpenFiles(cb: (p: LaunchPayload | null) => void): void;
  shellIntegration(action: 'add' | 'remove' | 'status'): Promise<{ ok: boolean; registered?: boolean; error?: string }>;
  getAppInfo(): Promise<{ version: string; portable: boolean; packaged: boolean; status: UpdateStatus }>;
  checkForUpdates(): Promise<UpdateStatus>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
}
const desktop = (window as unknown as { pdfMaker?: DesktopBridge }).pdfMaker;
const IMAGE_RE = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i;
const PDF_RE = /\.pdf$/i;

/** Open whatever File Explorer (or "Open with") handed us, in the fitting tool. */
function handleLaunch(payload: LaunchPayload | null) {
  if (!payload?.files.length) return;
  const files = payload.files.map((f) => new File([new Uint8Array(f.data) as unknown as BlobPart], f.name, { type: PDF_RE.test(f.name) ? 'application/pdf' : '' }));
  const tool =
    payload.mode === 'merge' ? 'merge'
    : payload.mode === 'compress' ? 'compress'
    : payload.mode === 'images' ? 'images-to-pdf'
    : payload.mode === 'create' ? 'create'
    : files.every((f) => PDF_RE.test(f.name)) ? 'editor'
    : files.every((f) => IMAGE_RE.test(f.name)) ? 'images-to-pdf'
    : 'create';
  incomingFiles = files;
  incoming = undefined;
  ctx.openTool(tool);
}
if (desktop) {
  setShellIntegration(desktop.shellIntegration);
  void desktop.getLaunchFiles().then(handleLaunch);
  desktop.onOpenFiles(handleLaunch);
  void desktop.getAppInfo().then((info) => {
    const show = (s: UpdateStatus) => {
      const extra =
        s.state === 'checking' ? ' · checking…'
        : s.state === 'downloading' ? ` · downloading ${s.version ?? 'update'}${s.percent ? ` (${s.percent}%)` : ''}`
        : s.state === 'ready' ? ` · ${s.version} ready, restart to install`
        : s.state === 'available' ? ` · ${s.version} available`
        : '';
      versionLine.textContent = `Version ${info.version}${extra}`;
      updateAction.hidden = s.state === 'checking' || s.state === 'downloading';
      updateAction.textContent = s.state === 'ready' ? 'Restart to update' : 'Check for updates';
    };
    show(info.status);
    desktop.onUpdateStatus(show);
    updateAction.addEventListener('click', () => void desktop.checkForUpdates());
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
