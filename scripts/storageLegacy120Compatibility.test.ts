import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { createInitialState, serializeStateForStorage, STORAGE_KEY } from '../src/storage';
import type { AppState, ReferenceAsset } from '../src/types';

// When the retained historical delivery is available, execute its actual
// reader in an isolated VM. No extraction or application-data write occurs.
const archivePath = fileURLToPath(new URL('../交付/莲华视频导演台-0.5.120-恢复源码.zip', import.meta.url));
if (process.platform !== 'win32' || !existsSync(archivePath)) {
  console.log('storage legacy 0.5.120 compatibility: historical Windows source delivery unavailable; check skipped');
} else {
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `$archive = [System.IO.Compression.ZipFile]::OpenRead('${archivePath.replace(/'/gu, "''")}')`,
    'try {',
    "$entry = $archive.Entries | Where-Object { $_.FullName.Replace([char]92, [char]47) -match '(^|/)src/storage\\.ts$' } | Select-Object -First 1",
    "if (-not $entry) { throw 'Legacy storage source entry missing' }",
    '$reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)',
    'try { [Console]::Write($reader.ReadToEnd()) } finally { $reader.Dispose() }',
    '} finally { $archive.Dispose() }',
  ].join('\n');
  const output = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(output.status, 0, output.stderr);
  const legacySource = output.stdout;
  assert.ok(legacySource.includes('projectLibrary.set(normalizedProject.id, normalizedProject)'));
  assert.ok(!legacySource.includes('__activeProjectReference'), 'reader must be the actual pre-marker release');
  const legacyExports: Record<string, unknown> = {};
  let serialized = '';
  const context = vm.createContext({
    exports: legacyExports, module: { exports: legacyExports },
    require: createRequire(new URL('../src/storage.ts', import.meta.url)),
    window: {
      localStorage: { getItem: (key: string) => key === STORAGE_KEY ? serialized : null },
      lianhuaDesktop: { loadState: async () => serialized },
    },
  });
  const compiled = ts.transpileModule(legacySource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  vm.runInContext(compiled, context, { filename: 'legacy-0.5.120/storage.cjs' });
  const legacy = legacyExports as unknown as {
    loadState: () => AppState;
    loadDesktopState: () => Promise<AppState | null>;
  };
  const base = createInitialState();
  const asset: ReferenceAsset = {
    id: 'legacy-proof-image', name: 'Legacy compatibility fixture', type: 'reference', role: 'composition',
    dataUrl: 'data:image/png;base64,SYNTHETIC_FIXTURE_ONLY', tags: [], createdAt: 1, updatedAt: 1,
  };
  const active = {
    ...base.project, id: 'active-proof', description: 'Full active fixture text must survive.', assets: [asset],
    sourceDocuments: [{ id: 'legacy-source-proof', name: 'Original fixture', content: '角色甲说：“这是必须完整保留的原文。”\n第二段原文继续保留。', createdAt: 1, updatedAt: 1 }],
  };
  const archived = { ...base.project, id: 'archive-proof', description: 'Archived fixture must survive.' };
  for (const projects of [[active, archived], [archived, active]]) {
    const state = { ...base, project: active, projects, activeProjectId: active.id };
    serialized = serializeStateForStorage(state).serialized;
    for (const loaded of [legacy.loadState(), await legacy.loadDesktopState()]) {
      assert.ok(loaded);
      assert.equal(loaded.project.id, active.id);
      assert.equal(loaded.project.description, active.description);
      assert.equal(loaded.project.sourceDocuments[0].content, active.sourceDocuments[0].content);
      assert.equal(loaded.project.assets[0].dataUrl, asset.dataUrl);
      assert.deepEqual(Array.from(loaded.projects, (project) => project.id), projects.map((project) => project.id));
      assert.equal(loaded.projects.find((project) => project.id === archived.id)?.description, archived.description);
      assert.equal(loaded.projects.find((project) => project.id === active.id)?.assets[0].dataUrl, asset.dataUrl);
    }
  }
  console.log('storage legacy 0.5.120 compatibility: actual delivered reader preserves active text/media, archive and library order via browser and desktop load');
}
