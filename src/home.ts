import { ArrowRight, FileText, Trash2, X, Clock, ShieldCheck, MousePointerClick } from 'lucide';
import { h, icon, button, withBusy, formatBytes, toast } from './lib/ui';
import { openPdf } from './lib/pdf';
import { listRecent, getRecentBytes, removeRecent, clearRecent } from './lib/recent';
import { CATALOG, byLabel, entryHash, type CatalogEntry } from './lib/catalog';
import type { AppContext, Tool } from './tools/common';

type ShellIntegration = (action: 'add' | 'remove' | 'status') => Promise<{ ok: boolean; registered?: boolean; error?: string }>;
let shellIntegration: ShellIntegration | null = null;
/** Only the desktop app can add right-click entries to File Explorer. */
export function setShellIntegration(fn: ShellIntegration) {
  shellIntegration = fn;
}

/** Each tool gets its own accent so it's recognisable at a glance. */
export const TOOL_COLORS: Record<string, string> = Object.fromEntries(CATALOG.filter((e) => e.tool).map((e) => [e.tool!, e.color]));

const RECOMMENDED = ['Edit a PDF', 'Create a PDF', 'Combine files', 'Compress a PDF', 'Organize pages', 'Extract text'];

export function toolIcon(t: Tool, size = 22) {
  const entry = CATALOG.find((e) => e.tool === t.id);
  return h('span', { class: 'tool-icon', style: `--c:${entry?.color ?? 'var(--accent)'}` }, icon(entry?.icon ?? t.icon, size));
}

function entryIcon(e: CatalogEntry, size = 22) {
  return h('span', { class: 'tool-icon', style: `--c:${e.color}` }, icon(e.icon, size));
}

function blurbFor(e: CatalogEntry, tools: Tool[]) {
  return e.note ?? tools.find((t) => t.id === e.tool)?.blurb ?? '';
}

function entryCard(e: CatalogEntry, tools: Tool[], large = false) {
  const target = entryHash(e);
  const body = [
    entryIcon(e, large ? 24 : 20),
    h('strong', null, e.label),
    h('span', { class: 'tool-blurb' }, blurbFor(e, tools)),
    large && target ? h('span', { class: 'use-now' }, 'Use now', icon(ArrowRight, 14)) : null,
  ];
  if (!target) {
    return h(
      'button',
      { type: 'button', class: `tool-card not-ready ${e.status}`, title: e.note ?? '', onclick: () => toast(e.note ?? 'This tool is not available.', 'info') },
      body,
      h('span', { class: 'panel-badge' }, e.status === 'planned' ? 'Soon' : 'n/a'),
    );
  }
  return h('a', { class: `tool-card${large ? ' large' : ''}`, href: target, 'data-search': e.label.toLowerCase() }, body);
}

export async function openInEditor(ctx: AppContext, file: File | { name: string; bytes: Uint8Array }) {
  const src = await withBusy('Opening PDF…', () => openPdf(file));
  if (src) ctx.openTool('editor', src);
}

export function renderHome(ctx: AppContext, tools: Tool[]) {
  const recentBody = h('div', { class: 'recent-body' });

  const el = h(
    'div',
    { class: 'home' },
    h(
      'header',
      { class: 'home-head' },
      h('h1', null, 'Welcome to PDF Maker'),
      h('p', { class: 'muted' }, 'Edit, sign, convert and organize PDFs. Everything stays on this computer.'),
    ),
    h(
      'section',
      null,
      h('div', { class: 'section-head' }, h('h2', null, 'Recommended tools'), h('a', { class: 'see-all', href: '#/tools' }, 'See all tools', icon(ArrowRight, 14))),
      h(
        'div',
        { class: 'rec-grid' },
        RECOMMENDED.map((label) => byLabel.get(label))
          .filter((e): e is CatalogEntry => !!e)
          .map((e) => entryCard(e, tools, true)),
      ),
    ),
    h('section', { class: 'recent' }, recentBody),
    explorerPanel(),
    h(
      'p',
      { class: 'privacy-note' },
      icon(ShieldCheck, 16),
      'Your files are processed and saved only on this device. Nothing is ever uploaded.',
    ),
  );

  async function renderRecent() {
    const items = await listRecent();
    const head = h(
      'div',
      { class: 'section-head' },
      h('h2', null, 'Recent'),
      items.length
        ? button('Clear', async () => {
            await clearRecent();
            void renderRecent();
          }, { icon: Trash2, kind: 'ghost', title: 'Clear recent files' })
        : null,
    );
    if (!items.length) {
      recentBody.replaceChildren(
        head,
        h(
          'div',
          { class: 'recent-empty' },
          icon(Clock, 22),
          h('div', null, h('strong', null, 'No recent files'), h('span', null, 'Files you open appear here so you can pick up where you left off. They’re kept only on this computer.')),
        ),
      );
      return;
    }
    const table = h(
      'table',
      { class: 'recent-table' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Pages'), h('th', null, 'Opened'), h('th', null, 'Size'), h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
      h(
        'tbody',
        null,
        items.map((f) => {
          const open = async () => {
            const bytes = await getRecentBytes(f.id);
            if (!bytes) {
              toast('That file is no longer available. Open it again from your computer.', 'error');
              await removeRecent(f.id);
              return void renderRecent();
            }
            await openInEditor(ctx, { name: f.name, bytes });
          };
          return h(
            'tr',
            { tabindex: 0, onclick: open, onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && open(), title: `Open ${f.name}` },
            h('td', null, h('span', { class: 'file-name' }, icon(FileText, 18), h('span', null, f.name))),
            h('td', null, String(f.pages)),
            h('td', null, timeAgo(f.openedAt)),
            h('td', null, formatBytes(f.size)),
            h(
              'td',
              { class: 'row-actions' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'mini',
                  title: 'Remove from recent',
                  'aria-label': `Remove ${f.name} from recent`,
                  onclick: async (e: MouseEvent) => {
                    e.stopPropagation();
                    await removeRecent(f.id);
                    void renderRecent();
                  },
                },
                icon(X, 14),
              ),
            ),
          );
        }),
      ),
    );
    recentBody.replaceChildren(head, table);
  }
  void renderRecent();
  return el;
}

export function renderAllTools(tools: Tool[]) {
  const sections: [string, string, CatalogEntry[]][] = [
    ['Tools', '', CATALOG.filter((e) => !!e.tool)],
    ['Coming soon', 'Planned, and possible to do offline. Not built yet.', CATALOG.filter((e) => e.status === 'planned')],
    ['Not supported', 'These need a service, a signing store or a prepress engine that this app deliberately does without.', CATALOG.filter((e) => e.status === 'unavailable')],
  ];
  return h(
    'div',
    { class: 'home' },
    h('header', { class: 'home-head' }, h('h1', null, 'All tools')),
    sections
      .filter(([, , list]) => list.length)
      .map(([title, blurb, list]) =>
        h(
          'section',
          { class: 'tool-section' },
          h('h2', null, title),
          blurb ? h('p', { class: 'muted' }, blurb) : null,
          h('div', { class: 'tool-grid' }, list.map((e) => entryCard(e, tools))),
        ),
      ),
  );
}

/** Add or remove the "Convert to PDF with PDF Maker" entries in File Explorer. */
function explorerPanel() {
  const el = h('section', { class: 'explorer-panel', hidden: true });
  if (!shellIntegration) return el;
  const status = h('span', { class: 'muted small' });
  const action = button('', () => {}, { icon: MousePointerClick });
  let registered = false;

  const paint = () => {
    status.textContent = registered
      ? 'Right-click a file in File Explorer to convert, edit, merge or compress it.'
      : 'Add entries like "Convert to PDF with PDF Maker" to the File Explorer right-click menu.';
    action.replaceChildren(h('span', null, registered ? 'Remove from File Explorer' : 'Add to File Explorer'));
    action.className = `btn ${registered ? 'default' : 'primary'}`;
  };
  action.addEventListener('click', async () => {
    action.disabled = true;
    const res = await shellIntegration!(registered ? 'remove' : 'add');
    action.disabled = false;
    if (!res.ok) return toast(res.error ?? 'Could not change the right-click menu.', 'error');
    registered = !registered;
    paint();
    toast(registered ? 'Added to the File Explorer menu.' : 'Removed from the File Explorer menu.', 'success');
  });

  void shellIntegration('status').then((res) => {
    registered = !!res.registered;
    paint();
    el.replaceChildren(
      h('div', { class: 'explorer-head' }, icon(MousePointerClick, 18), h('strong', null, 'File Explorer menu'), h('span', { class: 'spacer' }), action),
      status,
      h('span', { class: 'muted small' }, 'On Windows 11 these appear under "Show more options".'),
    );
    el.hidden = false;
  });
  return el;
}

function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
