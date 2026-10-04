import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import * as tails from '../src/videoTailReference';
import * as tailCharacters from '../src/videoTailCharacters';
import * as h3ReferenceBinding from '../src/videoH3ReferenceBinding';
import * as referenceUsage from '../src/videoReferenceUsage';
import * as referenceSlots from '../src/videoReferenceSlots';
import * as batch from '../src/videoBatch';
import * as batchSelection from '../src/videoBatchSelection';
import * as drafts from '../src/videoDirectorDraft';
import * as output from '../src/videoOutputParameters';
import * as sources from '../src/videoGenerationSource';
import * as runningHub from '../src/runningHubVideo';
import * as provenance from '../src/videoProvenance';
import * as directorReferences from '../src/videoDirectorReferences';
import * as errorDiagnostics from '../src/errorDiagnostics';
import * as videoTaskErrorDiagnostics from '../src/videoTaskErrorDiagnostics';
import { createInitialState } from '../src/storage';
import type { Project, ReferenceAsset, ReferenceRole, Storyboard, VideoGenerationTask, VideoSequencePlan } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDraft, VideoImageReference } from '../src/videoGenerationTypes';
import type { TailFrameSelectionResult, TailFrameTools } from '../src/components/PreviousVideoTailDialog';

interface Props { children?: React.ReactNode; [key: string]: any }
type Node = React.ReactElement<Props>;
interface Slot { value?: any; deps?: readonly unknown[]; cleanup?: () => void }
const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => Boolean(left && right && left.length === right.length && left.every((entry, index) => Object.is(entry, right[index])));
const textOf = (node: React.ReactNode): string => node == null || typeof node === 'boolean' ? ''
  : typeof node === 'string' || typeof node === 'number' ? String(node)
    : Array.isArray(node) ? node.map(textOf).join('') : React.isValidElement<Props>(node) ? textOf(node.props.children) : '';
const nodesOf = (node: React.ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodesOf)
  : React.isValidElement<Props>(node) ? [node, ...nodesOf(node.props.children)] : [];
const find = (tree: React.ReactNode, label: string): Node => {
  const node = nodesOf(tree).find((entry) => entry.props['aria-label'] === label);
  assert.ok(node, `missing control: ${label}`); return node;
};
const button = (tree: React.ReactNode, label: string): Node => {
  const node = nodesOf(tree).find((entry) => entry.type === 'button' && textOf(entry) === label);
  assert.ok(node, `missing button: ${label}`); return node;
};
const componentNode = (tree: React.ReactNode, name: string): Node => {
  const node = nodesOf(tree).find((entry) => typeof entry.type === 'function' && entry.type.name === name);
  assert.ok(node, `missing component: ${name}`); return node;
};

// Execute real component callbacks with deterministic hooks; never mount a real
// project or make a paid request. Browser QA independently verifies geometry.
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
const originalFetch = globalThis.fetch;
const networkRequests: string[] = [];
globalThis.fetch = async (input) => { networkRequests.push(String(input)); throw new Error('Local reference controls must not request text, vision or video APIs'); };
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  activeElement: undefined, addEventListener: () => {}, removeEventListener: () => {}, querySelectorAll: () => [],
} });
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} });

function harness(file: 'PreviousVideoTailDialog' | 'VideoDirectorView', component: string, initialProps: Props) {
  let props = { ...initialProps }; let cursor = 0; let dirty = true; let effects: Array<() => void> = [];
  const slots: Slot[] = [];
  const hooks = {
    useState: (initial: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next: any) => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }]; },
    useRef: (initial: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: initial } }; return slots[index].value; },
    useMemo: (run: () => unknown, deps?: readonly unknown[]) => { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: run(), deps }; return slots[index].value; },
    useEffect: (run: () => (() => void) | void, deps?: readonly unknown[]) => { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) { const previous = slots[index]; slots[index] = { ...previous, deps }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = run() || undefined; }); } },
  };
  const modules: Record<string, unknown> = {
    '../videoH3ReferenceBinding': h3ReferenceBinding,
    react: { ...React, ...hooks }, '../media': { assetPreviewUrl: (asset: ReferenceAsset) => asset.url || '' },
    '../userFacingError': { formatUserFacingError: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
    '../errorDiagnostics': errorDiagnostics, '../videoTaskErrorDiagnostics': videoTaskErrorDiagnostics,
    './TaskErrorDetails': { TaskErrorDetails: () => null },
    './ReferenceImageName': { ReferenceImageName: ({ name }: { name: string }) => React.createElement('strong', null, name) },
    './VideoExecutionControls': { VideoExecutionControls: () => null },
    '../videoTailReference': tails, '../videoTailCharacters': tailCharacters, '../videoReferenceUsage': referenceUsage, '../videoReferenceSlots': referenceSlots, '../videoBatch': batch, '../videoBatchSelection': batchSelection,
    '../videoDirectorDraft': drafts, '../videoGenerationSource': sources, '../runningHubVideo': runningHub,
    '../videoOutputParameters': output, './VideoOutputParameters': { VideoOutputParameters: () => null },
    '../videoRuntimeStore': { useVideoTaskRuntime: (_id: string, _store: unknown, fallback: unknown) => fallback },
    '../videoProvenance': provenance, '../videoDirectorReferences': directorReferences,
    '../videoResultRecovery': { canRecoverRunningHubResult: () => false, runningHubRemoteSucceeded: () => false },
    '../comfyuiVideo': { canRecoverComfyPreviewResult: () => false },
    './PreviousVideoTailDialog': { PreviousVideoTailDialog: () => null },
  };
  const compiled = ts.transpileModule(readFileSync(new URL(`../src/components/${file}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} as Record<string, (props: Props) => React.ReactNode> };
  new Function('require', 'module', 'exports', 'React', `${compiled}${file === 'VideoDirectorView' ? '\nObject.assign(module.exports, { VideoBatchPanel, VideoBatchImagePicker, VideoReferenceSlotUsageEditor });' : ''}`)((name: string) => {
    if (name.endsWith('.css')) return {}; if (name in modules) return modules[name]; throw new Error(`Unexpected import: ${name}`);
  }, module, module.exports, React);
  let tree: React.ReactNode;
  const render = () => {
    let count = 0;
    do { assert.ok(count++ < 20, 'hooks settle'); cursor = 0; dirty = false; tree = module.exports[component](props); const queue = effects; effects = []; queue.forEach((effect) => effect()); } while (dirty);
    return tree;
  };
  const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); return render(); };
  const dispose = () => slots.forEach((slot) => slot.cleanup?.());
  return { render, flush, dispose, update: (patch: Props) => { props = { ...props, ...patch }; return render(); } };
}

const image = (id: string, timeSec: number): ReferenceAsset => ({ id, name: id, type: 'last-frame', mediaType: 'image', role: 'last-frame', referenceRole: 'last-frame', source: 'derived', tags: [], createdAt: 1, updatedAt: 1, sourceTimeSec: timeSec, sourceVideoAssetId: 'video-1', checksum: `checksum-${id}`, relativePath: `assets/${id}.png`, url: `https://fixture.invalid/${id}.png` });
const early = image('early-frame', 8.5); const last = image('last-frame', 9.96);
const result = (fallback = false): TailFrameSelectionResult => ({
  frame: fallback ? last : early,
  candidates: [{ id: 'candidate-1', timeSec: 8.5, isLastFrame: false, asset: early }, { id: 'candidate-last', timeSec: 9.96, isLastFrame: true, asset: last }],
  selection: { source: fallback ? 'last-frame' : 'ai', selectedId: fallback ? 'candidate-last' : 'candidate-1', reason: fallback ? '视觉接口本次未返回可用建议' : '背影符合本段剧情，选择这一帧保留动作方向', warning: fallback ? '视觉接口未配置，已使用原尾帧；视频生成可继续。' : undefined, offsetFromEndSec: fallback ? 0 : 1.46, selectedTimeSec: fallback ? 9.96 : 8.5, lastFrameTimeSec: 9.96, candidateCount: 2 },
});
const fixture = () => {
  const state = createInitialState(); const project = state.project; const settings = state.settings;
  project.id = 'ai-ui-project'; project.generationTasks = []; project.assets = [{ id: 'video-1', name: '上段成片', type: 'video', mediaType: 'video', role: 'motion', source: 'generated', tags: [], createdAt: 1, updatedAt: 1, sourceStoryboardId: 'board-1', relativePath: 'video/one.mp4' }];
  project.storyboards = [1, 2, 3].map((index) => ({ id: `board-${index}`, sceneId: project.scenes[0].id, sourceStoryTitle: '全文', workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', globalReferenceAssetIds: [], shots: [], finalPrompt: `第${index}段全文：非人类巨龙背对镜头，转身前保持遮挡。`, officialPromptZh: `第${index}段全文：非人类巨龙背对镜头，转身前保持遮挡。`, sequencePlanId: 'plan', segmentId: `segment-${index}`, segmentIndex: index, segmentCount: 3, createdAt: 1, updatedAt: 1 } as Storyboard));
  const plan: VideoSequencePlan = { id: 'plan', title: '非人类角色长剧情', sourceStoryTitle: '全文', sourceStoryContent: '完整原始故事', durationMode: 'ai-estimated', totalDurationSec: 30, segmentDurationSec: 10, segmentationMode: 'natural', fitStatus: 'balanced', createdAt: 1, updatedAt: 1, segments: project.storyboards.map((board, index) => ({ id: board.segmentId!, index: index + 1, title: `片段${index + 1}`, globalStartSec: index * 10, globalEndSec: (index + 1) * 10, durationSec: 10, content: `原文${index + 1}`, summary: '', sourceSceneIds: [board.sceneId], sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: board.id, status: 'ready' })) };
  project.sequencePlans = [plan]; settings.videoBackend = 'api'; settings.videoSource = 'api'; settings.videoApiProfiles = []; settings.activeVideoApiProfileId = null;
  settings.textApi = { ...settings.textApi, enabled: false, apiKey: '', baseUrl: 'https://fixture.invalid/forbidden-text-api' };
  settings.textApiProfiles = []; settings.activeTextApiProfileId = null;
  settings.videoTaskApi = { ...settings.videoTaskApi, enabled: true, provider: 'generic', model: 'test-video', apiKey: '', endpoint: 'https://fixture.invalid/video', requestTemplate: '' };
  return { project, settings };
};
const batchFixture = (extract: TailFrameTools['extract'] = async () => last, withIdentity = false) => {
  const initial = fixture(); const batches: VideoBatchStartInput[] = []; const calls = { ai: 0, extract: 0, cancel: 0 };
  if (withIdentity) {
    initial.project.characters = [{ id: 'dragon', name: '巨龙', assetIds: ['dragon-image'], gender: '', apparentAge: '成年', race: '龙', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' }];
    initial.project.assets.push({ ...image('dragon-image', 0), type: 'character', role: 'character', referenceRole: 'character', source: 'upload', sourceVideoAssetId: undefined, sourceTimeSec: undefined, sourceEntityId: 'dragon', sourceEntityKind: 'character' });
    initial.project.storyboards.forEach((board) => {
      const prompt = [
        'subject_definitions:', '<Subject 1> is 巨龙 referenced from <Picture 1>: 非人类成年巨龙，银色鳞片。',
        'summary:', `第${board.segmentIndex}段，巨龙背对镜头，转身前保持遮挡。`,
        'retention_analysis:', '<Subject 1> reference <Picture 1>.',
        'detailed_description:', 'Shot 1 【0s-10s】<Subject 1>缓慢转头。<d>明天出发。</d>',
        'overall_soundscape:', '仅风声和本段对白。', 'non_diegetic_music:', '无配乐。',
      ].join('\n');
      Object.assign(board, { globalReferenceAssetIds: ['dragon-image'], finalPrompt: prompt, officialPromptZh: prompt, targetModelId: 'custom',
        targetOutput: { targetId: 'custom', prompt, parameters: {}, referenceManifest: [{ id: 'dragon-image', token: '<Picture 1>' }], warnings: [], generatedAt: 1 } });
    });
  }
  const controller = { startBatch: async (input: VideoBatchStartInput) => { batches.push(structuredClone(input)); return { batchId: 'batch', taskIds: ['a', 'b', 'c'], skipped: [] }; } };
  const tools: TailFrameTools = { available: true, busy: false,
    selectFrame: async () => { calls.ai += 1; throw new Error('new UI must not request visual AI'); },
    extract: async (...args) => { calls.extract += 1; return extract(...args); }, cancel: async () => { calls.cancel += 1; } };
  const props = { ...initial, controller, initialDraft: { backend: 'api', name: '', prompt: '', parameters: {}, references: [] } as VideoGenerationDraft,
    initialParameterText: '{}', onSubmittingChange: () => {}, tailFrameTools: tools };
  return { ...initial, props, batches, calls, ui: harness('VideoDirectorView', 'VideoBatchPanel', props) };
};
const addMixedImages = (project: Project) => {
  const make = (id: string, role: ReferenceRole): ReferenceAsset => ({ ...image(id, 0), type: 'reference', role: role === 'scene' || role === 'prop' ? role : 'style', referenceRole: role,
    source: 'upload', sourceVideoAssetId: undefined, sourceTimeSec: undefined });
  const assets = [make('beach-scene', 'scene'), make('sword-prop', 'prop'), make('other-reference', 'general')];
  project.assets.push(...assets);
  return assets;
};
const pickerImages = (tree: React.ReactNode) => componentNode(tree, 'VideoReferencePickerPanels').props.images as React.ReactNode;
const pickerSlots = (tree: React.ReactNode) => {
  const editor = componentNode(componentNode(tree, 'VideoReferencePickerPanels').props.slots, 'VideoReferenceSlotUsageEditor');
  return (editor.type as (props: Props) => React.ReactNode)(editor.props);
};
const openBatchPicker = (value: ReturnType<typeof batchFixture>, segmentIndex: number) => {
  find(value.ui.render(), `第 ${segmentIndex} 段选择参考图`).props.onClick();
  const picker = componentNode(value.ui.render(), 'VideoBatchImagePicker');
  return { props: picker.props, ui: harness('VideoDirectorView', 'VideoBatchImagePicker', picker.props) };
};
const selectedSlots = (references: readonly VideoImageReference[]) => references.map((reference, index) => (
  [reference.assetId, reference.role, referenceSlots.videoReferenceSlotIndex(reference, index)]
));
const submitFixtureBatch = async (value: ReturnType<typeof batchFixture>, count: number) => {
  let tree = value.ui.render();
  const check = button(tree, `检查并生成 ${count} 段视频`);
  assert.notEqual(check.props.disabled, true, textOf(tree));
  check.props.onClick(); tree = value.ui.render();
  find(tree, '确认批量生成费用').props.onChange({ target: { checked: true } }); tree = value.ui.render();
  button(tree, `确认生成 ${count} 段`).props.onClick(); await value.ui.flush();
  assert.equal(value.batches.length, 1);
  return value.batches[0].items;
};
const noTailDialog = (tree: React.ReactNode) => {
  assert.ok(!nodesOf(tree).some((node) => node.props.role === 'dialog' || typeof node.type === 'function' && node.props.title?.includes?.('衔接') || node.props['aria-label']?.includes?.('确认替换')));
  assert.doesNotMatch(textOf(tree), /直接使用原尾帧|启用自动衔接|选帧方式/);
};
let groups = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); groups += 1; console.log(`PASS ${name}`); };
try {
  await test('单行点击设置本地末帧衔接，配置阶段没有抽帧、视觉AI或生成调用', () => {
    const value = batchFixture(); let tree = value.ui.render();
    button(tree, '全选中文').props.onClick(); tree = value.ui.render();
    find(tree, '第 2 段用上段尾帧').props.onClick(); tree = value.ui.render();
    noTailDialog(tree); assert.match(textOf(tree), /第 1 段 → 本地末帧/);
    assert.match(textOf(tree), /不调用文本或视觉AI，不重新生成视频提示词，尚未提交视频/);
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.equal(value.batches.length, 0);
    find(tree, '第 2 段取消自动衔接').props.onClick(); tree = value.ui.render();
    assert.doesNotMatch(textOf(tree), /第 1 段 → 本地末帧/); value.ui.dispose();
  });
  await test('一键批量仅建立本地末帧依赖，保留视频提交费用确认', async () => {
    const value = batchFixture(); let tree = value.ui.render();
    button(tree, '全选中文').props.onClick(); tree = value.ui.render();
    find(tree, '已选后续段自动衔接').props.onClick(); tree = value.ui.render();
    noTailDialog(tree); assert.equal(value.calls.ai, 0); assert.equal(value.batches.length, 0);
    assert.match(textOf(tree), /已一键设置 2 段本地末帧/);
    button(tree, '检查并生成 3 段视频').props.onClick(); tree = value.ui.render();
    assert.equal(value.batches.length, 0); assert.doesNotMatch(textOf(tree), /本批次包含 AI 辅助选帧/);
    find(tree, '确认批量生成费用').props.onChange({ target: { checked: true } }); tree = value.ui.render();
    button(tree, '确认生成 3 段').props.onClick(); await value.ui.flush();
    assert.equal(value.batches.length, 1); const items = value.batches[0].items;
    assert.equal(items[0].previousTail, undefined);
    assert.deepEqual(items.slice(1).map((entry) => [entry.previousTail?.selectionMode, entry.previousTail?.requireAiSelection]), [[undefined, undefined], [undefined, undefined]]);
    assert.deepEqual(items.slice(1).map((entry) => entry.previousTail?.predecessorItemKey), [items[0].itemKey, items[1].itemKey]);
    assert.equal(value.project.generationTasks.length, 0); value.ui.dispose();
  });
  await test('选中1和3不借用第1段，也不悄悄添加收费的第2段', () => {
    const value = batchFixture(); let tree = value.ui.render();
    find(tree, '选择第 1 段').props.onChange(); tree = value.ui.render();
    find(tree, '选择第 3 段').props.onChange(); tree = value.ui.render();
    find(tree, '已选后续段自动衔接').props.onClick(); tree = value.ui.render();
    assert.match(textOf(tree), /已一键设置 0 段/); assert.match(textOf(tree), /请同时选择第 2 段/);
    assert.equal(find(tree, '选择第 2 段').props.checked, false); assert.equal(value.calls.ai, 0); noTailDialog(tree); value.ui.dispose();
  });
  await test('已有前段成片时一次本地提取真实末帧并直接应用，不需要视觉API配置', async () => {
    const sourcesSeen: unknown[] = [];
    const value = batchFixture(async (source) => { sourcesSeen.push(source); return last; });
    const before = JSON.stringify(value.project.storyboards);
    let tree = value.ui.render(); find(tree, '第 2 段用上段尾帧').props.onClick(); tree = await value.ui.flush();
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 1); assert.equal(value.batches.length, 0);
    assert.deepEqual(sourcesSeen, [{ assetId: 'video-1', relativePath: 'video/one.mp4', expectedChecksum: undefined }]);
    assert.match(textOf(tree), /已使用第 1 段的本地真实末帧（9\.960 秒）/);
    assert.match(textOf(tree), /参考图 1 张/); assert.equal(JSON.stringify(value.project.storyboards), before);
    noTailDialog(tree); value.ui.dispose();
  });
  await test('缺失或不属于上一段的抽帧结果不得冒充真实末帧', async () => {
    for (const bad of [{ ...last, referenceRole: 'composition' as const }, { ...last, missing: true }, { ...last, sourceVideoAssetId: 'other-video' }]) {
      const value = batchFixture(async () => bad); let tree = value.ui.render();
      find(tree, '第 2 段用上段尾帧').props.onClick(); tree = await value.ui.flush();
      assert.match(textOf(tree), /未返回对应上段的已保存真实末帧/);
      assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 1); assert.equal(value.batches.length, 0);
      assert.match(textOf(nodesOf(tree).find((node) => node.props['data-segment-id'] === 'segment-2')), /参考图 0 张/);
      noTailDialog(tree); value.ui.dispose();
    }
  });
  await test('本地抽帧进度与失败原因显示在页内，保留原选图及完整提示词', async () => {
    let reject!: (reason: Error) => void;
    const value = batchFixture(async () => new Promise((_resolve, fail) => { reject = fail; }));
    const originalFrame = { ...image('existing-first-frame', 0), type: 'first-frame' as const, role: 'first-frame' as const };
    value.project.assets.push(originalFrame); value.project.storyboards[1].firstFrameAssetId = originalFrame.id;
    const before = JSON.stringify(value.project); let tree = value.ui.render();
    find(tree, '第 2 段用上段尾帧').props.onClick(); tree = value.ui.render();
    for (const message of ['正在定位视频真实帧（支持可变帧率）…', '正在提取 1 张原尺寸画面…', '正在保存抽帧图片…']) {
      tree = value.ui.update({ tailFrameTools: { ...value.props.tailFrameTools, busy: true,
        progress: { jobId: 'manual-local-run', projectId: value.project.id, kind: 'extract', stage: 'processing', percent: 60, message } } });
      assert.ok(textOf(tree).includes(message));
      assert.equal(button(tree, '取消末帧提取').props.disabled, undefined);
      assert.equal(find(tree, '第 2 段用上段尾帧').props.disabled, true);
      assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 1); assert.equal(value.batches.length, 0); noTailDialog(tree);
    }
    reject(new Error('视频文件已损坏，无法解码最后一帧。'));
    tree = await value.ui.flush(); tree = value.ui.update({ tailFrameTools: value.props.tailFrameTools });
    assert.match(textOf(tree), /视频文件已损坏，无法解码最后一帧/);
    assert.match(textOf(nodesOf(tree).find((node) => node.props['data-segment-id'] === 'segment-2')), /参考图 1 张/);
    assert.ok(!nodesOf(tree).some((node) => node.type === 'button' && textOf(node) === '取消末帧提取'));
    assert.equal(find(tree, '第 2 段用上段尾帧').props.disabled, false);
    assert.equal(JSON.stringify(value.project), before);
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 1); assert.equal(value.batches.length, 0);
    noTailDialog(tree); value.ui.dispose();
  });
  await test('单段本地提取可取消，成功只应用一次，取消后的迟到结果不改图', async () => {
    for (const cancel of [false, true]) {
      const { project, settings } = fixture(); let calls = 0; let starts = 0; let cancellations = 0;
      let resolve!: (selected: ReferenceAsset) => void;
      const tools: TailFrameTools = { available: true, busy: false,
        extract: async (source) => {
          calls += 1; assert.equal(source.assetId, 'video-1');
          return new Promise((done) => { resolve = done; });
        }, cancel: async () => { cancellations += 1; } };
      const ui = harness('VideoDirectorView', 'VideoDirectorView', { project, settings,
        controller: { start: async () => { starts += 1; } },
        launchRequest: { id: 'tail-single-local-' + cancel, storyboardId: 'board-2', language: 'zh' }, tailFrameTools: tools });
      let tree = ui.render(); find(tree, '单段用上段尾帧').props.onClick(); tree = ui.render();
      assert.match(textOf(tree), /不调用视觉 API、不提交视频生成/);
      const message = '正在本地提取真实最后一帧…';
      tree = ui.update({ tailFrameTools: { ...tools, busy: true,
        progress: { jobId: 'single-local-run', projectId: project.id, kind: 'extract', stage: 'processing', percent: 65, message } } });
      assert.ok(textOf(tree).includes(message)); assert.equal(find(tree, '单段用上段尾帧').props.disabled, true);
      assert.equal(button(tree, '取消末帧提取').props.disabled, undefined); assert.equal(calls, 1); noTailDialog(tree);
      if (cancel) button(tree, '取消末帧提取').props.onClick();
      resolve(last); tree = await ui.flush(); tree = ui.update({ tailFrameTools: tools });
      assert.match(textOf(tree), cancel ? /本次参考图片 · 0 张/ : /本次参考图片 · 1 张/);
      if (!cancel) { assert.match(textOf(tree), /已使用第 1 段的本地真实末帧/); assert.ok(nodesOf(tree).some((node) => node.props.className === 'vd-image-slot-badge' && /首帧/.test(textOf(node)))); }
      else assert.match(textOf(tree), /已取消本地末帧提取，本段选图未改动/);
      assert.equal(calls, 1); assert.equal(starts, 0); assert.equal(cancellations, cancel ? 1 : 0);
      noTailDialog(tree); ui.dispose();
    }
  });
  await test('取消、改稿、源视频变化或卸载时，迟到的本地末帧不能应用', async () => {
    for (const action of ['cancel', 'prompt', 'source', 'unmount'] as const) {
      let resolve!: (value: ReferenceAsset) => void;
      const value = batchFixture(async () => new Promise((done) => { resolve = done; }));
      let tree = value.ui.render(); find(tree, '第 2 段用上段尾帧').props.onClick(); tree = value.ui.render();
      if (action === 'cancel') button(tree, '取消末帧提取').props.onClick();
      else if (action === 'prompt') { const project = structuredClone(value.project); project.storyboards[1].finalPrompt += '发生变化'; project.storyboards[1].officialPromptZh += '发生变化'; value.ui.update({ project }); }
      else if (action === 'source') { const project = structuredClone(value.project); project.assets[0].checksum = 'changed'; value.ui.update({ project }); }
      else value.ui.dispose();
      assert.equal(value.calls.cancel, 1);
      resolve(last); tree = await value.ui.flush();
      if (action !== 'unmount') {
        assert.match(textOf(nodesOf(tree).find((node) => node.props['data-segment-id'] === 'segment-2')), /参考图 0 张/); value.ui.dispose();
      }
      assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 1); assert.equal(value.batches.length, 0);
    }
  });
  await test('组合单行和批量模式不依赖文本API，提交只同步图片编号且不改写原稿', async () => {
    for (const bulk of [false, true]) {
      const value = batchFixture(async () => last, true);
      const originalBoards = JSON.stringify(value.project.storyboards);
      let tree = value.ui.render();
      button(tree, '全选中文').props.onClick(); tree = value.ui.render();
      if (bulk) find(tree, '已选后续段尾帧加参考图').props.onClick();
      else {
        find(tree, '第 2 段本地末帧加参考图').props.onClick(); tree = await value.ui.flush();
        find(tree, '第 3 段本地末帧加参考图').props.onClick();
      }
      tree = await value.ui.flush();
      assert.equal(value.settings.textApi.enabled, false);
      assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.deepEqual(networkRequests, []);
      assert.match(textOf(tree), /本地末帧/); noTailDialog(tree);
      button(tree, '检查并生成 3 段视频').props.onClick(); tree = value.ui.render();
      find(tree, '确认批量生成费用').props.onChange({ target: { checked: true } }); tree = value.ui.render();
      button(tree, '确认生成 3 段').props.onClick(); await value.ui.flush();
      assert.equal(value.batches.length, 1);
      const items = value.batches[0].items;
      for (const [index, item] of items.slice(1).entries()) {
        assert.equal(item.previousTail?.selectionMode, undefined); assert.equal(item.previousTail?.requireAiSelection, undefined);
        assert.equal(item.previousTail?.placement.mode, 'prepend'); assert.equal(item.previousTail?.placement.index, 0);
        assert.equal(item.previousTail?.predecessorItemKey, items[index].itemKey);
        assert.equal(item.draft.references[0].assetId, 'dragon-image');
        assert.equal(item.draft.prompt, value.project.storyboards[index + 1].officialPromptZh?.replaceAll('<Picture 1>', '<Picture 2>'));
      }
      assert.equal(items[0].draft.prompt, value.project.storyboards[0].officialPromptZh);
      assert.equal(JSON.stringify(value.project.storyboards), originalBoards); assert.deepEqual(networkRequests, []);
      value.ui.dispose();
    }
  });
  await test('组合静态模式无文本复核直接本地抽帧，图片1末帧、图片2人物，取消恢复原稿', async () => {
    const value = batchFixture(async () => last, true);
    const originalBoards = JSON.stringify(value.project.storyboards);
    let tree = value.ui.render();
    find(tree, '第 2 段本地末帧加参考图').props.onClick(); tree = await value.ui.flush();
    assert.equal(value.settings.textApi.enabled, false); assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 1); assert.deepEqual(networkRequests, []);
    assert.match(textOf(tree), /参考图 2 张/);
    assert.match(textOf(tree), /本地真实末帧定画面/);
    assert.equal(value.batches.length, 0); noTailDialog(tree);
    find(tree, '第 2 段取消尾帧加参考图').props.onClick(); tree = await value.ui.flush();
    assert.match(textOf(nodesOf(tree).find((node) => node.props['data-segment-id'] === 'segment-2')), /参考图 1 张/);
    find(tree, '选择第 2 段').props.onChange(); tree = value.ui.render();
    button(tree, '检查并生成 1 段视频').props.onClick(); tree = value.ui.render();
    find(tree, '确认批量生成费用').props.onChange({ target: { checked: true } }); tree = value.ui.render();
    button(tree, '确认生成 1 段').props.onClick(); await value.ui.flush();
    assert.equal(value.batches.length, 1); assert.equal(value.batches[0].items[0].draft.prompt, value.project.storyboards[1].officialPromptZh);
    assert.equal(JSON.stringify(value.project.storyboards), originalBoards); assert.deepEqual(networkRequests, []); value.ui.dispose();
  });
  await test('组合默认人物图，用户改选混合参考和用途后保留模式、独立槽位及其它段', async () => {
    const value = batchFixture(async () => last, true); addMixedImages(value.project);
    const before = JSON.stringify(value.project.storyboards);
    let tree = value.ui.render(); button(tree, '全选中文').props.onClick(); tree = value.ui.render();
    find(tree, '已选后续段尾帧加参考图').props.onClick(); tree = value.ui.render();
    const picker = openBatchPicker(value, 2); let selection = picker.ui.render();
    assert.equal(picker.props.slotOffset, 1);
    assert.deepEqual(selectedSlots(picker.props.references), [['dragon-image', 'character', 0]], 'first enable defaults to a character image, not a scene/prop sweep');
    assert.match(textOf(pickerImages(selection)), /场景|其它/);
    assert.equal(button(selection, '使用本段图片').props.disabled, false);
    find(pickerImages(selection), '选择图片 beach-scene').props.onClick(); selection = picker.ui.render();
    find(pickerImages(selection), '选择图片 sword-prop').props.onClick(); selection = picker.ui.render();
    assert.match(textOf(find(pickerImages(selection), '图片 dragon-image 占用槽位')), /人物.*槽2/);
    assert.match(textOf(find(pickerImages(selection), '图片 beach-scene 占用槽位')), /场景.*槽3/);
    assert.match(textOf(find(pickerImages(selection), '图片 sword-prop 占用槽位')), /道具.*槽4/);
    find(pickerImages(selection), '取消选择图片 dragon-image').props.onClick(); selection = picker.ui.render();
    assert.match(textOf(find(pickerImages(selection), '图片 beach-scene 占用槽位')), /场景.*槽3/);
    assert.match(textOf(find(pickerImages(selection), '图片 sword-prop 占用槽位')), /道具.*槽4/);
    find(pickerImages(selection), '选择图片 other-reference').props.onClick(); selection = picker.ui.render();
    assert.match(textOf(find(pickerImages(selection), '图片 other-reference 占用槽位')), /人物.*槽2/, 'new image takes the vacated role, not a reordered role');
    find(pickerSlots(selection), '第 2 段图片槽 2 用途').props.onChange({ target: { value: 'general' } }); selection = picker.ui.render();
    assert.match(textOf(find(pickerImages(selection), '图片 other-reference 占用槽位')), /通用参考.*槽2/);
    await button(selection, '使用本段图片').props.onClick(); tree = await value.ui.flush(); picker.ui.dispose();
    assert.equal(find(tree, '第 2 段本地末帧加参考图').props['aria-pressed'], true);
    assert.equal(find(tree, '第 3 段本地末帧加参考图').props['aria-pressed'], true);
    const reopened = openBatchPicker(value, 2); selection = reopened.ui.render();
    assert.deepEqual(selectedSlots(reopened.props.references), [['other-reference', 'general', 0], ['beach-scene', 'scene', 1], ['sword-prop', 'prop', 2]]);
    // Persist a genuine hole through the picker, composite rebinding and submit.
    find(pickerSlots(selection), '移除图片槽 3 的图片').props.onClick(); selection = reopened.ui.render();
    assert.match(textOf(find(pickerImages(selection), '图片 sword-prop 占用槽位')), /道具.*槽4/);
    await button(selection, '使用本段图片').props.onClick(); tree = await value.ui.flush(); reopened.ui.dispose();
    const retained = openBatchPicker(value, 2);
    assert.deepEqual(selectedSlots(retained.props.references), [['other-reference', 'general', 0], ['sword-prop', 'prop', 2]]);
    assert.deepEqual(retained.props.referenceSlotRoles, ['general', 'scene', 'prop']);
    retained.props.onClose(); retained.ui.dispose(); tree = value.ui.render();
    const unaffected = openBatchPicker(value, 3);
    assert.deepEqual(selectedSlots(unaffected.props.references), [['dragon-image', 'character', 0]], 'custom selection belongs only to segment 2');
    unaffected.props.onClose(); unaffected.ui.dispose(); tree = value.ui.render();
    // Re-applying either mode entry must not silently replace the custom images.
    find(tree, '第 2 段本地末帧加参考图').props.onClick(); tree = value.ui.render();
    find(tree, '已选后续段尾帧加参考图').props.onClick(); tree = value.ui.render();
    const items = await submitFixtureBatch(value, 3);
    assert.deepEqual(selectedSlots(items[1].draft.references), [['other-reference', 'general', 0], ['sword-prop', 'prop', 2]]);
    assert.equal(items[1].previousTail?.placement.mode, 'prepend');
    assert.deepEqual(selectedSlots(batch.videoBatchTailReferences(items[1].draft.references, items[1].previousTail!.placement, last.id)),
      [[last.id, 'first-frame', 0], ['other-reference', 'general', 1], ['sword-prop', 'prop', 3]]);
    assert.deepEqual(items[2].draft.references.map((reference) => reference.assetId), ['dragon-image']);
    assert.equal(items[1].draft.prompt.slice(items[1].draft.prompt.indexOf('detailed_description:')),
      value.project.storyboards[1].officialPromptZh!.slice(value.project.storyboards[1].officialPromptZh!.indexOf('detailed_description:')),
      'image choice must leave shots, literal dialogue and sound intact');
    assert.equal(JSON.stringify(value.project.storyboards), before);
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.deepEqual(networkRequests, []); value.ui.dispose();
  });
  await test('组合手动仅留场景或清空附加图均可提交，重启模式不自动补人物', async () => {
    for (const sceneOnly of [true, false]) {
      const value = batchFixture(async () => last, true); addMixedImages(value.project);
      const before = JSON.stringify(value.project.storyboards);
      let tree = value.ui.render(); button(tree, '全选中文').props.onClick(); tree = value.ui.render();
      find(tree, '第 2 段本地末帧加参考图').props.onClick(); tree = value.ui.render();
      const picker = openBatchPicker(value, 2); let selection = picker.ui.render();
      find(pickerImages(selection), '取消选择图片 dragon-image').props.onClick(); selection = picker.ui.render();
      if (sceneOnly) {
        find(pickerImages(selection), '选择图片 beach-scene').props.onClick(); selection = picker.ui.render();
        find(pickerSlots(selection), '第 2 段图片槽 2 用途').props.onChange({ target: { value: 'scene' } }); selection = picker.ui.render();
      }
      await button(selection, '使用本段图片').props.onClick(); tree = await value.ui.flush(); picker.ui.dispose();
      assert.equal(find(tree, '第 2 段本地末帧加参考图').props['aria-pressed'], true);
      find(tree, '第 2 段本地末帧加参考图').props.onClick(); tree = value.ui.render();
      find(tree, '已选后续段尾帧加参考图').props.onClick(); tree = value.ui.render();
      const check = openBatchPicker(value, 2);
      assert.deepEqual(selectedSlots(check.props.references), sceneOnly ? [['beach-scene', 'scene', 0]] : [], 'manual scene-only/empty selection is authoritative');
      check.props.onClose(); check.ui.dispose(); value.ui.render();
      const items = await submitFixtureBatch(value, 3);
      assert.deepEqual(selectedSlots(items[1].draft.references), sceneOnly ? [['beach-scene', 'scene', 0]] : []);
      assert.equal(items[1].previousTail?.placement.mode, 'prepend');
      assert.equal(batch.videoBatchTailReferences(items[1].draft.references, items[1].previousTail!.placement, last.id).length, sceneOnly ? 2 : 1);
      assert.match(items[1].draft.prompt, /<d>明天出发。<\/d>/);
      assert.equal(JSON.stringify(value.project.storyboards), before);
      assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.deepEqual(networkRequests, []); value.ui.dispose();
    }
  });
  await test('本地末帧加人物加场景的真实提交使用混合选图，H3人物图片编号及对白保持对应', async () => {
    const value = batchFixture(async () => last, true); addMixedImages(value.project);
    const before = JSON.stringify(value.project.storyboards);
    let tree = value.ui.render(); button(tree, '全选中文').props.onClick(); tree = value.ui.render();
    find(tree, '第 2 段本地末帧加参考图').props.onClick(); value.ui.render();
    const picker = openBatchPicker(value, 2); let selection = picker.ui.render();
    find(pickerImages(selection), '选择图片 beach-scene').props.onClick(); selection = picker.ui.render();
    await button(selection, '使用本段图片').props.onClick(); await value.ui.flush(); picker.ui.dispose();
    const items = await submitFixtureBatch(value, 3);
    assert.deepEqual(selectedSlots(items[1].draft.references), [['dragon-image', 'character', 0], ['beach-scene', 'scene', 1]]);
    assert.deepEqual(selectedSlots(batch.videoBatchTailReferences(items[1].draft.references, items[1].previousTail!.placement, last.id)),
      [[last.id, 'first-frame', 0], ['dragon-image', 'character', 1], ['beach-scene', 'scene', 2]]);
    assert.equal(items[1].draft.prompt, value.project.storyboards[1].officialPromptZh?.replaceAll('<Picture 1>', '<Picture 2>'),
      'scene is not turned into an identity and the saved dialogue is never rewritten');
    assert.equal(JSON.stringify(value.project.storyboards), before);
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.deepEqual(networkRequests, []); value.ui.dispose();
  });
  await test('RunningHub五槽旧配置虽标人物，组合仍能自选场景和道具并保留空槽提交', async () => {
    const value = batchFixture(async () => last, true); addMixedImages(value.project);
    const roles: ReferenceRole[] = ['first-frame', 'character', 'character', 'character', 'character'];
    Object.assign(value.settings.videoTaskApi, { provider: 'runninghub', runningHubAppId: 'ui-fixture-only', runningHubImageRoles: roles,
      requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'value', fieldValue: '' },
        ...roles.map((_, index) => ({ nodeId: String(index + 2), fieldName: 'image', fieldValue: '' }))] }),
      runningHubMappedFields: [{ nodeId: '1', fieldName: 'value', kind: 'prompt' },
        ...roles.map((_, imageIndex) => ({ nodeId: String(imageIndex + 2), fieldName: 'image', kind: 'image', imageIndex }))] });
    const before = JSON.stringify(value.project.storyboards);
    let tree = value.ui.render(); button(tree, '全选中文').props.onClick(); tree = value.ui.render();
    find(tree, '第 2 段本地末帧加参考图').props.onClick(); value.ui.render();
    const picker = openBatchPicker(value, 2); let selection = picker.ui.render();
    assert.match(textOf(pickerSlots(selection)), /图片槽 5（未选择）/);
    assert.doesNotMatch(textOf(pickerSlots(selection)), /图片槽 6/);
    find(pickerImages(selection), '选择图片 beach-scene').props.onClick(); selection = picker.ui.render();
    find(pickerImages(selection), '选择图片 sword-prop').props.onClick(); selection = picker.ui.render();
    find(pickerSlots(selection), '移除图片槽 2 的图片').props.onClick(); selection = picker.ui.render();
    assert.equal(find(pickerSlots(selection), '第 2 段图片槽 3 用途').props.value, 'scene');
    assert.equal(find(pickerSlots(selection), '第 2 段图片槽 4 用途').props.value, 'prop');
    assert.match(textOf(pickerSlots(selection)), /旧工作流标为人物参考.*场景参考.*仅提示，不阻止生成/);
    assert.match(textOf(find(pickerImages(selection), '图片 beach-scene 占用槽位')), /^场景1（槽3）/);
    assert.match(textOf(find(pickerImages(selection), '图片 sword-prop 占用槽位')), /^道具1（槽4）/);
    await button(selection, '使用本段图片').props.onClick(); tree = await value.ui.flush(); picker.ui.dispose();
    assert.equal(find(tree, '第 2 段本地末帧加参考图').props['aria-pressed'], true);
    const items = await submitFixtureBatch(value, 3);
    assert.deepEqual(selectedSlots(items[1].draft.references), [['beach-scene', 'scene', 1], ['sword-prop', 'prop', 2]]);
    assert.deepEqual(selectedSlots(batch.videoBatchTailReferences(items[1].draft.references, items[1].previousTail!.placement, last.id)),
      [[last.id, 'first-frame', 0], ['beach-scene', 'scene', 2], ['sword-prop', 'prop', 3]]);
    assert.deepEqual(items[1].draft.referenceSlotRoles, ['character', 'scene', 'prop']);
    assert.equal(JSON.stringify(value.project.storyboards), before);
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.deepEqual(networkRequests, []); value.ui.dispose();
  });
  await test('没有人物参考的剧情仍可开启组合，仅末帧或手动补场景都不被类型拦截', async () => {
    const value = batchFixture(); addMixedImages(value.project); value.project.characters = [];
    value.project.storyboards.forEach((board) => { board.globalReferenceAssetIds = ['beach-scene', 'sword-prop', 'other-reference']; });
    const before = JSON.stringify(value.project.storyboards);
    let tree = value.ui.render(); button(tree, '全选中文').props.onClick(); tree = value.ui.render();
    find(tree, '已选后续段尾帧加参考图').props.onClick(); tree = value.ui.render();
    assert.equal(find(tree, '第 2 段本地末帧加参考图').props['aria-pressed'], true);
    assert.equal(find(tree, '第 3 段本地末帧加参考图').props['aria-pressed'], true);
    const picker = openBatchPicker(value, 2); let selection = picker.ui.render();
    assert.deepEqual(picker.props.references, [], 'default selection must not invent a required identity');
    find(pickerImages(selection), '选择图片 beach-scene').props.onClick(); selection = picker.ui.render();
    await button(selection, '使用本段图片').props.onClick(); await value.ui.flush(); picker.ui.dispose();
    const items = await submitFixtureBatch(value, 3);
    assert.deepEqual(selectedSlots(items[1].draft.references), [['beach-scene', 'scene', 0]]);
    assert.deepEqual(items[2].draft.references, [], 'unmodified third segment may use only the reserved tail');
    assert.equal(items[1].draft.prompt, value.project.storyboards[1].officialPromptZh);
    assert.equal(JSON.stringify(value.project.storyboards), before);
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.deepEqual(networkRequests, []); value.ui.dispose();
  });
  await test('先选择其它参考图再开启本地末帧组合，也尊重明确的单段选图及用途', async () => {
    for (const empty of [false, true]) {
      const value = batchFixture(async () => last, true); addMixedImages(value.project);
      const before = JSON.stringify(value.project.storyboards);
      let tree = value.ui.render(); button(tree, '全选中文').props.onClick(); value.ui.render();
      const picker = openBatchPicker(value, 2); let selection = picker.ui.render();
      assert.equal(picker.props.slotOffset, 0);
      find(pickerImages(selection), '取消选择图片 dragon-image').props.onClick(); selection = picker.ui.render();
      if (!empty) {
        find(pickerImages(selection), '选择图片 beach-scene').props.onClick(); selection = picker.ui.render();
        find(pickerSlots(selection), '第 2 段图片槽 1 用途').props.onChange({ target: { value: 'general' } }); selection = picker.ui.render();
        assert.match(textOf(pickerSlots(selection)), /仅提示，不阻止生成/);
      }
      await button(selection, '使用本段图片').props.onClick(); tree = await value.ui.flush(); picker.ui.dispose();
      find(tree, '第 2 段本地末帧加参考图').props.onClick(); tree = value.ui.render();
      assert.equal(find(tree, '第 2 段本地末帧加参考图').props['aria-pressed'], true);
      const compositePicker = openBatchPicker(value, 2);
      assert.equal(compositePicker.props.slotOffset, 1);
      assert.deepEqual(selectedSlots(compositePicker.props.references), empty ? [] : [['beach-scene', 'general', 0]]);
      compositePicker.props.onClose(); compositePicker.ui.dispose(); value.ui.render();
      const items = await submitFixtureBatch(value, 3);
      assert.deepEqual(selectedSlots(items[1].draft.references), empty ? [] : [['beach-scene', 'general', 0]]);
      assert.equal(items[1].previousTail?.placement.mode, 'prepend');
      assert.equal(items[2].previousTail, undefined, 'enabling segment 2 must not enable segment 3');
      assert.equal(JSON.stringify(value.project.storyboards), before);
      assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 0); assert.deepEqual(networkRequests, []); value.ui.dispose();
    }
  });
  await test('已抽取真实末帧的组合可改场景加道具，提交快照保持末帧在槽1且不重新抽帧', async () => {
    const value = batchFixture(async () => last, true); addMixedImages(value.project); value.project.assets.push(last);
    const before = JSON.stringify(value.project.storyboards);
    let tree = value.ui.render(); find(tree, '第 2 段本地末帧加参考图').props.onClick(); tree = await value.ui.flush();
    assert.equal(value.calls.extract, 1); assert.equal(find(tree, '第 2 段本地末帧加参考图').props['aria-pressed'], true);
    const picker = openBatchPicker(value, 2); let selection = picker.ui.render();
    assert.equal(picker.props.slotOffset, 1);
    assert.ok(!picker.props.references.some((reference: VideoImageReference) => reference.assetId === last.id), 'reserved tail is not an editable identity selection');
    find(pickerImages(selection), '取消选择图片 dragon-image').props.onClick(); selection = picker.ui.render();
    find(pickerImages(selection), '选择图片 beach-scene').props.onClick(); selection = picker.ui.render();
    find(pickerSlots(selection), '第 2 段图片槽 2 用途').props.onChange({ target: { value: 'scene' } }); selection = picker.ui.render();
    find(pickerImages(selection), '选择图片 sword-prop').props.onClick(); selection = picker.ui.render();
    await button(selection, '使用本段图片').props.onClick(); tree = await value.ui.flush(); picker.ui.dispose();
    assert.equal(value.calls.extract, 1); assert.equal(find(tree, '第 2 段本地末帧加参考图').props['aria-pressed'], true);
    find(tree, '选择第 2 段').props.onChange(); value.ui.render();
    const items = await submitFixtureBatch(value, 1);
    assert.equal(items[0].previousTail, undefined);
    assert.deepEqual(selectedSlots(items[0].draft.references), [[last.id, 'first-frame', 0], ['beach-scene', 'scene', 1], ['sword-prop', 'prop', 2]]);
    assert.deepEqual(items[0].draft.referenceSlotRoles, ['first-frame', 'scene', 'prop']);
    assert.match(items[0].draft.prompt, /<d>明天出发。<\/d>/);
    assert.equal(JSON.stringify(value.project.storyboards), before);
    assert.equal(value.calls.ai, 0); assert.equal(value.calls.extract, 1); assert.deepEqual(networkRequests, []); value.ui.dispose();
  });
  await test('旧任务持久选帧原因与原尾帧回退记录仍可查看', () => {
    for (const fallback of [false, true]) {
      const task: VideoGenerationTask = { id: 'task', kind: 'video', storyboardId: 'board-2', targetId: 'model', status: 'succeeded', requestBody: {}, createdAt: 1, updatedAt: 2, videoJob: { stage: 'succeeded', message: '后续视频已保存', tailPreparation: { phase: 'ready', revision: 3, selection: { status: 'completed', ...result(fallback).selection } }, snapshot: { projectId: 'ai-ui-project', clientId: 'test', images: [], draft: { backend: 'api', name: '第二段', prompt: '全文', parameters: {}, references: [] }, connection: { backend: 'api' } } } };
      const ui = harness('VideoDirectorView', 'VideoTaskCard', { task, assets: [], runtime: { stage: 'succeeded', message: '新的云端状态' } }); const tree = ui.render();
      assert.match(textOf(tree), /新的云端状态/);
      assert.match(textOf(tree), fallback ? /视觉接口本次未返回可用建议/ : /AI 辅助选帧/);
      assert.match(textOf(tree), fallback ? /9\.960 秒/ : /动作回退/); ui.dispose();
    }
  });
  console.log('videoTailAiUi: ' + groups + ' local-tail + legacy-record component regression groups passed; no network or real project writes.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement); else Reflect.deleteProperty(globalThis, 'HTMLElement');
}
