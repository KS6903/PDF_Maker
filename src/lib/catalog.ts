import type { IconNode } from 'lucide';
import {
  Accessibility,
  Archive,
  BadgeCheck,
  Braces,
  Combine,
  FileBadge,
  FileOutput,
  FilePlus2,
  FileType,
  FormInput,
  GitCompare,
  Hash,
  Images,
  Info,
  LayoutGrid,
  LockOpen,
  MessageSquarePlus,
  PenTool,
  Printer,
  Ruler,
  ScanText,
  Scissors,
  Search,
  ShieldCheck,
  SquarePen,
  SquareSlash,
  Stamp,
  Video,
  Workflow,
  Wrench,
} from 'lucide';

/**
 * The "All tools" list, named the way Acrobat names things so the panel reads
 * the same. Entries with a `tool` open one of PDF Maker's own tools. Entries
 * with a `status` are listed so the panel is complete, but say plainly that
 * they do not work yet and why.
 */
export interface CatalogEntry {
  label: string;
  icon: IconNode;
  color: string;
  /** Id of the PDF Maker tool this opens. */
  tool?: string;
  /** Hash to open instead of a tool id, for entries that need a specific mode. */
  hash?: string;
  /** 'planned' can be built offline, 'unavailable' needs something this app will not do. */
  status?: 'planned' | 'unavailable';
  /** Shown as the tooltip and in the tool page for entries that are not wired up. */
  note?: string;
  /** Hidden until "View more" is clicked, like Acrobat. */
  more?: boolean;
}

export const CATALOG: CatalogEntry[] = [
  { label: 'Create a PDF', icon: FilePlus2, color: '#e5484d', tool: 'create' },
  { label: 'Combine files', icon: Combine, color: '#4f6ef7', tool: 'merge' },
  { label: 'Edit a PDF', icon: SquarePen, color: '#e0559a', tool: 'editor' },
  { label: 'Fill & Sign', icon: PenTool, color: '#8e4ec6', tool: 'fill-forms' },
  { label: 'Export a PDF', icon: FileOutput, color: '#16a34a', tool: 'pdf-to-images' },
  { label: 'Organize pages', icon: LayoutGrid, color: '#16a34a', tool: 'organize' },
  { label: 'Add comments', icon: MessageSquarePlus, color: '#d97706', tool: 'editor' },
  {
    label: 'Scan & OCR',
    icon: ScanText,
    color: '#16a34a',
    status: 'planned',
    note: 'Reading text off scanned pages needs an OCR engine bundled with the app. Not built yet.',
  },
  { label: 'Protect a PDF', icon: ShieldCheck, color: '#6d5ef0', tool: 'protect' },
  {
    label: 'Redact a PDF',
    icon: SquareSlash,
    color: '#e0559a',
    status: 'planned',
    note: 'Blacking out text and removing it from the file underneath. Not built yet.',
  },
  { label: 'Compress a PDF', icon: Archive, color: '#e5484d', tool: 'compress' },
  { label: 'Prepare a form', icon: FormInput, color: '#8e4ec6', tool: 'fill-forms' },

  { label: 'Add a stamp', icon: Stamp, color: '#8e4ec6', tool: 'watermark', more: true },
  {
    label: 'Use a certificate',
    icon: BadgeCheck,
    color: '#0d9488',
    status: 'unavailable',
    note: 'Certificate signing needs access to the Windows certificate store and a signing library. Not built.',
    more: true,
  },
  {
    label: 'Use print production',
    icon: Printer,
    color: '#e0559a',
    status: 'unavailable',
    note: 'Prepress tools (ink manager, colour separations, trapping) are out of scope for this app.',
    more: true,
  },
  {
    label: 'Measure objects',
    icon: Ruler,
    color: '#e0559a',
    status: 'planned',
    note: 'Measuring distances and areas on a page at a set scale. Not built yet.',
    more: true,
  },
  {
    label: 'Compare files',
    icon: GitCompare,
    color: '#e0559a',
    status: 'planned',
    note: 'Side by side diff of two PDFs. Not built yet.',
    more: true,
  },
  {
    label: 'Add rich media',
    icon: Video,
    color: '#0d9488',
    status: 'unavailable',
    note: 'Embedded video and audio only play in Acrobat, so they would not survive to other readers.',
    more: true,
  },
  {
    label: 'Use guided actions',
    icon: Workflow,
    color: '#8e4ec6',
    status: 'planned',
    note: 'Saved sequences that run several tools over a batch of files. Not built yet.',
    more: true,
  },
  {
    label: 'Prepare for accessibility',
    icon: Accessibility,
    color: '#6d5ef0',
    status: 'planned',
    note: 'Setting the document language, title and reading order. Not built yet.',
    more: true,
  },
  {
    label: 'Apply PDF standards',
    icon: FileBadge,
    color: '#e5484d',
    status: 'unavailable',
    note: 'Converting to PDF/A or PDF/X needs a full preflight engine. Not built.',
    more: true,
  },
  {
    label: 'Add search index',
    icon: Search,
    color: '#16a34a',
    status: 'unavailable',
    note: 'Acrobat catalog indexes are only read by Acrobat. Use the find box instead.',
    more: true,
  },
  {
    label: 'Use JavaScript',
    icon: Braces,
    color: '#4f6ef7',
    status: 'unavailable',
    note: 'Running scripts embedded in a PDF is a security risk, so this app does not do it.',
    more: true,
  },
  {
    label: 'Create custom tool',
    icon: Wrench,
    color: '#d97706',
    status: 'planned',
    note: 'Pinning your own set of tools to the toolbar. Not built yet.',
    more: true,
  },

  // PDF Maker tools that Acrobat has no matching entry for.
  { label: 'Split a PDF', icon: Scissors, color: '#db2777', tool: 'split', more: true },
  { label: 'Add page numbers', icon: Hash, color: '#d97706', tool: 'page-numbers', more: true },
  { label: 'Images to PDF', icon: Images, color: '#0891b2', tool: 'images-to-pdf', more: true },
  { label: 'Extract text', icon: FileType, color: '#1d4ed8', tool: 'extract-text', more: true },
  { label: 'Unlock a PDF', icon: LockOpen, color: '#65a30d', tool: 'unlock', more: true },
  { label: 'Document properties', icon: Info, color: '#0f766e', tool: 'metadata', more: true },
];

/** Ribbon tabs, matching Acrobat's. Each lists the catalog labels it shows. */
export const RIBBON: { id: string; label: string; entries: string[] }[] = [
  { id: 'tools', label: 'All tools', entries: [] },
  { id: 'edit', label: 'Edit', entries: ['Edit a PDF', 'Add comments', 'Add a stamp', 'Organize pages', 'Add page numbers', 'Redact a PDF'] },
  { id: 'convert', label: 'Convert', entries: ['Create a PDF', 'Combine files', 'Export a PDF', 'Images to PDF', 'Extract text', 'Compress a PDF'] },
  { id: 'sign', label: 'E-Sign', entries: ['Fill & Sign', 'Prepare a form', 'Protect a PDF', 'Use a certificate'] },
];

export const byLabel = new Map(CATALOG.map((e) => [e.label, e]));

/** Where an entry navigates to, or null when it is not wired up. */
export function entryHash(e: CatalogEntry) {
  if (e.hash) return e.hash;
  return e.tool ? `#/${e.tool}` : null;
}
