/**
 * Saving straight back to the files on this computer, in the desktop app.
 *
 * A PDF opened from disk remembers where it came from, so Save writes over
 * that same file without asking. A PDF made in the app asks once where to go,
 * and from then on saves there too. In a plain browser there is no disk access,
 * so saving falls back to a download.
 */

interface DiskBridge {
  pathOf(file: File): string;
  writePdf(path: string, bytes: Uint8Array): Promise<{ ok: boolean; missing?: boolean; error?: string }>;
  savePdfAs(name: string, bytes: Uint8Array, nearPath?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  readPdf(path: string): Promise<Uint8Array | null>;
  saveFileAs(name: string, bytes: Uint8Array, nearPath?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  saveFilesToFolder(files: { name: string; bytes: Uint8Array }[], nearPath?: string): Promise<{ ok: boolean; folder?: string; canceled?: boolean; error?: string }>;
}

const bridge = (window as unknown as { pdfMaker?: Partial<DiskBridge> }).pdfMaker;
const disk: DiskBridge | null =
  bridge?.writePdf && bridge.savePdfAs && bridge.pathOf && bridge.readPdf && bridge.saveFileAs && bridge.saveFilesToFolder ? (bridge as DiskBridge) : null;

/** Files made in the app from bytes the shell read, which have no path of their own. */
const known = new WeakMap<File, string>();

/** Whether Save can write to disk directly. */
export const canWriteDisk = !!disk;

export function rememberPath(file: File, path: string | undefined) {
  if (path) known.set(file, path);
}

/** Where a PDF file lives on disk, if it is one the user opened from there. */
export function diskPath(file: File): string | undefined {
  const p = known.get(file) ?? disk?.pathOf(file);
  return p && /\.pdf$/i.test(p) ? p : undefined;
}

export function fileNameOf(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export type SaveResult = { ok: true; path: string } | { ok: false; canceled?: boolean; missing?: boolean; error?: string };

/** Write over the file at `path`. */
export async function writeToDisk(path: string, bytes: Uint8Array): Promise<SaveResult> {
  if (!disk) return { ok: false, error: 'Saving to disk needs the desktop app.' };
  const res = await disk.writePdf(path, bytes);
  return res.ok ? { ok: true, path } : { ok: false, missing: res.missing, error: res.error };
}

/** Ask where to save, next to `nearPath` when given, and write the file there. */
export async function saveAsOnDisk(name: string, bytes: Uint8Array, nearPath?: string): Promise<SaveResult> {
  if (!disk) return { ok: false, error: 'Saving to disk needs the desktop app.' };
  const res = await disk.savePdfAs(name, bytes, nearPath);
  if (res.ok && res.path) return { ok: true, path: res.path };
  return { ok: false, canceled: res.canceled, error: res.error };
}

/** The file as it is on disk now, or null when it is gone or unreadable. */
export async function readFromDisk(path: string): Promise<Uint8Array | null> {
  return disk ? disk.readPdf(path).catch(() => null) : null;
}

/** Export one file: ask where, next to `nearPath` when given, and write it. */
export async function exportFile(name: string, bytes: Uint8Array, nearPath?: string): Promise<SaveResult> {
  if (!disk) return { ok: false, error: 'Saving to disk needs the desktop app.' };
  const res = await disk.saveFileAs(name, bytes, nearPath);
  if (res.ok && res.path) return { ok: true, path: res.path };
  return { ok: false, canceled: res.canceled, error: res.error };
}

/** Export several files into a folder the user picks. Resolves the folder, or why not. */
export async function exportFiles(files: { name: string; bytes: Uint8Array }[], nearPath?: string): Promise<SaveResult> {
  if (!disk) return { ok: false, error: 'Saving to disk needs the desktop app.' };
  const res = await disk.saveFilesToFolder(files, nearPath);
  if (res.ok && res.folder) return { ok: true, path: res.folder };
  return { ok: false, canceled: res.canceled, error: res.error };
}
