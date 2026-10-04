import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const scratch = path.join(root, '.qa-package-roundtrip');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(scratch, 'source', 'assets', 'video'), { recursive: true });
const media = Buffer.from('lianhua-managed-media-roundtrip');
const crypto = await import('node:crypto');
const checksum = crypto.createHash('sha256').update(media).digest('hex');
const relativePath = 'video/回合演示 · 第 2 版.mp4';
fs.writeFileSync(path.join(scratch, 'source', 'assets', relativePath), media);
const project = {
  schemaVersion: 5,
  project: { id: 'p', name: 'roundtrip', sourceDocuments: [], characters: [], locations: [], props: [], scenes: [], storyboards: [], assets: [{ id: 'a', name: 'clip.mp4', type: 'video', role: 'motion', mediaType: 'video', relativePath, checksum, sizeBytes: media.length, managed: true, tags: [], createdAt: 1, updatedAt: 1 }], generationTasks: [], createdAt: 1, updatedAt: 1 },
  settings: { textApi: {}, visionApi: {}, imageApi: {}, videoTaskApi: {}, apiCredentialBook: [], textApiProfiles: [], visionApiProfiles: [], imageApiProfiles: [] },
  ruleSets: [], converterPresets: [], stylePresets: []
};
fs.writeFileSync(path.join(scratch, 'source', 'project.json'), JSON.stringify(project));
fs.writeFileSync(path.join(scratch, 'source', 'manifest.json'), JSON.stringify({ format: 'lianhua-project-package', version: 1, assets: [{ id: 'a', relativePath, checksum, sizeBytes: media.length }] }));
const archive = path.join(scratch, 'roundtrip.lhvd');
const zip = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName 'System.IO.Compression.FileSystem'; if ([System.IO.File]::Exists($env:DST)) { [System.IO.File]::Delete($env:DST) }; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:SRC, $env:DST, [System.IO.Compression.CompressionLevel]::Optimal, $false)"], { encoding: 'utf8', env: { ...process.env, SRC: path.join(scratch, 'source'), DST: `${archive}.zip` } });
if (zip.status !== 0) throw new Error(zip.stderr || zip.stdout);
fs.renameSync(`${archive}.zip`, archive);
fs.mkdirSync(path.join(scratch, 'expanded'));
fs.copyFileSync(archive, `${archive}.zip`);
const unzip = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName 'System.IO.Compression.FileSystem'; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:SRC, $env:DST)"], { encoding: 'utf8', env: { ...process.env, SRC: `${archive}.zip`, DST: path.join(scratch, 'expanded') } });
if (unzip.status !== 0) throw new Error(unzip.stderr || unzip.stdout);
const expandedMedia = fs.readFileSync(path.join(scratch, 'expanded', 'assets', relativePath));
const expandedProject = JSON.parse(fs.readFileSync(path.join(scratch, 'expanded', 'project.json'), 'utf8'));
if (crypto.createHash('sha256').update(expandedMedia).digest('hex') !== checksum) throw new Error('Media checksum mismatch');
if (expandedProject.project.assets[0].relativePath !== relativePath) throw new Error('Project asset path mismatch');
console.log(JSON.stringify({ archive, bytes: fs.statSync(archive).size, checksum, project: expandedProject.project.name }, null, 2));
