import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  encodeRecoveredState, recoverDeletedAssetPrompt, writeRecoveryWithCompareAndSwap,
  type RecoveryState,
} from './lib/deletedAssetPromptRecovery';

const require = createRequire(import.meta.url);
const { validateStateText } = require('../electron/stateSerialization.cjs') as {
  validateStateText: (text: string) => RecoveryState;
};
const args = process.argv.slice(2);
const usage = '用法：npx tsx scripts/recoverDeletedAssetPrompt.ts --state <project-state.json> --snapshot <恢复点.json> --project <项目ID> --board <分镜ID> --plan <计划ID> [--apply]（默认只检查）';
const allowed = new Set(['--state', '--snapshot', '--project', '--board', '--plan', '--apply']);
const values = new Map<string, string>();
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  if (!allowed.has(flag) || values.has(flag)) throw new Error(usage);
  if (flag === '--apply') values.set(flag, 'true');
  else {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(usage);
    values.set(flag, value);
  }
}
for (const flag of ['--state', '--snapshot', '--project', '--board', '--plan']) if (!values.get(flag)) throw new Error(usage);

const runningApplications = (): Array<{ Id: number; Name: string }> => {
  if (process.platform !== 'win32') throw new Error('本离线工具只支持 Windows，无法确认程序已关闭。');
  const source = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '莲华|lianhua|^electron\\.exe$' -or $_.ExecutablePath -match '莲华视频导演台|lianhua-video-director' } | Select-Object @{Name='Id'; Expression={$_.ProcessId}}, Name) | ConvertTo-Json -Compress",
  ].join('\n');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim();
  if (!result) return [];
  const parsed = JSON.parse(result) as { Id: number; Name: string } | Array<{ Id: number; Name: string }>;
  return Array.isArray(parsed) ? parsed : [parsed];
};
const assertAppClosed = (): void => {
  const running = runningApplications();
  if (running.length) throw new Error(`莲华程序或 Electron 开发程序仍在运行（PID: ${running.map((item) => item.Id).join(', ')}），请先正常退出，避免覆盖自动保存；现有项目不变。`);
};

try {
  const statePath = realpathSync(resolve(values.get('--state')!));
  const snapshotPath = realpathSync(resolve(values.get('--snapshot')!));
  if (statePath.toLowerCase() === snapshotPath.toLowerCase()) throw new Error('当前状态与恢复点不能是同一文件。');
  if (values.has('--apply')) assertAppClosed();
  const original = readFileSync(statePath);
  const current = validateStateText(original.toString('utf8'));
  const snapshot = validateStateText(readFileSync(snapshotPath, 'utf8'));
  const target = { projectId: values.get('--project')!, storyboardId: values.get('--board')!, sequencePlanId: values.get('--plan')! };
  const result = recoverDeletedAssetPrompt(current, snapshot, target);
  const report = { mode: values.has('--apply') ? 'apply' : 'dry-run', status: result.status, target,
    restoredFields: result.restoredFields, removedOutputCount: result.removedOutputIds.length };
  if (!values.has('--apply') || result.status === 'already-current') {
    console.log(JSON.stringify({ ...report, runningAppCount: runningApplications().length, written: false }, null, 2));
  } else {
    const encoded = encodeRecoveredState(result.state);
    validateStateText(encoded);
    const { backupPath } = writeRecoveryWithCompareAndSwap(statePath, original, encoded, assertAppClosed);
    console.log(JSON.stringify({ ...report, written: true, backupPath }, null, 2));
  }
} catch (error) {
  // Do not dump project objects, prompt text, task credentials or settings.
  console.error(error instanceof Error ? error.message : '定点恢复失败，未确认恢复成功。');
  process.exitCode = 1;
}
