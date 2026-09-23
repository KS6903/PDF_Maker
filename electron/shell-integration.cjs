// Right-click entries in File Explorer ("Convert to PDF with PDF Maker", ...).
//
// These are written under HKEY_CURRENT_USER, so no admin rights are needed and
// nothing outside this user account is touched. On Windows 11 entries like
// these appear under "Show more options"; only signed, packaged apps can put
// items in the short menu.
const { app } = require('electron');
const { spawnSync } = require('node:child_process');

const ROOT = 'HKCU\\Software\\Classes\\SystemFileAssociations';
const KEY = 'PDFMaker';

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff'];
const DOC_EXT = ['.docx', '.txt', '.md', '.markdown', '.html', '.htm'];

/** Every verb this app adds: which file types it applies to and what it runs. */
function entries(exe) {
  const list = [];
  const add = (ext, verb, label, args, multi) => list.push({ path: `${ROOT}\\${ext}\\shell\\${KEY}.${verb}`, label, command: `"${exe}"${args} "%1"`, icon: `"${exe}",0`, multi });

  add('.pdf', 'Edit', 'Edit with PDF Maker', ' --edit', false);
  add('.pdf', 'Merge', 'Merge with PDF Maker', ' --merge', true);
  add('.pdf', 'Compress', 'Compress with PDF Maker', ' --compress', false);
  for (const ext of IMAGE_EXT) add(ext, 'Convert', 'Convert to PDF with PDF Maker', ' --images', true);
  for (const ext of DOC_EXT) add(ext, 'Convert', 'Convert to PDF with PDF Maker', ' --create', false);
  return list;
}

function reg(args) {
  const r = spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function exePath() {
  // For a portable build this is the .exe the user launched.
  return process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
}

function isRegistered() {
  if (process.platform !== 'win32') return false;
  const first = entries(exePath())[0];
  const r = reg(['query', first.path, '/v', 'PDFMakerExe']);
  // Registered by a different copy of the app? Treat as not registered.
  return r.ok && r.out.includes(exePath());
}

function register() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  const exe = exePath();
  for (const e of entries(exe)) {
    const set = (args) => reg(['add', e.path, ...args, '/f']);
    if (!set(['/ve', '/d', e.label]).ok) return { ok: false, error: `Could not write ${e.path}` };
    set(['/v', 'Icon', '/d', e.icon]);
    // Remembering the path lets us detect entries left by an older copy.
    set(['/v', 'PDFMakerExe', '/d', exe]);
    if (e.multi) set(['/v', 'MultiSelectModel', '/d', 'Player']);
    if (!reg(['add', `${e.path}\\command`, '/ve', '/d', e.command, '/f']).ok) return { ok: false, error: `Could not write ${e.path}\\command` };
  }
  return { ok: true };
}

function unregister() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  for (const e of entries(exePath())) reg(['delete', e.path, '/f']);
  return { ok: true };
}

module.exports = { register, unregister, isRegistered, IMAGE_EXT, DOC_EXT };
