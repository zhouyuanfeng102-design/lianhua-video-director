import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const viteEnvSource = fs.readFileSync(path.join(root, 'src', 'vite-env.d.ts'), 'utf8');
const imagePreviewSource = fs.readFileSync(path.join(root, 'src', 'components', 'AssetImagePreview.tsx'), 'utf8');

test('asset cards expose image viewing and saving affordances', () => {
  assert.match(appSource, /查看/u, 'asset cards should expose a visible view action');
  assert.match(appSource, /保存图片/u, 'asset preview should expose a save button');
  assert.match(appSource, /assetPreviewModal|asset-preview-modal|previewAsset/u, 'asset preview modal state or markup should exist');
  assert.match(appSource, /asset-preview-trigger/u, 'clicking an image thumbnail should open the large preview');
  assert.match(appSource, /原文件缺失.*查看.*保存/u, 'missing assets should explain that preview/save are unavailable');
});

test('desktop bridge exposes a dedicated saveMedia IPC for media export', () => {
  assert.match(preloadSource, /saveMedia:/u, 'preload should forward a saveMedia bridge');
  assert.match(viteEnvSource, /saveMedia:/u, 'renderer types should declare saveMedia');
  assert.match(mainSource, /lianhua:save-media/u, 'main process should implement the save-media IPC');
  assert.match(mainSource, /showSaveDialog/u, 'save-media should let the user choose a destination path');
});

test('asset image preview exposes display-only accessible zoom controls', () => {
  assert.match(appSource, /<AssetImagePreview\s+key=/u, 'each opened asset gets fresh preview state');
  for (const label of ['缩小图片', '放大图片', '还原图片缩放', '图片缩放比例']) {
    assert.ok(imagePreviewSource.includes(`aria-label="${label}"`), `${label} has an accessible label`);
  }
  assert.match(imagePreviewSource, /ResizeObserver/u, 'fit size follows the available preview viewport');
  assert.match(imagePreviewSource, /naturalWidth/u, 'image sizing uses the original aspect ratio');
  assert.match(imagePreviewSource, /<img src=\{src\}/u, 'zoom continues to use the original image URL');
  assert.doesNotMatch(imagePreviewSource, /toDataURL|saveMedia|createElement\(['"]canvas/u, 'zoom must not resample or save a modified image');
});
