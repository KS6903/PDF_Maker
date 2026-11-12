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
  Move3d,
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
 * The "All tools" list. Each entry is named for what it does and opens one of
 * Folio's tools; every tool appears once.
 */
export interface CatalogEntry {
  label: string;
  icon: IconNode;
  color: string;
  /** Id of the Folio tool this opens. */
  tool?: string;
  /** Hash to open instead of a tool id, for entries that need a specific mode. */
  hash?: string;
  /** Hidden until "View more" is clicked. */
  more?: boolean;
}

export const CATALOG: CatalogEntry[] = [
  { label: 'Edit a PDF', icon: SquarePen, color: '#e0559a', tool: 'editor' },
  { label: 'Create a PDF', icon: FilePlus2, color: '#e5484d', tool: 'create' },
  { label: 'Combine PDFs', icon: Combine, color: '#4f6ef7', tool: 'merge' },
  { label: 'Organize pages', icon: LayoutGrid, color: '#16a34a', tool: 'organize' },
  { label: 'Compress a PDF', icon: Archive, color: '#e5484d', tool: 'compress' },
  { label: 'Split a PDF', icon: Scissors, color: '#db2777', tool: 'split' },
  { label: 'Fill in a form', icon: FormInput, color: '#8e4ec6', tool: 'fill-forms' },
  { label: 'PDF to images', icon: FileOutput, color: '#16a34a', tool: 'pdf-to-images' },
  { label: 'Recognize text (OCR)', icon: ScanText, color: '#16a34a', tool: 'ocr' },
  { label: 'Add a password', icon: ShieldCheck, color: '#6d5ef0', tool: 'protect' },
  { label: 'Redact a PDF', icon: SquareSlash, color: '#e0559a', tool: 'redact' },
  { label: 'Add a watermark', icon: Stamp, color: '#8e4ec6', tool: 'watermark' },
  { label: 'Transform pictures', icon: Move3d, color: '#0891b2', tool: 'pictures' },

  { label: 'Add page numbers', icon: Hash, color: '#d97706', tool: 'page-numbers', more: true },
  { label: 'Images to PDF', icon: Images, color: '#0891b2', tool: 'images-to-pdf', more: true },
  { label: 'PDF to text or Word', icon: FileType, color: '#1d4ed8', tool: 'extract-text', more: true },
  { label: 'Remove a password', icon: LockOpen, color: '#65a30d', tool: 'unlock', more: true },
  { label: 'Document properties', icon: Info, color: '#0f766e', tool: 'metadata', more: true },
  { label: 'Sign with a digital ID', icon: BadgeCheck, color: '#0d9488', tool: 'certificate', more: true },
  { label: 'Compare two PDFs', icon: GitCompare, color: '#e0559a', tool: 'compare', more: true },
  { label: 'Measure distances', icon: Ruler, color: '#e0559a', tool: 'measure', more: true },
  { label: 'Prepare for printing', icon: Printer, color: '#e0559a', tool: 'print-production', more: true },
  { label: 'Embed video or files', icon: Video, color: '#0d9488', tool: 'rich-media', more: true },
  { label: 'Check accessibility', icon: Accessibility, color: '#6d5ef0', tool: 'accessibility', more: true },
  { label: 'Convert to PDF/A', icon: FileBadge, color: '#e5484d', tool: 'pdf-standards', more: true },
  { label: 'Search many PDFs', icon: Search, color: '#16a34a', tool: 'search-index', more: true },
  { label: 'Batch actions', icon: Workflow, color: '#8e4ec6', tool: 'actions', more: true },
  { label: 'PDF scripts', icon: Braces, color: '#4f6ef7', tool: 'javascript', more: true },
  { label: 'Make your own tab', icon: Wrench, color: '#d97706', tool: 'custom-tool', more: true },
];

/** Earlier names, so a custom tab saved with them still finds its tools. */
export const RENAMED: Record<string, string> = {
  'Combine files': 'Combine PDFs',
  'Fill & Sign': 'Fill in a form',
  'Prepare a form': 'Fill in a form',
  'Export a PDF': 'PDF to images',
  'Add comments': 'Edit a PDF',
  'Scan & OCR': 'Recognize text (OCR)',
  'Protect a PDF': 'Add a password',
  'Add a stamp': 'Add a watermark',
  'Use a certificate': 'Sign with a digital ID',
  'Use print production': 'Prepare for printing',
  'Measure objects': 'Measure distances',
  'Compare files': 'Compare two PDFs',
  'Add rich media': 'Embed video or files',
  'Use guided actions': 'Batch actions',
  'Prepare for accessibility': 'Check accessibility',
  'Apply PDF standards': 'Convert to PDF/A',
  'Add search index': 'Search many PDFs',
  'Use JavaScript': 'PDF scripts',
  'Create custom tool': 'Make your own tab',
  'Extract text': 'PDF to text or Word',
  'Unlock a PDF': 'Remove a password',
};

/** Ribbon tabs. Each lists the catalog labels it shows. */
export const RIBBON: { id: string; label: string; entries: string[] }[] = [
  { id: 'tools', label: 'All tools', entries: [] },
  { id: 'edit', label: 'Edit', entries: ['Edit a PDF', 'Transform pictures', 'Organize pages', 'Add a watermark', 'Add page numbers', 'Redact a PDF', 'Measure distances', 'Embed video or files'] },
  { id: 'convert', label: 'Convert', entries: ['Create a PDF', 'Combine PDFs', 'Split a PDF', 'Compress a PDF', 'PDF to images', 'Images to PDF', 'Transform pictures', 'PDF to text or Word', 'Recognize text (OCR)', 'Convert to PDF/A'] },
  { id: 'sign', label: 'Sign & protect', entries: ['Fill in a form', 'Sign with a digital ID', 'Add a password', 'Remove a password'] },
];

export const byLabel = new Map(CATALOG.map((e) => [e.label, e]));

/** Where an entry navigates to. */
export function entryHash(e: CatalogEntry) {
  if (e.hash) return e.hash;
  return e.tool ? `#/${e.tool}` : null;
}
