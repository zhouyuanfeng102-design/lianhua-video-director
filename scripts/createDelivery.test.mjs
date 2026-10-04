import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertReleaseVersion, compareVersions, parseVersion } from './releaseVersion.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const deliveryScriptSource = path.join(repositoryRoot, 'scripts', 'createDelivery.mjs');
const exeLauncherSource = path.join(repositoryRoot, '启动莲华视频导演台-EXE.bat');
const portableLauncherSource = path.join(repositoryRoot, '启动莲华视频导演台-便携版.bat');
const packageInfo = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = String(packageInfo.version || '').trim();
const portableName = `莲华视频导演台-${version}-便携版.exe`;
const sourceName = `莲华视频导演台-${version}-恢复源码.zip`;
const deliveredNotesName = `莲华视频导演台-${version}-更新说明.md`;
const checksumName = `莲华视频导演台-${version}-SHA256.txt`;
const sourceLauncherName = '启动莲华视频导演台-便携版.bat';
const deliveredLauncherName = `启动莲华视频导演台-${version}-便携版.bat`;

test(`release metadata targets ${version}`, () => {
  assert.equal(assertReleaseVersion(version), version);
  assert.equal(packageInfo.scripts?.[`deliver:${version}`], 'node scripts/createDelivery.mjs');
  const deliveryCommands = Object.keys(packageInfo.scripts ?? {})
    .filter((name) => name.startsWith('deliver:'));
  assert.equal(deliveryCommands.includes(`deliver:${version}`), true,
    'the current release delivery command must be exposed');
  // Keep already-delivered releases reproducible without changing which
  // version createDelivery selects from the current package.json.
  if (version !== '0.6.7') {
    assert.equal(deliveryCommands.includes('deliver:0.6.7'), true,
      'the 0.6.7 delivery command must remain available');
  }

  const packageLock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages?.['']?.version, version);
  assert.equal(packageInfo.scripts?.['next-version'], 'node scripts/nextVersion.mjs');

  const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  assert.equal(readme.includes(`当前开发版（${version}）`), true);
  assert.equal(readme.includes(portableName), true);
  assert.equal(readme.includes(`npm run deliver:${version}`), true);
  assert.equal(readme.includes('0.6.9 → 0.7.0'), true);
  assert.equal(readme.includes('0.9.9 → 1.0.0'), true);
  assert.equal(readme.includes('npm run next-version'), true);
  assert.match(readme, /应用内更新日志/u);
  assert.match(readme, /报错日志上方/u);
  assert.match(readme, /选择视觉风格/u);
  assert.match(readme, /加载旧项目不主动联动/u);
  assert.doesNotMatch(readme, /根据剧情自动匹配/u);

  const deliveryGuide = fs.readFileSync(
    path.join(repositoryRoot, '交付', '莲华视频导演台-交付说明.md'),
    'utf8',
  );
  assert.equal(deliveryGuide.includes(`当前交付版本为 **${version}**`), true);
  assert.equal(deliveryGuide.includes(portableName), true);
  assert.equal(deliveryGuide.includes(`npm run deliver:${version}`), true);

  const updateLog = fs.readFileSync(path.join(repositoryRoot, 'src', 'updateLog.ts'), 'utf8');
  assert.equal(/version: "([^"]+)"/u.exec(updateLog)?.[1], version);
  const versionPolicy = fs.readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');
  assert.match(versionPolicy, /0\.6\.9 → 0\.7\.0/u);
  assert.match(versionPolicy, /0\.9\.9 → 1\.0\.0/u);
});

test(`${version} release notes identify the current release and its delivery artifacts`, () => {
  const notes = fs.readFileSync(path.join(repositoryRoot, `发布说明-${version}.md`), 'utf8');
  for (const phrase of [
    `# 莲华视频导演台 ${version} 发布说明`, '版本定位', portableName,
    `npm run deliver:${version}`, 'SHA-256',
  ]) {
    assert.equal(notes.includes(phrase), true, `release notes must include ${phrase}`);
  }
});

function writeFile(file, contents = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function createFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-delivery-test-'));
  // Keep the legacy ../../outputs location inside the disposable fixture as well.
  const root = path.join(base, 'nested', 'project');
  fs.mkdirSync(root, { recursive: true });

  writeFile(path.join(root, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFile(path.join(root, 'release', portableName), 'fake-portable-exe');
  writeFile(path.join(root, `发布说明-${version}.md`), '# Fixture release notes');
  writeFile(path.join(root, sourceLauncherName), 'NEW VERSIONED LAUNCHER');
  writeFile(path.join(root, 'public', 'fixture-public.txt'), 'public asset');

  for (const folder of ['build', 'electron', 'src']) {
    writeFile(path.join(root, folder, '.fixture'), folder);
  }
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(deliveryScriptSource, path.join(root, 'scripts', 'createDelivery.mjs'));
  fs.copyFileSync(
    path.join(repositoryRoot, 'scripts', 'releaseVersion.mjs'),
    path.join(root, 'scripts', 'releaseVersion.mjs'),
  );

  for (const file of [
    'index.html', 'package-lock.json', 'README.md', 'AGENTS.md', 'tsconfig.json', 'tsconfig.tests.json', 'vite.config.ts',
    '启动开发模式.bat', '启动莲华视频导演台-EXE.bat', '启动莲华视频导演台.bat',
    '多功能提示词模版5S.md', '多功能提示词模版10S.md', '多功能提示词模版15S.md',
    '莲华视频导演台-完整改造方案.md',
  ]) {
    writeFile(path.join(root, file));
  }

  return { base, root };
}

function executeDelivery(root, outputDirectory, environment = {}) {
  const env = { ...process.env };
  delete env.DELIVERY_DIR;
  delete env.LIANHUA_REPLACE_CURRENT_DELIVERY;
  if (outputDirectory) env.DELIVERY_DIR = outputDirectory;
  Object.assign(env, environment);
  return spawnSync(process.execPath, ['scripts/createDelivery.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

function runDelivery(root, outputDirectory, environment = {}) {
  const result = executeDelivery(root, outputDirectory, environment);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function copyFastExecutable(destination) {
  const source = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
  assert.equal(fs.existsSync(source), true, `Windows test executable is missing: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

async function removeDirectoryEventually(directory, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = error && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code);
      if (!retryable || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function runRootExeLauncher(root) {
  const launcher = path.join(root, path.basename(exeLauncherSource));
  const runner = path.join(root, 'run-launcher-test.cmd');
  fs.copyFileSync(exeLauncherSource, launcher);
  fs.writeFileSync(
    runner,
    `@echo off\r\nchcp 65001 >nul\r\ncall "%~dp0${path.basename(exeLauncherSource)}"\r\nexit /b %errorlevel%\r\n`,
    'utf8',
  );
  return spawnSync('cmd.exe', ['/d', '/c', runner], {
    cwd: root,
    encoding: 'utf8',
    input: '\r\n',
    timeout: 10_000,
    windowsHide: true,
  });
}

function runDeliveredLauncher(outputDirectory, launcherName) {
  return spawnSync('cmd.exe', ['/d', '/c', launcherName], {
    cwd: outputDirectory,
    encoding: 'utf8',
    input: '\r\n',
    timeout: 10_000,
    windowsHide: true,
  });
}

function listZipEntries(archive) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'; $zip=[System.IO.Compression.ZipFile]::OpenRead($env:LH_ARCHIVE); try { $zip.Entries | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.FullName)) } } finally { $zip.Dispose() }",
  ], {
    encoding: 'utf8',
    env: { ...process.env, LH_ARCHIVE: archive },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((entry) => Buffer.from(entry, 'base64').toString('utf8').replaceAll('\\', '/'));
}

test('createDelivery defaults to the project-local 交付 directory', () => {
  const fixture = createFixture();
  try {
    const report = runDelivery(fixture.root);
    const expected = path.join(fixture.root, '交付');
    assert.equal(path.resolve(report.outputDirectory), expected);
    assert.equal(fs.existsSync(path.join(expected, portableName)), true);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('createDelivery includes public assets in the recovery source archive', () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.base, 'delivery-output');
    runDelivery(fixture.root, output);
    const entries = listZipEntries(path.join(output, sourceName));
    assert.equal(entries.includes('public/fixture-public.txt'), true, entries.join('\n'));
    assert.equal(entries.includes('tsconfig.tests.json'), true, entries.join('\n'));
    assert.equal(entries.includes('AGENTS.md'), true, entries.join('\n'));
    assert.equal(entries.includes('scripts/releaseVersion.mjs'), true, entries.join('\n'));
    assert.equal(entries.includes(`发布说明-${version}.md`), true, entries.join('\n'));
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('createDelivery delivers and hashes the versioned release notes', () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.base, 'delivery-output');
    runDelivery(fixture.root, output);
    const notes = path.join(output, deliveredNotesName);
    assert.equal(fs.readFileSync(notes, 'utf8'), '# Fixture release notes');
    const expectedHash = createHash('sha256').update(fs.readFileSync(notes)).digest('hex');
    const checksum = fs.readFileSync(path.join(output, checksumName), 'utf8');
    assert.match(checksum, new RegExp(`^${expectedHash}  ${deliveredNotesName.replaceAll('.', '\\.')}$`, 'mu'));
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('createDelivery refreshes the unversioned launcher without making historical checksums mutable', () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.base, 'delivery-output');
    const oldLauncher = path.join(output, sourceLauncherName);
    writeFile(oldLauncher, 'KEEP OLD LAUNCHER');
    runDelivery(fixture.root, output);
    const launcher = fs.readFileSync(oldLauncher, 'utf8');
    assert.match(launcher, new RegExp(`%APP_DIR%${portableName.replaceAll('.', '\\.')}`, 'u'));
    assert.doesNotMatch(launcher, /%APP_DIR%交付[\\/]/u);
    const checksum = fs.readFileSync(path.join(output, checksumName), 'utf8');
    assert.doesNotMatch(
      checksum,
      new RegExp(`^[a-f0-9]{64}  ${sourceLauncherName.replaceAll('.', '\\.')}$`, 'mu'),
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('createDelivery delivers and hashes a versioned launcher', () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.base, 'delivery-output');
    runDelivery(fixture.root, output);
    const launcher = path.join(output, deliveredLauncherName);
    const launcherContents = fs.readFileSync(launcher, 'utf8');
    assert.match(launcherContents, new RegExp(`%APP_DIR%${portableName.replaceAll('.', '\\.')}`, 'u'));
    assert.doesNotMatch(launcherContents, /%APP_DIR%交付[\\/]/u);
    const expectedHash = createHash('sha256').update(fs.readFileSync(launcher)).digest('hex');
    const checksum = fs.readFileSync(path.join(output, checksumName), 'utf8');
    assert.match(checksum, new RegExp(`^${expectedHash}  ${deliveredLauncherName.replaceAll('.', '\\.')}$`, 'mu'));
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('delivered launcher starts the portable executable from its own directory', () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.base, 'delivery-output');
    writeFile(
      path.join(fixture.root, sourceLauncherName),
      [
        '@echo off',
        'setlocal',
        'set "APP_DIR=%~dp0"',
        `set "APP_EXE=%APP_DIR%交付\\${portableName}"`,
        'if not exist "%APP_EXE%" exit /b 1',
        'start "" "%APP_EXE%"',
        'endlocal',
      ].join('\r\n'),
    );
    runDelivery(fixture.root, output);
    copyFastExecutable(path.join(output, portableName));

    const result = runDeliveredLauncher(output, deliveredLauncherName);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const deliveredSource = fs.readFileSync(path.join(output, deliveredLauncherName), 'utf8');
    assert.doesNotMatch(deliveredSource, /%APP_DIR%交付[\\/]/u);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

for (const collisionName of [
  portableName,
  sourceName,
  deliveredNotesName,
  checksumName,
  deliveredLauncherName,
]) {
  test(`createDelivery refuses to overwrite existing current-version artifact ${collisionName} by default`, () => {
    const fixture = createFixture();
    try {
      const output = path.join(fixture.base, 'delivery-output');
      const collision = path.join(output, collisionName);
      writeFile(collision, `SENTINEL:${collisionName}`);

      const result = executeDelivery(fixture.root, output);

      assert.notEqual(result.status, 0, 'delivery must reject an unapproved same-version overwrite');
      assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(`${version.replaceAll('.', '\\.')}|overwrite|replace|exist`, 'iu'));
      assert.equal(fs.readFileSync(collision, 'utf8'), `SENTINEL:${collisionName}`);
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}

test('createDelivery accepts only the exact replacement switch for a current-version collision', () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.base, 'delivery-output');
    const collision = path.join(output, portableName);
    writeFile(collision, 'CURRENT-SENTINEL');

    const result = executeDelivery(fixture.root, output, {
      LIANHUA_REPLACE_CURRENT_DELIVERY: 'true',
    });

    assert.notEqual(result.status, 0, 'only LIANHUA_REPLACE_CURRENT_DELIVERY=1 may replace the current delivery');
    assert.equal(fs.readFileSync(collision, 'utf8'), 'CURRENT-SENTINEL');
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('createDelivery replacement switch refreshes current artifacts and preserves lower historical versions', () => {
  const fixture = createFixture();
  try {
    const output = path.join(fixture.base, 'delivery-output');
    writeFile(path.join(output, portableName), 'CURRENT-SENTINEL');
    const historical = [
      ['莲华视频导演台-0.5.19-便携版.exe', 'OLD-EXE-SENTINEL'],
      ['莲华视频导演台-0.5.19-恢复源码.zip', 'OLD-ZIP-SENTINEL'],
      ['莲华视频导演台-0.5.19-更新说明.md', 'OLD-NOTES-SENTINEL'],
      ['莲华视频导演台-0.5.19-SHA256.txt', 'OLD-HASH-SENTINEL'],
      ['启动莲华视频导演台-0.5.19-便携版.bat', 'OLD-LAUNCHER-SENTINEL'],
      ['莲华视频导演台-0.5.160-便携版.exe', 'LAST-LEGACY-EXE-SENTINEL'],
      ['莲华视频导演台-0.5.160-恢复源码.zip', 'LAST-LEGACY-ZIP-SENTINEL'],
      ['莲华视频导演台-0.5.160-更新说明.md', 'LAST-LEGACY-NOTES-SENTINEL'],
      ['莲华视频导演台-0.5.160-SHA256.txt', 'LAST-LEGACY-HASH-SENTINEL'],
      ['启动莲华视频导演台-0.5.160-便携版.bat', 'LAST-LEGACY-LAUNCHER-SENTINEL'],
    ];
    for (const [name, contents] of historical) writeFile(path.join(output, name), contents);

    runDelivery(fixture.root, output, { LIANHUA_REPLACE_CURRENT_DELIVERY: '1' });

    assert.equal(fs.readFileSync(path.join(output, portableName), 'utf8'), 'fake-portable-exe');
    for (const [name, contents] of historical) {
      assert.equal(fs.readFileSync(path.join(output, name), 'utf8'), contents, `${name} must remain untouched`);
    }
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('createDelivery compares legacy versions numerically and rejects downgrade even with replacement enabled', () => {
  // Keep the original 0.9.9 < 0.10.0 case and exercise later major releases.
  // A same-major legacy minor of 10 is always above a valid decimal candidate.
  for (const candidateVersion of new Set(['0.9.9', '1.0.0', '2.9.9', '10.9.9', version])) {
    const fixture = createFixture();
    try {
      const [major] = parseVersion(candidateVersion);
      const newerVersion = `${major}.10.0`;
      assert.equal(assertReleaseVersion(candidateVersion), candidateVersion);
      assert.equal(compareVersions(candidateVersion, newerVersion), -1);
      assert.throws(() => assertReleaseVersion(newerVersion), /Invalid release version/u,
        'an existing legacy filename still participates in ordering even if it cannot be newly published');

      const candidateName = `莲华视频导演台-${candidateVersion}-便携版.exe`;
      writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ version: candidateVersion }));
      writeFile(path.join(fixture.root, 'release', candidateName), 'fake-portable-exe');
      const output = path.join(fixture.base, 'delivery-output');
      const newerName = `莲华视频导演台-${newerVersion}-便携版.exe`;
      const newer = path.join(output, newerName);
      writeFile(newer, 'NEWER-VERSION-SENTINEL');

      const result = executeDelivery(fixture.root, output, {
        LIANHUA_REPLACE_CURRENT_DELIVERY: '1',
      });

      assert.notEqual(result.status, 0, 'replacement may never publish below the highest delivered version');
      assert.match(`${result.stderr}\n${result.stdout}`,
        new RegExp(`already contains higher version ${newerVersion.replaceAll('.', '\\.')}`, 'u'));
      assert.equal(fs.readFileSync(newer, 'utf8'), 'NEWER-VERSION-SENTINEL');
      assert.equal(fs.existsSync(path.join(output, candidateName)), false);
      assert.deepEqual(fs.readdirSync(output), [newerName], 'downgrade rejection must not add delivery artifacts');
      assert.equal(fs.existsSync(path.join(fixture.root, `.delivery-source-${candidateVersion}`)), false,
        'downgrade rejection must happen before source staging');
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

for (const invalidVersion of ['0.5.160', '0.6.10', '0.10.0', '1.0.10', '1.10.0']) {
  test(`createDelivery rejects non-decimal candidate ${invalidVersion} before writing any output`, () => {
    const fixture = createFixture();
    try {
      const output = path.join(fixture.base, 'delivery-output');
      writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ version: invalidVersion }));
      writeFile(path.join(fixture.root, 'release', `莲华视频导演台-${invalidVersion}-便携版.exe`), 'invalid-build');
      const historical = path.join(output, '莲华视频导演台-0.5.160-便携版.exe');
      writeFile(historical, 'KEEP-LEGACY-SENTINEL');
      const entriesBefore = fs.readdirSync(output);

      const result = executeDelivery(fixture.root, output, { LIANHUA_REPLACE_CURRENT_DELIVERY: '1' });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid release version/u);
      assert.deepEqual(fs.readdirSync(output), entriesBefore);
      assert.equal(fs.readFileSync(historical, 'utf8'), 'KEEP-LEGACY-SENTINEL');
      assert.equal(fs.existsSync(path.join(fixture.root, `.delivery-source-${invalidVersion}`)), false);
    } finally {
      fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}

test(`root portable launcher selects only the complete ${version} portable filename from 交付`, () => {
  const expected = `set "APP_EXE=%APP_DIR%交付\\莲华视频导演台-${version}-便携版.exe"`;
  const source = fs.readFileSync(portableLauncherSource, 'utf8');
  assert.equal(source.includes(expected), true, `${path.basename(portableLauncherSource)} must target ${version}`);
  const portableReferences = source.match(/莲华视频导演台-\d+\.\d+\.\d+-便携版\.exe/gu) ?? [];
  assert.equal(portableReferences.length > 0, true, `${path.basename(portableLauncherSource)} must name a versioned executable`);
  assert.deepEqual([...new Set(portableReferences)], [portableName]);
  assert.doesNotMatch(source, /\*\d+\.\d+\.\d+\*\.exe/u);
});

test('root EXE launcher refuses a matching executable outside the direct 交付 folder', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-root-launcher-test-'));
  try {
    fs.mkdirSync(path.join(base, '交付'), { recursive: true });
    const wrongDirectory = path.join(base, '错误副本');
    copyFastExecutable(path.join(wrongDirectory, portableName));

    const result = runRootExeLauncher(base);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /Lianhua portable exe not found\./u);
    assert.equal(fs.existsSync(path.join(wrongDirectory, 'runtime-temp')), false);
  } finally {
    await removeDirectoryEventually(base);
  }
});

test('root EXE launcher selects the direct 交付 copy when a wrong sibling copy also exists', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-root-launcher-test-'));
  try {
    const deliveryDirectory = path.join(base, '交付');
    const wrongDirectory = path.join(base, '错误副本');
    copyFastExecutable(path.join(deliveryDirectory, portableName));
    copyFastExecutable(path.join(wrongDirectory, portableName));

    const result = runRootExeLauncher(base);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(deliveryDirectory, 'runtime-temp')), true);
    assert.equal(fs.existsSync(path.join(wrongDirectory, 'runtime-temp')), false);
  } finally {
    await removeDirectoryEventually(base);
  }
});
