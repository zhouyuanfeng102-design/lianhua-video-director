import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { ReferenceImageName } from '../src/components/ReferenceImageName';
import type { StoryboardImageToImagePanelProps } from '../src/components/StoryboardImageToImagePanel';
import { assetPreviewUrl } from '../src/media';
import { isUsableStoryboardReferenceAsset } from '../src/storyboardImages';
import type { ReferenceAsset, Storyboard, StoryboardImageToImageSettings } from '../src/types';

// Load the actual component with only its stylesheet ignored by the Node test.
// Callback tests substitute hook storage, not the production selection logic.
const source = readFileSync(new URL('../src/components/StoryboardImageToImagePanel.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/storyboardImageToImage.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const loadPanel = (fakeHooks: boolean, initialHookValues: readonly unknown[] = []) => {
  let hookCursor = 0;
  const output = { exports: {} as { StoryboardImageToImagePanel: (props: StoryboardImageToImagePanelProps) => ReactElement } };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name.endsWith('.css')) return {};
    if (name === '../media') return { assetPreviewUrl };
    if (name === '../storyboardImages') return { isUsableStoryboardReferenceAsset };
    if (name === './ReferenceImageName') return { ReferenceImageName };
    if (name === 'react' && fakeHooks) return {
      useId: () => 'panel-test',
      useMemo: (factory: () => unknown) => factory(),
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initialHookValues[hookCursor++] ?? initial, () => undefined],
    };
    return require(name);
  }, output, output.exports);
  return (props: StoryboardImageToImagePanelProps) => {
    hookCursor = 0;
    return output.exports.StoryboardImageToImagePanel(props);
  };
};

const image = (id: string, overrides: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'reference', role: 'character', mediaType: 'image',
  dataUrl: 'data:image/png;base64,aGVsbG8=', tags: [], createdAt: 1, updatedAt: 1, ...overrides,
});
const longName = '山门出发与灵鹤桥行进 · 人物原始形态参考 · 第 23 段 · 第 19 镜';
const assets = [
  image('first', { name: longName }), image('second', { fileName: 'camera-file.png' }), image('third', { tags: ['场景-晨雾'] }),
  image('private', { name: '不应出现在普通选择器', referenceScope: 'nsfw-private-profile' }),
  image('missing', { name: '文件缺失', missing: true }),
  image('not-image', { name: '不是图片', mediaType: 'video', type: 'video' }),
];
const storyboard = {
  id: 'board-segment-2', segmentIndex: 2,
  shots: [1, 2, 3, 4].map((index) => ({
    id: `shot-${index}`, index, startSec: (index - 1) * 3, endSec: index * 3,
    purpose: `镜头${index}目的`, subject: '', action: `镜头${index}动作`,
  })),
} as Storyboard;
const settings: StoryboardImageToImageSettings = {
  referenceAssetIds: ['first', 'second'], selectedShotIds: ['shot-2', 'shot-4'],
  referenceAssetIdsByShotId: { 'shot-1': ['third'], 'shot-2': ['third'] },
};
const baseProps: StoryboardImageToImagePanelProps = {
  storyboard, assets, settings, onChange: () => undefined, onUpload: () => undefined,
};

const Panel = loadPanel(false);
const html = renderToStaticMarkup(createElement(Panel, baseProps));
assert.ok(html.includes(longName), 'the complete reference name, including segment/shot suffix, stays visible');
assert.ok(html.includes('第 2 段'));
assert.ok(html.includes('已选 2 张'));
assert.ok(html.includes('本段参考图'));
assert.ok(html.includes('默认或自定义数量的每张图片都使用当前所选原图'));
assert.ok(html.includes('“提示词结果”使用原来的生图按钮'));
assert.ok(html.includes('不影响 H3 提示词及视频槽位'));
assert.ok(html.includes('支持多张，不必选满'));
assert.doesNotMatch(html, /选择目标分镜|应用参考图|全选分镜|清空勾选|清除绑定|所选分镜|镜头2目的|storyboard-i2i-generate/,
  'the reference column must not introduce shot selection, per-shot binding or a second generation action');
assert.equal((html.match(/<button\b/gu) || []).length, 2, 'only upload and clear-selection actions belong to the healthy reference panel');
assert.ok(html.includes('type="file"') && html.includes('multiple=""'), 'local upload supports multiple original files');
assert.ok(!html.includes('不应出现在普通选择器') && !html.includes('文件缺失') && !html.includes('不是图片'), 'ordinary picker preserves existing reference scope and media restrictions');

type Element = ReactElement<Record<string, unknown>>;
const elements = (node: ReactNode): Element[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
};
const visibleText = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(visibleText).join('');
  if (node && typeof node === 'object' && 'props' in node) return visibleText((node as Element).props.children as ReactNode);
  return node == null || typeof node === 'boolean' ? '' : String(node);
};
const CallbackPanel = loadPanel(true);
let changed: StoryboardImageToImageSettings | undefined;
let currentSettings = settings;
const tree = () => CallbackPanel({ ...baseProps, settings: currentSettings, onChange: (next) => { changed = next; currentSettings = next; } });
const click = (label: string) => {
  const button = elements(tree()).find((element) => element.type === 'button' && visibleText(element.props.children as ReactNode) === label);
  assert.ok(button, `missing action: ${label}`);
  (button.props.onClick as () => void)();
};

const toggle = (name: string) => {
  const checkbox = elements(tree()).find((element) => element.props['aria-label'] === `选择参考图：${name}`);
  assert.ok(checkbox, `missing reference checkbox: ${name}`);
  (checkbox.props.onChange as () => void)();
};
toggle(longName);
assert.deepEqual(changed?.referenceAssetIds, ['second']);
assert.deepEqual(changed?.referenceAssetIdsByShotId, settings.referenceAssetIdsByShotId, 'changing the current segment references must not rewrite historical per-shot settings');
assert.deepEqual(changed?.selectedShotIds, settings.selectedShotIds);
toggle('third');
assert.deepEqual(changed?.referenceAssetIds, ['second', 'third'], 'adding a different image keeps the surviving selection in order');
toggle(longName);
assert.deepEqual(changed?.referenceAssetIds, ['second', 'third', 'first']);
assert.deepEqual(settings.referenceAssetIds, ['first', 'second'], 'selection changes must not mutate the render snapshot');
click('清空选图');
assert.deepEqual(changed?.referenceAssetIds, []);
assert.deepEqual(changed?.referenceAssetIdsByShotId, settings.referenceAssetIdsByShotId);
assert.deepEqual(changed?.selectedShotIds, settings.selectedShotIds);
assert.deepEqual(settings.referenceAssetIdsByShotId, { 'shot-1': ['third'], 'shot-2': ['third'] });

const noSelection = renderToStaticMarkup(createElement(Panel, { ...baseProps, settings: { ...settings, selectedShotIds: [] } }));
assert.equal(noSelection, html, 'legacy shot selection must not change the segment-wide reference picker');
const noReferences = renderToStaticMarkup(createElement(Panel, { ...baseProps, settings: { referenceAssetIds: [], selectedShotIds: ['shot-4'], referenceAssetIdsByShotId: {} } }));
assert.ok(noReferences.includes('已选 0 张'), 'an empty optional reference selection remains valid');
assert.doesNotMatch(noReferences, /role="alert"|请先选择|必须选满/);

const busyElements = elements(CallbackPanel({ ...baseProps, busy: true }));
assert.ok(busyElements.find((element) => element.type === 'input' && element.props.type === 'file')?.props.disabled,
  'busy only prevents starting another upload');
assert.ok(busyElements.filter((element) => element.props.type === 'checkbox').every((element) => !element.props.disabled),
  'queued generation must not lock reference selection for the next request');
assert.equal(busyElements.find((element) => element.type === 'button' && visibleText(element.props.children as ReactNode) === '清空选图')?.props.disabled, false);

for (const [query, expectedName] of [[longName, longName], ['CAMERA-FILE', 'second'], ['晨雾', 'third']]) {
  const searchPanel = loadPanel(true, [query]);
  const checkboxes = elements(searchPanel(baseProps)).filter((element) => element.props.type === 'checkbox');
  assert.deepEqual(checkboxes.map((element) => element.props['aria-label']), [`选择参考图：${expectedName}`], 'search covers the complete name, file name and tags');
}
const noMatches = renderToStaticMarkup(loadPanel(true, ['does-not-exist'])(baseProps));
assert.ok(noMatches.includes('没有匹配图片'));
const noAssets = renderToStaticMarkup(createElement(Panel, { ...baseProps, assets: [], settings: { ...settings, referenceAssetIds: [] } }));
assert.ok(noAssets.includes('暂无可用参考图'));

currentSettings = { ...settings, referenceAssetIds: ['first', 'missing', 'second'] };
click('取消不可用图片');
assert.deepEqual(changed?.referenceAssetIds, ['first', 'second'], 'removing an unavailable image preserves other selected originals');

const uploaded: File[] = [];
const uploadElements = elements(CallbackPanel({ ...baseProps, onUpload: (file) => { uploaded.push(file); } }));
const uploadInput = uploadElements.find((element) => element.type === 'input' && element.props.type === 'file');
assert.ok(uploadInput);
const files = [new File(['original-one'], 'one.png', { type: 'image/png' }), new File(['original-two'], 'two.webp', { type: 'image/webp' })];
const uploadEvent = { currentTarget: { files, value: 'one.png' } };
(uploadInput.props.onChange as (event: typeof uploadEvent) => void)(uploadEvent);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(uploaded, files, 'multi-upload forwards each untouched source file');
assert.equal(uploadEvent.currentTarget.value, '', 'the same file can be selected again after upload');

assert.match(source, /assets\.filter\(isUsableStoryboardReferenceAsset\)/);
assert.doesNotMatch(source, /finalPrompt\s*:|officialPromptZh\s*:|globalReferenceAssetIds\s*:|inputMode\s*:/, 'image binding UI does not write video prompt/input fields');
assert.doesNotMatch(source, /onGenerate|selectedShotIds|referenceAssetIdsByShotId/, 'this panel only edits current reference IDs, never a second shot/generation workflow');
assert.match(css, /\.storyboard-i2i-panel\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/);
assert.match(css, /\.storyboard-i2i-asset-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
assert.match(css, /\.storyboard-i2i-thumb img\s*\{[^}]*object-fit:\s*contain;/, 'reference previews preserve original aspect ratio');
assert.doesNotMatch(css, /text-overflow:\s*ellipsis|line-clamp/);
assert.match(css, /@container \(max-width: 290px\)/, 'narrow panels rearrange internally without overlapping');
assert.doesNotMatch(css, /storyboard-i2i-shot|storyboard-i2i-apply|storyboard-i2i-generate/, 'retired shot workflow styles are removed as well');

console.log('Storyboard reference-only panel: full names, optional selection, stable cancellation, search, upload, original generation entry and ordinary scope checks passed.');
