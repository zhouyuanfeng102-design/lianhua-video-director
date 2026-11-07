import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryTargets } from './deliveryTargets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = deliveryTargets(process.argv.slice(2));
function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
// Build and type-check the shared frontend once. Both clients consume it.
run('node_modules/typescript/bin/tsc', ['--noEmit']);
run('node_modules/vite/bin/vite.js', ['build']);
if (targets.includes('windows')) {
  run('node_modules/electron-builder/out/cli/cli.js', [
    '--win', 'portable', '--x64', '--config.electronDist=node_modules/electron/dist',
  ]);
}
if (targets.includes('android')) run('scripts/buildAndroid.mjs', ['--skip-web-build']);
