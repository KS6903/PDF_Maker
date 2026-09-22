// Copies pdf.js runtime assets (CMaps for CJK text, standard fonts, wasm image
// decoders, ICC profiles) into public/ so they ship with the app and work offline.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pdfjs-dist');
const to = join(root, 'public', 'pdfjs');
mkdirSync(to, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(from, dir), join(to, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
