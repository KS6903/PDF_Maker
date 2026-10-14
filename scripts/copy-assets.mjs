// Copies runtime assets into public/ so they ship with the app and work offline:
// pdf.js (CMaps for CJK text, standard fonts, wasm image decoders, ICC profiles)
// and the OCR engine (Tesseract worker, its WebAssembly builds, English model).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');

const pdfjs = join(root, 'public', 'pdfjs');
mkdirSync(pdfjs, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(modules, 'pdfjs-dist', dir), join(pdfjs, dir), { recursive: true });
}

const ocr = join(root, 'public', 'ocr');
mkdirSync(join(ocr, 'core'), { recursive: true });
mkdirSync(join(ocr, 'lang'), { recursive: true });
cpSync(join(modules, 'tesseract.js', 'dist', 'worker.min.js'), join(ocr, 'worker.min.js'));
// Only the LSTM builds: Folio runs the neural engine alone, with the matching model.
for (const build of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  cpSync(join(modules, 'tesseract.js-core', `${build}.wasm.js`), join(ocr, 'core', `${build}.wasm.js`));
}
cpSync(join(modules, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), join(ocr, 'lang', 'eng.traineddata.gz'));

console.log('pdf.js and OCR assets copied to public/');
