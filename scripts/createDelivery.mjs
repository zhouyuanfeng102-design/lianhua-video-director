import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertReleaseVersion, compareVersions } from './releaseVersion.mjs';

const root = process.cwd();
const outputDirectory = process.env.DELIVERY_DIR || path.join(root, '交付');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageInfo.version || '').trim();
assertReleaseVersion(version);
const portableName = `莲华视频导演台-${version}-便携版.exe`;
const sourceName = `莲华视频导演台-${version}-恢复源码.zip`;
const notesName = `莲华视频导演台-${version}-更新说明.md`;
const checksumName = `莲华视频导演台-${version}-SHA256.txt`;
const launcherSourceName = '启动莲华视频导演台-便携版.bat';
const launcherName = `启动莲华视频导演台-${version}-便携版.bat`;
const releaseNotesName = `发布说明-${version}.md`;
const deliveryLauncherContents = [
  '@echo off',
  'setlocal',
  'chcp 65001 >nul',
  'set "APP_DIR=%~dp0"',
  'set "TEMP=%APP_DIR%runtime-temp"',
  'set "TMP=%TEMP%"',
  'set "TMPDIR=%TEMP%"',
  `set "APP_EXE=%APP_DIR%${portableName}"`,
  'if not exist "%TEMP%" mkdir "%TEMP%"',
  'if not exist "%APP_EXE%" (',
  `  echo Lianhua portable ${version} exe not found.`,
  '  pause',
  '  exit /b 1',
  ')',
  'start "" "%APP_EXE%"',
  'endlocal',
  '',
].join('\r\n');
const portableSource = path.join(root, 'release', portableName);
if (!fs.existsSync(portableSource)) throw new Error(`Portable build is missing: ${portableSource}`);

function deliveryVersionFromName(name) {
  const applicationArtifact = /^莲华视频导演台-(\d+\.\d+\.\d+)-(?:便携版\.exe|恢复源码\.zip|更新说明\.md|SHA256\.txt)$/u.exec(name);
  if (applicationArtifact) return applicationArtifact[1];
  const launcherArtifact = /^启动莲华视频导演台-(\d+\.\d+\.\d+)-便携版\.bat$/u.exec(name);
  return launcherArtifact?.[1] ?? null;
}

const existingDeliveryNames = fs.existsSync(outputDirectory) ? fs.readdirSync(outputDirectory) : [];
const existingVersionedArtifacts = existingDeliveryNames
  .map((name) => ({ name, version: deliveryVersionFromName(name) }))
  .filter((artifact) => artifact.version !== null);
const highestExistingVersion = existingVersionedArtifacts
  .map((artifact) => artifact.version)
  .sort((left, right) => compareVersions(right, left))[0];

if (highestExistingVersion && compareVersions(version, highestExistingVersion) < 0) {
  throw new Error(
    `Refusing to publish ${version}: delivery directory already contains higher version ${highestExistingVersion}.`,
  );
}

const currentVersionCollisions = existingVersionedArtifacts
  .filter((artifact) => compareVersions(artifact.version, version) === 0)
  .map((artifact) => artifact.name);
if (currentVersionCollisions.length > 0 && process.env.LIANHUA_REPLACE_CURRENT_DELIVERY !== '1') {
  throw new Error(
    `Refusing to overwrite existing ${version} delivery artifacts: ${currentVersionCollisions.join(', ')}. `
      + 'Set LIANHUA_REPLACE_CURRENT_DELIVERY=1 only when intentionally rebuilding this current version.',
  );
}

// New checkouts keep release notes in docs/releases; older recovery archives
// still have the current notes at the project root.
const archivedReleaseNotes = path.join('docs', 'releases', releaseNotesName);
const releaseNotesRelativePath = fs.existsSync(path.join(root, archivedReleaseNotes))
  ? archivedReleaseNotes
  : releaseNotesName;
const releaseNotesSource = path.join(root, releaseNotesRelativePath);
if (!fs.existsSync(releaseNotesSource)) {
  throw new Error(`Release notes are missing: ${path.join(root, archivedReleaseNotes)} or ${releaseNotesSource}`);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

fs.mkdirSync(outputDirectory, { recursive: true });
const stage = path.join(root, `.delivery-source-${version}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const folders = ['build', 'electron', 'public', 'scripts', 'src'];
const files = [
  'index.html', 'package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'tsconfig.json', 'tsconfig.tests.json', 'vite.config.ts',
  '启动开发模式.bat', '启动莲华视频导演台-EXE.bat', '启动莲华视频导演台.bat',
  '多功能提示词模版5S.md', '多功能提示词模版10S.md', '多功能提示词模版15S.md',
  '莲华视频导演台-完整改造方案.md', releaseNotesRelativePath, launcherSourceName,
];
// Include the linked public documentation without copying arbitrary local
// documents, test reports, or user data into a recovery source archive.
for (const document of ['project-guide.md', 'github-publishing.md']) {
  const relativePath = path.join('docs', document);
  if (fs.existsSync(path.join(root, relativePath))) files.push(relativePath);
}
const imageRulesResearch = path.join('docs', 'research', 'google-grok-image-rules-2026-10-09.md');
if (fs.existsSync(path.join(root, imageRulesResearch))) files.push(imageRulesResearch);
const releaseNotesDirectory = path.join(root, 'docs', 'releases');
if (fs.existsSync(releaseNotesDirectory)) {
  for (const entry of fs.readdirSync(releaseNotesDirectory, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'README.md' || /^发布说明-\d+\.\d+\.\d+\.md$/u.test(entry.name))) {
      files.push(path.join('docs', 'releases', entry.name));
    }
  }
}
for (const folder of folders) copyDirectory(path.join(root, folder), path.join(stage, folder));
for (const file of new Set(files)) {
  const destination = path.join(stage, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}

const archive = path.join(outputDirectory, sourceName);
const temporaryArchive = `${archive}.tmp.zip`;
try { if (fs.existsSync(temporaryArchive)) fs.unlinkSync(temporaryArchive); } catch { /* fresh name on retry */ }
const result = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName 'System.IO.Compression.FileSystem'; if ([System.IO.File]::Exists($env:LH_DEST)) { [System.IO.File]::Delete($env:LH_DEST) }; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:LH_SOURCE, $env:LH_DEST, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
], {
  cwd: root,
  windowsHide: true,
  encoding: 'utf8',
  env: { ...process.env, LH_SOURCE: stage, LH_DEST: temporaryArchive },
});
if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Unable to create source archive').trim());
if (fs.existsSync(archive)) fs.unlinkSync(archive);
fs.renameSync(temporaryArchive, archive);
fs.copyFileSync(portableSource, path.join(outputDirectory, portableName));
fs.copyFileSync(releaseNotesSource, path.join(outputDirectory, notesName));
fs.writeFileSync(path.join(outputDirectory, launcherName), deliveryLauncherContents, 'utf8');
fs.writeFileSync(path.join(outputDirectory, launcherSourceName), deliveryLauncherContents, 'utf8');

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delivered = [portableName, sourceName, notesName, launcherName, launcherSourceName].map((name) => ({
  name,
  file: path.join(outputDirectory, name),
}));
const immutableDelivered = delivered.filter(({ name }) => name !== launcherSourceName);
const checksums = immutableDelivered.map(({ name, file }) => `${hash(file)}  ${name}`).join('\r\n');
fs.writeFileSync(path.join(outputDirectory, checksumName), `${checksums}\r\n`, 'utf8');
fs.rmSync(stage, { recursive: true, force: true });
console.log(JSON.stringify({
  outputDirectory,
  files: [...delivered, { name: checksumName, file: path.join(outputDirectory, checksumName) }].map(({ name, file }) => ({ name, bytes: fs.statSync(file).size })),
}, null, 2));
