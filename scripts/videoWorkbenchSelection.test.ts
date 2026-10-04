import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import {
  appendWorkbenchVideoSelection, emptyVideoWorkbenchDraft, normalizeWorkbenchVideoSelection,
  orderedWorkbenchSelection, selectableWorkbenchVideo, selectWorkbenchVideoResults,
  type VideoWorkbenchDraft, type WorkbenchVideoSelection,
} from '../src/videoWorkbench';
import type { ReferenceAsset } from '../src/types';

const video = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'video', mediaType: 'video', role: 'motion', tags: [],
  relativePath: `video/${id}.mp4`, checksum: id.repeat(64).slice(0, 64), createdAt: 1, updatedAt: 1, ...patch,
});
const assets = () => [video('newest'), video('middle'), video('oldest')];
const selected = (assetIds = ['newest', 'middle', 'oldest']): WorkbenchVideoSelection => ({ projectId: 'project-a', assetIds });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
};
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

test('only locally saved non-missing videos are selectable; unknown duration is allowed until probing', () => {
  assert.equal(selectableWorkbenchVideo(video('valid')), true);
  for (const asset of [video('missing', { missing: true }), video('remote', { relativePath: undefined, url: 'https://example.test/video.mp4' }),
    video('blank', { relativePath: ' ' }), video('audio', { type: 'audio', mediaType: 'audio', mimeType: 'audio/mp3' })]) {
    assert.equal(selectableWorkbenchVideo(asset), false);
  }
});

test('selection survives pagination/filtering but removes deleted/missing items and foreign project ids', () => {
  const original = selected(['oldest', 'newest', 'oldest', 'deleted']); const before = JSON.stringify(original);
  assert.deepEqual(normalizeWorkbenchVideoSelection(original, 'project-a', [video('newest'), video('oldest', { missing: true })]).assetIds, ['newest']);
  assert.deepEqual(normalizeWorkbenchVideoSelection(original, 'project-b', assets()), { projectId: 'project-b', assetIds: [] });
  assert.equal(JSON.stringify(original), before);
  const stable = selected(); assert.equal(normalizeWorkbenchVideoSelection(stable, 'project-a', assets()), stable);
});

test('select-all covers every filtered page and deselect-all retains choices outside that filter', () => {
  const collection = Array.from({ length: 35 }, (_, index) => video(`video-${index}`));
  collection.push(video('invalid', { missing: true }));
  const filteredIds = collection.slice(0, 30).map((asset) => asset.id).concat('invalid');
  const result = selectWorkbenchVideoResults(selected(['video-34']), 'project-a', collection, filteredIds, true);
  assert.equal(result.assetIds.length, 31); assert.ok(result.assetIds.includes('video-29')); assert.ok(!result.assetIds.includes('invalid'));
  assert.deepEqual(selectWorkbenchVideoResults(result, 'project-a', collection, filteredIds, false).assetIds, ['video-34']);
});

test('append order is the full source-list order, not checkbox-click order or current page', () => {
  assert.deepEqual(orderedWorkbenchSelection(selected(['oldest', 'newest', 'middle']), 'project-a', assets()), ['newest', 'middle', 'oldest']);
  assert.deepEqual(orderedWorkbenchSelection(selected(), 'project-b', assets()), []);
});

test('per-asset appends are sequential, deduplicated within one click and preserve partial success', async () => {
  const calls: string[] = []; let active = 0; let peak = 0; const timeline = ['existing'];
  const result = await appendWorkbenchVideoSelection({ assetIds: ['newest', 'middle', 'newest', 'oldest'], getAssets: assets, isCurrent: () => true,
    addAsset: async (id) => { active += 1; peak = Math.max(peak, active); calls.push(id); await Promise.resolve(); active -= 1;
      if (id === 'middle') throw new Error('无法解码'); timeline.push(id); } });
  assert.equal(peak, 1); assert.deepEqual(calls, ['newest', 'middle', 'oldest']);
  assert.deepEqual(timeline, ['existing', 'newest', 'oldest']); assert.deepEqual(result.addedIds, ['newest', 'oldest']);
  assert.deepEqual(result.failed, [{ assetId: 'middle', name: 'middle', message: '无法解码' }]); assert.deepEqual(result.unattemptedIds, []);
});

test('a later deleted/missing source is reported rather than appended', async () => {
  let collection = assets(); const calls: string[] = [];
  const result = await appendWorkbenchVideoSelection({ assetIds: selected().assetIds, getAssets: () => collection, isCurrent: () => true,
    addAsset: async (id) => { calls.push(id); if (id === 'newest') collection = collection.filter((asset) => asset.id !== 'middle'); } });
  assert.deepEqual(calls, ['newest', 'oldest']); assert.equal(result.failed[0].assetId, 'middle');
});

test('project/draft scope change stops remaining additions while retaining the already completed result', async () => {
  const gate = deferred(); let current = true; const calls: string[] = [];
  const pending = appendWorkbenchVideoSelection({ assetIds: selected().assetIds, getAssets: assets, isCurrent: () => current,
    addAsset: async (id) => { calls.push(id); await gate.promise; } });
  current = false; gate.resolve(); const result = await pending;
  assert.deepEqual(calls, ['newest']); assert.deepEqual(result.addedIds, ['newest']);
  assert.deepEqual(result.unattemptedIds, ['middle', 'oldest']); assert.equal(result.cancelled, true);
});

test('cancelled current item and all remaining items stay unattempted for retry', async () => {
  const result = await appendWorkbenchVideoSelection({ assetIds: selected().assetIds, getAssets: assets, isCurrent: () => true,
    addAsset: async (id) => { if (id === 'middle') throw Object.assign(new Error('取消'), { name: 'AbortError' }); } });
  assert.deepEqual(result.addedIds, ['newest']); assert.deepEqual(result.unattemptedIds, ['middle', 'oldest']);
  assert.deepEqual(result.failed, []); assert.equal(result.cancelled, true);
});

// Exercise the production UI transaction in memory. No browser, user data or
// remote processing is used. This catches same-render double-clicks and stale
// completion handlers, which pure selection functions alone cannot cover.
const source = readFileSync(new URL('../src/components/VideoWorkbenchView.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('VideoWorkbenchView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const view = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'VideoWorkbenchView');
const transaction = view?.body?.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((entry) => entry.name.getText(parsed) === 'addVideoSources'));
assert.ok(transaction);
const compiled = ts.transpileModule(transaction.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const transactionHarness = (operation: (id: string) => Promise<void> = async () => {}) => {
  const project = { id: 'project-a', assets: assets() };
  const scope = { projectId: project.id }; const projectScope = { current: scope };
  const addingRun: { current?: { scope: { projectId: string }; cancelled: boolean } } = {};
  const currentProject = { current: project }; const mountedRef = { current: true };
  const draft = emptyVideoWorkbenchDraft(project.id, 1); const currentDraftId = { current: draft.id };
  let selection = selected(); let notice = ''; let error = ''; let progress: unknown;
  let timeline: VideoWorkbenchDraft['clips'] = [{ id: 'existing-clip', sourceAssetId: 'existing', inSec: 0, outSec: 1, volume: 1, transitionAfter: { type: 'cut', durationSec: .3 } }];
  const calls: string[] = [];
  const dependencies = {
    addingRun, busy: false, available: true, projectScope, currentDraftId, mountedRef, currentProject, project, draft,
    setAddingSources: (value: unknown) => { progress = value; },
    setLocalError: (value: string) => { error = value; }, setLocalNotice: (value: string) => { notice = value; },
    setVideoSelection: (update: (selection: WorkbenchVideoSelection) => WorkbenchVideoSelection) => { selection = update(selection); },
    appendWorkbenchVideoSelection, normalizeWorkbenchVideoSelection,
    controller: { addAssets: async ([id]: string[]) => { calls.push(id); await operation(id);
      timeline = [...timeline, { id: `clip-${calls.length}`, sourceAssetId: id, inSec: 0, outSec: 1, volume: 1, transitionAfter: { type: 'cut', durationSec: .3 } }]; } },
  };
  const add = new Function(...Object.keys(dependencies), `${compiled}\nreturn addVideoSources;`)(...Object.values(dependencies)) as (ids: string[], clearSelection: boolean) => Promise<void>;
  return { add, calls, addingRun, currentProject, projectScope, currentDraftId, mountedRef,
    snapshot: () => ({ selection, notice, error, progress, timeline }), setSelection: (value: WorkbenchVideoSelection) => { selection = value; } };
};

test('actual UI transaction rejects same-render double clicks without losing pre-existing timeline clips', async () => {
  const gate = deferred(); const harness = transactionHarness(async () => gate.promise);
  const first = harness.add(selected().assetIds, true); const duplicate = harness.add(selected().assetIds, true);
  await flush(); assert.deepEqual(harness.calls, ['newest']); gate.resolve(); await Promise.all([first, duplicate]);
  assert.deepEqual(harness.calls, selected().assetIds); assert.deepEqual(harness.snapshot().timeline.map((clip) => clip.sourceAssetId), ['existing', ...selected().assetIds]);
  assert.deepEqual(harness.snapshot().selection.assetIds, []); assert.equal(harness.addingRun.current, undefined);
});

test('actual partial-failure feedback retains only failed choices and retry never duplicates successful clips', async () => {
  let shouldFail = true; const harness = transactionHarness(async (id) => { if (id === 'middle' && shouldFail) throw new Error('解码失败'); });
  await harness.add(selected().assetIds, true);
  assert.deepEqual(harness.snapshot().selection.assetIds, ['middle']); assert.match(harness.snapshot().error, /已添加 2 \/ 3/u);
  assert.match(harness.snapshot().error, /失败 1 个/u); assert.match(harness.snapshot().error, /middle：解码失败/u);
  shouldFail = false; await harness.add(harness.snapshot().selection.assetIds, true);
  assert.deepEqual(harness.calls, ['newest', 'middle', 'oldest', 'middle']);
  assert.deepEqual(harness.snapshot().timeline.map((clip) => clip.sourceAssetId), ['existing', 'newest', 'oldest', 'middle']);
  assert.deepEqual(harness.snapshot().selection.assetIds, []);
});

test('single plus addition does not toggle checked selection', async () => {
  const harness = transactionHarness(); await harness.add(['middle'], false);
  assert.deepEqual(harness.snapshot().selection.assetIds, selected().assetIds); assert.deepEqual(harness.calls, ['middle']);
});

test('late old-project completion cannot clear a new project selection or continue adding there', async () => {
  const gate = deferred(); const harness = transactionHarness(async () => gate.promise);
  const pending = harness.add(selected().assetIds, true);
  harness.projectScope.current = { projectId: 'project-b' };
  harness.currentProject.current = { id: 'project-b', assets: [video('b')] }; harness.setSelection({ projectId: 'project-b', assetIds: ['b'] });
  gate.resolve(); await pending;
  assert.deepEqual(harness.calls, ['newest']); assert.deepEqual(harness.snapshot().selection, { projectId: 'project-b', assetIds: ['b'] });
  assert.equal(harness.snapshot().notice, ''); assert.equal(harness.snapshot().error, '');
});

test('same-project draft change aborts the remainder and retains unadded choices', async () => {
  const gate = deferred(); const harness = transactionHarness(async () => gate.promise);
  const pending = harness.add(selected().assetIds, true); harness.currentDraftId.current = 'different-draft'; gate.resolve(); await pending;
  assert.deepEqual(harness.calls, ['newest']); assert.deepEqual(harness.snapshot().selection.assetIds, ['middle', 'oldest']);
  assert.match(harness.snapshot().notice, /剩余 2 个未处理/u);
});

test('checkbox/preview/plus are sibling controls and all-select uses the complete filter', () => {
  assert.match(source, /className="vwb-source-check"[^\n]*onChange=[^\n]*selectWorkbenchVideoResults/u);
  const checkbox = source.split('\n').find((line) => line.includes('className="vwb-source-check"'))!;
  assert.doesNotMatch(checkbox, /chooseSource|addVideoSources|controller\.addAssets/u);
  assert.match(source, /selectWorkbenchVideoResults\(selection, project\.id, videos, filteredVideos\.map/u);
  assert.match(source, /addVideoSources\(\[asset\.id\], false\)/u);
  assert.match(source, /const busy = engineBusy \|\| Boolean\(addingSources\)/u);
  assert.match(source, /addingRun\.current\) addingRun\.current\.cancelled = true; void runAction\(controller\.cancel\)/u);
});

const outputDeclaration = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'WorkbenchOutputSettings');
assert.ok(outputDeclaration);
const outputCompiled = ts.transpileModule(outputDeclaration.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
type ElementProps = { children?: React.ReactNode; 'aria-label'?: string; type?: string; disabled?: boolean; onChange?: (event: { target: { value: string; checked?: boolean } }) => void };
const OutputSettings = new Function('React', 'Music2', `${outputCompiled}\nreturn WorkbenchOutputSettings;`)(React, () => null) as (props: {
  draft: VideoWorkbenchDraft; controller: { updateDraft: (update: (current: VideoWorkbenchDraft) => VideoWorkbenchDraft) => void };
  busy: boolean; audioAssets: ReferenceAsset[]; onOpenAssets: () => void; onHelp: () => void;
}) => React.ReactElement<ElementProps>;
const elements = (value: React.ReactNode): React.ReactElement<ElementProps>[] => {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement<ElementProps>(value)) return [];
  return [value, ...elements(value.props.children)];
};
const labelText = (value: React.ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(labelText).join('') : React.isValidElement<ElementProps>(value) ? labelText(value.props.children) : '';
const outputFixture = (busy = false) => {
  let draft = emptyVideoWorkbenchDraft('project-a', 1); draft.audio.bgmAssetId = 'audio-a'; draft.audio.bgmChecksum = 'old-checksum';
  const beforeClips: VideoWorkbenchDraft['clips'] = [{ id: 'existing', sourceAssetId: 'existing', inSec: 0, outSec: 2, volume: 1, transitionAfter: { type: 'cut', durationSec: .3 } }];
  draft.clips = beforeClips;
  const tree = OutputSettings({ draft, controller: { updateDraft: (update) => { draft = update(draft); } }, busy,
    audioAssets: [video('audio-a', { type: 'audio', mediaType: 'audio' }), video('audio-b', { type: 'audio', mediaType: 'audio' }),
      video('missing-audio', { type: 'audio', mediaType: 'audio', missing: true })], onOpenAssets: () => {}, onHelp: () => {} });
  const all = elements(tree);
  const field = (name: string) => all.find((element) => ['input', 'select'].includes(String(element.type)) && element.props['aria-label'] === name)
    || all.filter((element) => element.type === 'label').flatMap((label) => labelText(label.props.children).startsWith(name)
      ? elements(label.props.children).filter((element) => ['input', 'select'].includes(String(element.type))) : [])[0];
  return { tree, all, field, snapshot: () => draft, beforeClips };
};

test('inline output component retains every output/audio/fade control without another tab', () => {
  const output = outputFixture(); const markup = renderToStaticMarkup(output.tree);
  assert.match(markup, /aria-label="输出与声音"/u);
  for (const name of ['输出文件名', '输出尺寸', '帧率', '画面淡入（秒）', '画面淡出（秒）', '背景音乐', 'BGM 音量（原始音量的 %）', '声音淡入（秒）', '声音淡出（秒）']) {
    assert.ok(output.field(name), `${name} must remain available inline`);
  }
  assert.ok(output.all.some((element) => element.type === 'input' && element.props.type === 'checkbox'));
  assert.match(markup, /value="missing-audio" disabled/u);
});

test('inline output edits use functional updates, retaining clips and unrelated simultaneous settings', () => {
  const output = outputFixture();
  for (const [name, value] of [['输出文件名', '完成片'], ['输出尺寸', '1080x1920'], ['帧率', '24'], ['画面淡入（秒）', '0.2'],
    ['画面淡出（秒）', '0.3'], ['背景音乐', 'audio-b'], ['BGM 音量（原始音量的 %）', '12'], ['声音淡入（秒）', '0.4'], ['声音淡出（秒）', '0.5']]) {
    output.field(name)!.props.onChange!({ target: { value } });
  }
  output.all.find((element) => element.type === 'input' && element.props.type === 'checkbox')!.props.onChange!({ target: { value: '', checked: false } });
  assert.deepEqual(output.snapshot().clips, output.beforeClips);
  assert.deepEqual(output.snapshot().output, { fileName: '完成片', width: 1080, height: 1920, fps: 24, fadeInSec: .2, fadeOutSec: .3 });
  assert.deepEqual(output.snapshot().audio, { bgmAssetId: 'audio-b', bgmChecksum: undefined, bgmVolume: .12, ducking: false, fadeInSec: .4, fadeOutSec: .5 });
});

test('inline output inputs remain disabled during an active add/processing operation', () => {
  const fields = outputFixture(true).all.filter((element) => ['input', 'select'].includes(String(element.type)));
  assert.equal(fields.length, 10); assert.ok(fields.every((element) => element.props.disabled));
});
