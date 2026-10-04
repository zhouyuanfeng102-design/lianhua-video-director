import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const executable = require('electron');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const result = spawnSync(executable, [fileURLToPath(new URL('./generatedImageNativeDecode.cjs', import.meta.url))], {
  env: environment, windowsHide: true, encoding: 'utf8', timeout: 30_000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
