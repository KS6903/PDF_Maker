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
 * the same. Each entry opens one of Folio's own tools.
 */
export interface CatalogEntry {
  label: string;
  icon: IconNode;
  color: string;
  /** Id of the Folio tool this opens. */
  tool?: string;
  /** Hash to open instead of a tool id, for entries that need a specific mode. */
  hash?: string;
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
  { label: 'Scan & OCR', icon: ScanText, color: '#16a34a', tool: 'ocr' },
  { label: 'Protect a PDF', icon: ShieldCheck, color: '#6d5ef0', tool: 'protect' },
  { label: 'Redact a PDF', icon: SquareSlash, color: '#e0559a', tool: 'redact' },
  { label: 'Compress a PDF', icon: Archive, color: '#e5484d', tool: 'compress' },
  { label: 'Prepare a form', icon: FormInput, color: '#8e4ec6', tool: 'fill-forms' },

  { label: 'Add a stamp', icon: Stamp, color: '#8e4ec6', tool: 'watermark', more: true },
  { label: 'Use a certificate', icon: BadgeCheck, color: '#0d9488', tool: 'certificate', more: true },
  { label: 'Use print production', icon: Printer, color: '#e0559a', tool: 'print-production', more: true },
  { label: 'Measure objects', icon: Ruler, color: '#e0559a', tool: 'measure', more: true },
  { label: 'Compare files', icon: GitCompare, color: '#e0559a', tool: 'compare', more: true },
  { label: 'Add rich media', icon: Video, color: '#0d9488', tool: 'rich-media', more: true },
  { label: 'Use guided actions', icon: Workflow, color: '#8e4ec6', tool: 'actions', more: true },
  { label: 'Prepare for accessibility', icon: Accessibility, color: '#6d5ef0', tool: 'accessibility', more: true },
  { label: 'Apply PDF standards', icon: FileBadge, color: '#e5484d', tool: 'pdf-standards', more: true },
  { label: 'Add search index', icon: Search, color: '#16a34a', tool: 'search-index', more: true },
  { label: 'Use JavaScript', icon: Braces, color: '#4f6ef7', tool: 'javascript', more: true },
  { label: 'Create custom tool', icon: Wrench, color: '#d97706', tool: 'custom-tool', more: true },

  // Folio tools that Acrobat has no matching entry for.
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
  { id: 'edit', label: 'Edit', entries: ['Edit a PDF', 'Add comments', 'Add a stamp', 'Organize pages', 'Add page numbers', 'Redact a PDF', 'Measure objects', 'Add rich media'] },
  { id: 'convert', label: 'Convert', entries: ['Create a PDF', 'Combine files', 'Export a PDF', 'Images to PDF', 'Extract text', 'Scan & OCR', 'Compress a PDF', 'Apply PDF standards'] },
  { id: 'sign', label: 'E-Sign', entries: ['Fill & Sign', 'Prepare a form', 'Protect a PDF', 'Use a certificate'] },
];

export const byLabel = new Map(CATALOG.map((e) => [e.label, e]));

/** Where an entry navigates to. */
export function entryHash(e: CatalogEntry) {
  if (e.hash) return e.hash;
  return e.tool ? `#/${e.tool}` : null;
}
