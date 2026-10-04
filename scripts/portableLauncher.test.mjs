import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const launcherName = '启动莲华视频导演台-便携版.bat';
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const executableName = `莲华视频导演台-${packageInfo.version}-便携版.exe`;

test('root portable launcher starts the executable from the delivery directory', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-launcher-'));
  const deliveryDirectory = path.join(sandbox, '交付');
  fs.mkdirSync(deliveryDirectory);
  fs.copyFileSync(path.join(root, launcherName), path.join(sandbox, launcherName));
  fs.copyFileSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'),
    path.join(deliveryDirectory, executableName),
  );
  t.after(() => fs.rmSync(sandbox, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  }));

  const result = spawnSync('cmd.exe', ['/d', '/c', launcherName], {
    cwd: sandbox,
    encoding: 'utf8',
    input: '\r\n',
    timeout: 5000,
    windowsHide: true,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(sandbox, executableName)), false);
});
