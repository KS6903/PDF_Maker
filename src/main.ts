import './styles.css';
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  Download,
  FolderOpen,
  House,
  LoaderCircle,
  Menu as MenuIcon,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Sun,
  X,
} from 'lucide';
import { h, icon, button, toast, confirmDiscard } from './lib/ui';
import { unsavedNames } from './lib/unsaved';
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
  hasIncoming() {
    return incoming !== undefined;
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

/*
 * Update state lives here, next to the version, instead of interrupting with a
 * dialog. Only the two updates that need a decision - a portable download and
 * a restart-to-install - still open one.
 */
const browserNote = h('div', { class: 'menu-note' }, 'Running in a browser');
const versionLabel = h('span', { class: 'version-name' }, 'Folio');
const updateBadge = h('span', { class: 'update-badge', hidden: true });
const updateFill = h('i', { class: 'update-fill' });
const updateBar = h('div', { class: 'update-bar', hidden: true }, updateFill);
const versionLine = h(
  'div',
  { class: 'menu-version', hidden: true },
  h('div', { class: 'version-row' }, versionLabel, updateBadge),
  updateBar,
);
const updateAction = h('button', { type: 'button', class: 'menu-item update-action', hidden: true }, icon(RefreshCw, 16), h('span', null, 'Check for updates'));

/*
 * Automatic updates, on by default. Off means nothing is fetched or installed
 * behind your back: the app still finds updates when you ask, and the ribbon
 * button downloads one on request.
 */
const autoSwitch = h('button', {
  type: 'button',
  class: 'switch',
  role: 'switch',
  'aria-checked': 'true',
  'aria-label': 'Update automatically',
}, h('span', { class: 'switch-track' }, h('span', { class: 'switch-knob' })));
const autoRow = h(
  'div',
  { class: 'menu-switch', hidden: true },
  h('div', { class: 'switch-text' }, h('span', null, 'Update automatically'), h('small', { class: 'muted' }, 'Download and install new versions on their own')),
  autoSwitch,
);

/*
 * The one update control that is visible without opening the menu. It only
 * appears when there is something to act on, and says exactly what clicking
 * does.
 */
const updatePillLabel = h('span', null, 'Restart to update');
const updatePill = h(
  'button',
  { type: 'button', class: 'update-pill', hidden: true },
  icon(CircleArrowUp, 16),
  updatePillLabel,
);

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
  autoRow,
  browserNote,
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
  updatePill,
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
  document.title = label ? `${label} · Folio` : id === 'tools' ? 'All tools · Folio' : 'Folio';
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

/* ---------- desktop app: PDFs opened via "Open with Folio" ---------- */
interface DesktopFile {
  name: string;
  data: Uint8Array;
}
interface UpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  /** Whether updates download and install without being asked. */
  auto?: boolean;
}
interface LaunchPayload {
  mode: 'edit' | 'merge' | 'compress' | 'images' | 'create' | null;
  files: DesktopFile[];
}
interface DesktopBridge {
  getLaunchFiles(): Promise<LaunchPayload | null>;
  onOpenFiles(cb: (p: LaunchPayload | null) => void): void;
  shellIntegration(action: 'add' | 'remove' | 'status'): Promise<{ ok: boolean; registered?: boolean; error?: string }>;
  getAppInfo(): Promise<{ version: string; portable: boolean; packaged: boolean; releasesUrl: string; status: UpdateStatus }>;
  checkForUpdates(): Promise<UpdateStatus>;
  setAutoUpdate(on: boolean): Promise<{ auto: boolean }>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<boolean>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
  onConfirmClose(cb: (id: number) => void): void;
  respondToClose(id: number, close: boolean): void;
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
    let auto = info.status.auto ?? true;
    let state: UpdateStatus['state'] = info.status.state;
    /** Badge text, look and icon for each update state. Idle shows nothing. */
    const badges: Partial<Record<UpdateStatus['state'], [tone: string, label: (s: UpdateStatus) => string, glyph: Parameters<typeof icon>[0]]>> = {
      checking: ['checking', () => 'Checking…', LoaderCircle],
      current: ['ok', () => 'Up to date', CircleCheck],
      available: ['news', (s) => `${s.version ?? 'Update'} available`, CircleArrowUp],
      downloading: ['news', (s) => (s.percent ? `Downloading ${s.percent}%` : 'Downloading…'), Download],
      ready: ['news', (s) => `${s.version ?? 'Update'} ready`, CircleArrowUp],
      error: ['warn', () => 'Check failed', CircleAlert],
      unsupported: ['muted', () => 'Dev build', CircleAlert],
    };
    const show = (s: UpdateStatus) => {
      state = s.state;
      browserNote.hidden = true;
      versionLine.hidden = false;
      updateAction.hidden = false;
      versionLabel.textContent = `Folio ${info.version}`;

      const badge = badges[s.state];
      updateBadge.hidden = !badge;
      if (badge) {
        const [tone, label, glyph] = badge;
        const text = label(s);
        updateBadge.className = `update-badge ${tone}`;
        updateBadge.replaceChildren(icon(glyph, 13), h('span', null, text));
        updateBadge.title =
          s.state === 'error' ? 'Couldn’t reach the update server. Check your connection and try again.'
          : s.state === 'unsupported' ? 'Updates only run in the installed app.'
          : text;
      }

      const busy = s.state === 'checking' || s.state === 'downloading';
      updateBar.hidden = s.state !== 'downloading';
      updateFill.style.width = `${s.percent ?? 0}%`;
      updateAction.disabled = busy;
      updateAction.querySelector('span')!.textContent =
        s.state === 'ready' ? 'Restart to update'
        : s.state === 'available' && !info.portable ? 'Download the update'
        : s.state === 'downloading' ? 'Downloading update…'
        : s.state === 'checking' ? 'Checking…'
        : 'Check for updates';

      // Only an installed copy can update itself in place.
      autoRow.hidden = !info.packaged || info.portable;
      auto = s.auto ?? auto;
      autoSwitch.setAttribute('aria-checked', String(auto));

      // The ribbon button appears only when there is something to do.
      const pill =
        s.state === 'ready' ? ['ready', `Restart to update${s.version ? ` to ${s.version}` : ''}`, 'Installs the update and reopens Folio']
        : s.state === 'downloading' ? ['busy', s.percent ? `Updating ${s.percent}%` : 'Downloading…', 'Downloading the update']
        : s.state === 'available' ? ['news', `Update to ${s.version ?? 'the new version'}`, info.portable ? 'Opens the download page' : 'Downloads the update now']
        : null;
      updatePill.hidden = !pill;
      if (pill) {
        const [tone, label, tip] = pill;
        updatePill.className = `update-pill ${tone}`;
        updatePillLabel.textContent = label;
        updatePill.title = tip;
        updatePill.disabled = tone === 'busy';
      }
    };
    show(info.status);
    desktop.onUpdateStatus(show);
    updateAction.addEventListener('click', () => {
      if (state === 'ready') void desktop.installUpdate();
      else if (state === 'available' && !info.portable) void desktop.downloadUpdate();
      else void desktop.checkForUpdates();
    });

    autoSwitch.addEventListener('click', () => {
      auto = !auto;
      autoSwitch.setAttribute('aria-checked', String(auto));
      void desktop.setAutoUpdate(auto);
    });

    updatePill.addEventListener('click', () => {
      if (state === 'ready') {
        // Closes, installs silently and reopens. Unsaved edits are still asked about.
        void desktop.installUpdate();
      } else if (info.portable) {
        window.open(info.releasesUrl, '_blank');
      } else {
        void desktop.downloadUpdate();
      }
    });
  });

  // Closing the window asks with the app's own dialog, not a native one.
  desktop.onConfirmClose(async (id) => {
    const names = unsavedNames();
    if (!names.length) return desktop.respondToClose(id, true);
    toggleMenu(false);
    const ok = await confirmDiscard({
      title: 'Unsaved changes',
      message:
        names.length === 1
          ? `“${names[0]}” has edits that haven’t been saved to a PDF yet.`
          : `${names.length} documents have edits that haven’t been saved to a PDF yet.`,
      items: names.length > 1 ? names : undefined,
      detail: 'Closing Folio now loses them.',
      confirm: 'Close anyway',
      cancel: 'Keep editing',
    });
    desktop.respondToClose(id, ok);
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
