// Builds the Windows app and publishes it as a GitHub Release, which installed
// copies pick up as an automatic update. Uses GH_TOKEN if set, otherwise the
// token from the GitHub CLI (`gh auth login`).
import { execSync, spawnSync } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code terminals; breaks electron-builder's helpers
if (!env.GH_TOKEN) {
  try {
    env.GH_TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    console.error('No GitHub token. Run `gh auth login` or set GH_TOKEN.');
    process.exit(1);
  }
}
const r = spawnSync('npx', ['electron-builder', '--win', '--publish', 'always'], { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
