import { ArrowRight, FileText, Trash2, X, Clock, ShieldCheck, MousePointerClick } from 'lucide';
import { h, icon, button, withBusy, formatBytes, toast } from './lib/ui';
import { openPdf } from './lib/pdf';
import { listRecent, getRecentBytes, removeRecent, clearRecent } from './lib/recent';
import type { AppContext, Tool, ToolGroup } from './tools/common';

type ShellIntegration = (action: 'add' | 'remove' | 'status') => Promise<{ ok: boolean; registered?: boolean; error?: string }>;
let shellIntegration: ShellIntegration | null = null;
/** Only the desktop app can add right-click entries to File Explorer. */
export function setShellIntegration(fn: ShellIntegration) {
  shellIntegration = fn;
}

/** Each tool gets its own accent so it's recognisable at a glance. */
export const TOOL_COLORS: Record<string, string> = {
  editor: '#e5484d',
  'fill-forms': '#8e4ec6',
  watermark: '#0d9488',
  'page-numbers': '#d97706',
  organize: '#16a34a',
  merge: '#2563eb',
  split: '#db2777',
  compress: '#dc2626',
  create: '#ea580c',
  'images-to-pdf': '#0891b2',
  'pdf-to-images': '#7c3aed',
  'extract-text': '#1d4ed8',
  protect: '#475569',
  unlock: '#65a30d',
  metadata: '#0f766e',
};

const RECOMMENDED = ['editor', 'create', 'merge', 'compress', 'organize', 'extract-text'];

export function toolIcon(t: Tool, size = 22) {
  return h('span', { class: 'tool-icon', style: `--c:${TOOL_COLORS[t.id] ?? 'var(--accent)'}` }, icon(t.icon, size));
}

function toolCard(t: Tool, large = false) {
  return h(
    'a',
    { class: `tool-card${large ? ' large' : ''}`, href: `#/${t.id}`, 'data-search': `${t.title} ${t.blurb}`.toLowerCase() },
    toolIcon(t, large ? 24 : 20),
    h('strong', null, t.title),
    h('span', { class: 'tool-blurb' }, t.blurb),
    large ? h('span', { class: 'use-now' }, 'Use now', icon(ArrowRight, 14)) : null,
  );
}

export async function openInEditor(ctx: AppContext, file: File | { name: string; bytes: Uint8Array }) {
  const src = await withBusy('Opening PDF…', () => openPdf(file));
  if (src) ctx.openTool('editor', src);
}

export function renderHome(ctx: AppContext, tools: Tool[]) {
  const byId = new Map(tools.map((t) => [t.id, t]));
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
      h('div', { class: 'rec-grid' }, RECOMMENDED.map((id) => byId.get(id)).filter((t): t is Tool => !!t).map((t) => toolCard(t, true))),
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

export function renderAllTools(tools: Tool[], groups: ToolGroup[]) {
  const empty = h('p', { class: 'muted', hidden: true }, 'No tools match your search.');
  const sections = groups.map((g) =>
    h('section', { class: 'tool-section' }, h('h2', null, g), h('div', { class: 'tool-grid' }, tools.filter((t) => t.group === g).map((t) => toolCard(t)))),
  );
  return h('div', { class: 'home' }, h('header', { class: 'home-head' }, h('h1', null, 'All tools')), sections, empty);
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
