import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  allocateReadableName, kindDirectory, placeProjectAssets, projectFolderName, sanitizeProjectFolderName,
} = require('../electron/projectAssetLayout.cjs');

const checksum = (text) => createHash('sha256').update(text).digest('hex');
const temporary = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lianhua-asset-layout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('a project title becomes its image, video and audio folders', () => {
  const project = { id: 'project_mvnt7mld_7u8ya9', name: '3221321' };
  assert.equal(projectFolderName(project, [project]), '3221321');
  assert.equal(kindDirectory('image', project, [project]), 'projects/3221321/image');
  assert.equal(kindDirectory('video', project, [project]), 'projects/3221321/video');
  assert.equal(kindDirectory('audio', project, [project]), 'projects/3221321/audio');
  assert.equal(sanitizeProjectFolderName('3221:321'), '3221321');
  assert.equal(sanitizeProjectFolderName('con'), '未命名项目');
  assert.equal(kindDirectory('image', { id: 'bare' }, [{ id: 'bare' }]), 'image');
});

test('the second project that sanitizes to the same title keeps a stable id suffix', () => {
  const first = { id: 'a-project', name: '同名' };
  const second = { id: 'b-project_7u8ya9', name: '同名' };
  const projects = [second, first];
  assert.equal(projectFolderName(first, projects), '同名');
  assert.equal(projectFolderName(second, projects), '同名-7u8ya9');
  assert.equal(projectFolderName(second, projects), '同名-7u8ya9');
  const collided = [
    { id: 'a111111', name: '同名' },
    { id: 'b111111', name: '同名' },
    { id: 'c111111', name: '同名' },
  ];
  assert.equal(projectFolderName(collided[0], collided), '同名');
  assert.equal(projectFolderName(collided[1], collided), '同名-111111');
  assert.equal(projectFolderName(collided[2], collided), '同名-c111111');
});

test('image names keep the title and a version, and the same bytes stay on the first file', () => {
  assert.equal(allocateReadableName([], '首帧.png', 'aaa', () => 'bbb', { numbered: true }), '首帧 · 第 1 版.png');
  assert.equal(allocateReadableName(['首帧 · 第 1 版.png'], '首帧.png', 'ccc', () => 'bbb', { numbered: true }), '首帧 · 第 2 版.png');
  assert.equal(allocateReadableName(['首帧 · 第 1 版.png'], '首帧.png', 'aaa', () => 'aaa', { numbered: true }), '首帧 · 第 1 版.png');
});

test('readable video versions are counted inside the directory that is asked', () => {
  const occupied = allocateReadableName(['镜头.mov'], '镜头.mov', 'aaa', () => 'bbb');
  assert.equal(occupied, '镜头 · 第 2 版.mov');
  assert.equal(allocateReadableName([], '镜头.mov', 'aaa', () => 'bbb'), '镜头.mov');
  assert.equal(allocateReadableName(['镜头.mov'], '镜头.mov', 'aaa', () => 'aaa'), '镜头.mov');
});

test('an exclusive legacy file moves into the project folder and a shared file is copied', (t) => {
  const root = temporary(t);
  const assetRoot = path.join(root, 'assets');
  const bytes = 'exclusive-pixels';
  const digest = checksum(bytes);
  fs.mkdirSync(path.join(assetRoot, 'image'), { recursive: true });
  fs.writeFileSync(path.join(assetRoot, 'image', 'abc.png'), bytes);
  const project = {
    id: 'p1', name: '3221321',
    assets: [{ id: 'a', relativePath: 'image/abc.png', checksum: digest, url: 'lianhua-asset://local/image/abc.png',
      sourceRelativePath: 'image/abc.png' }],
  };
  const exclusive = placeProjectAssets({ project, projects: [project] }, { assetRoot, dataRoot: root, fs, deferDeletes: true });
  assert.equal(exclusive.state.project.assets[0].relativePath, 'projects/3221321/image/abc.png');
  assert.equal(exclusive.state.project.assets[0].sourceRelativePath, 'projects/3221321/image/abc.png');
  assert.equal(exclusive.state.project.assets[0].url, 'lianhua-asset://local/projects/3221321/image/abc.png');
  assert.equal(fs.readFileSync(path.join(assetRoot, 'projects', '3221321', 'image', 'abc.png'), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(assetRoot, 'image', 'abc.png')), true);
  assert.equal(exclusive.deletes.length, 1);

  fs.writeFileSync(path.join(assetRoot, 'image', 'shared.png'), 'shared');
  fs.mkdirSync(path.join(root, 'project-library'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-library', 'other.json'), JSON.stringify({
    id: 'p2', name: '另一项目', assets: [{ relativePath: 'image/shared.png' }],
  }));
  const sharedProject = {
    id: 'p1', name: '3221321',
    assets: [{ relativePath: 'image/shared.png', checksum: checksum('shared') }],
  };
  const shared = placeProjectAssets({ project: sharedProject, projects: [sharedProject] }, { assetRoot, dataRoot: root, fs, deferDeletes: false });
  assert.equal(shared.state.project.assets[0].relativePath, 'projects/3221321/image/shared.png');
  assert.equal(fs.readFileSync(path.join(assetRoot, 'image', 'shared.png'), 'utf8'), 'shared');
  assert.equal(fs.readFileSync(path.join(assetRoot, 'projects', '3221321', 'image', 'shared.png'), 'utf8'), 'shared');
});

test('a missing file and a file already in the project folder keep their places', (t) => {
  const root = temporary(t);
  const assetRoot = path.join(root, 'assets');
  const kept = path.join(assetRoot, 'projects', '3221321', 'video', '镜头.mov');
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, 'video');
  const project = {
    id: 'p1', name: '3221321',
    assets: [
      { relativePath: 'image/missing.png', checksum: 'a'.repeat(64) },
      { relativePath: 'projects/3221321/video/镜头.mov', checksum: checksum('video') },
    ],
  };
  const placed = placeProjectAssets({ project, projects: [project] }, { assetRoot, dataRoot: root, fs, deferDeletes: false });
  assert.equal(placed.state.project.assets[0].relativePath, 'image/missing.png');
  assert.equal(placed.state.project.assets[1].relativePath, 'projects/3221321/video/镜头.mov');
  assert.equal(placed.moves.length, 0);
  assert.equal(fs.readFileSync(kept, 'utf8'), 'video');
  assert.equal(fs.existsSync(path.join(assetRoot, 'image', 'missing.png')), false);
});

test('a checksum image already in the project folder takes the asset name and version', (t) => {
  const root = temporary(t);
  const assetRoot = path.join(root, 'assets');
  const digest = 'ab'.repeat(32);
  const source = path.join(assetRoot, 'projects', '韩立6464', 'image', `${digest}.png`);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'pixels');
  const project = {
    id: 'p1', name: '韩立6464',
    assets: [{
      id: 'frame', name: '后山上行与石亭前落 · 第 1 段 · 首帧',
      relativePath: `projects/韩立6464/image/${digest}.png`, checksum: checksum('pixels'),
      url: `lianhua-asset://local/projects/韩立6464/image/${digest}.png`,
    }],
  };
  const placed = placeProjectAssets({ project, projects: [project] }, { assetRoot, dataRoot: root, fs, deferDeletes: false });
  const relative = 'projects/韩立6464/image/后山上行与石亭前落 · 第 1 段 · 首帧 · 第 1 版.png';
  assert.equal(placed.state.project.assets[0].relativePath, relative);
  assert.equal(fs.readFileSync(path.join(assetRoot, ...relative.split('/')), 'utf8'), 'pixels');
  assert.equal(fs.existsSync(source), false);
});

test('renaming a project renames only that project folder', (t) => {
  const root = temporary(t);
  const assetRoot = path.join(root, 'assets');
  const source = path.join(assetRoot, 'projects', '旧名字', 'video', '镜头.mov');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'clip');
  const project = {
    id: 'p1', name: '新名字',
    assets: [{ relativePath: 'projects/旧名字/video/镜头.mov', checksum: checksum('clip') }],
  };
  const placed = placeProjectAssets({ project, projects: [project] }, { assetRoot, dataRoot: root, fs, deferDeletes: false });
  assert.equal(placed.state.project.assets[0].relativePath, 'projects/新名字/video/镜头.mov');
  assert.equal(fs.readFileSync(path.join(assetRoot, 'projects', '新名字', 'video', '镜头.mov'), 'utf8'), 'clip');
  assert.equal(fs.existsSync(source), false);
});
