import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import * as output from '../src/videoOutputParameters';
import * as source from '../src/videoGenerationSource';
import * as runningHub from '../src/runningHubVideo';
import * as provenance from '../src/videoProvenance';
import * as references from '../src/videoDirectorReferences';
import * as drafts from '../src/videoDirectorDraft';
import * as batch from '../src/videoBatch';
import * as selection from '../src/videoBatchSelection';
import * as tails from '../src/videoTailReference';
import * as tailCharacters from '../src/videoTailCharacters';
import * as h3ReferenceBinding from '../src/videoH3ReferenceBinding';
import * as referenceUsage from '../src/videoReferenceUsage';
import * as referenceSlots from '../src/videoReferenceSlots';
import * as errorDiagnostics from '../src/errorDiagnostics';
import * as videoTaskErrorDiagnostics from '../src/videoTaskErrorDiagnostics';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { bindComfyVideoWorkflow } from '../src/comfyuiVideo';
import { createInitialState } from '../src/storage';
import type { AppSettings, Project, Storyboard, VideoGenerationTask, VideoSequencePlan } from '../src/types';
import type { VideoBatchStartInput, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { VideoOutputParametersProps } from '../src/components/VideoOutputParameters';

let groups = 0;
const test = (name: string, run: () => void) => { run(); groups += 1; console.log(`PASS ${name}`); };
interface Props { children?: React.ReactNode; [key: string]: any }
type Node = React.ReactElement<Props>;
const compile = (name: string) => ts.transpileModule(readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const outputModule = { exports: {} as Record<string, unknown> };
new Function('require', 'module', 'exports', 'React', compile('VideoOutputParameters'))((name: string) => {
  if (name === '../videoOutputParameters') return output;
  if (name.endsWith('.css')) return {};
  throw new Error(`Unexpected output component import ${name}`);
}, outputModule, outputModule.exports, React);
const Output = outputModule.exports.VideoOutputParameters as (props: VideoOutputParametersProps) => React.ReactElement;
const textOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (!React.isValidElement<Props>(value)) return '';
  return value.type === Output ? textOf(Output(value.props as unknown as VideoOutputParametersProps)) : textOf(value.props.children);
};
// Only model the explicit hidden contract here; browser QA separately checks layout
// and native keyboard activation. Hidden inputs remain mounted in nodesOf().
const visibleTextOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(visibleTextOf).join('');
  if (!React.isValidElement<Props>(value) || value.props.hidden) return '';
  return value.type === Output ? visibleTextOf(Output(value.props as unknown as VideoOutputParametersProps)) : visibleTextOf(value.props.children);
};
const nodesOf = (value: React.ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!React.isValidElement<Props>(value)) return [];
  return [value, ...nodesOf(value.type === Output ? Output(value.props as unknown as VideoOutputParametersProps) : value.props.children)];
};
const input = (tree: React.ReactNode, label: string) => {
  const node = nodesOf(tree).find((entry) => entry.type === 'input' && entry.props['aria-label'] === label);
  assert.ok(node, `missing input ${label}`); return node;
};

test('普通 API 可编辑时长与分辨率，云端只显示真实显式映射能力', () => {
  assert.deepEqual(output.availableVideoParameterKeys('api'), ['duration', 'resolution', 'seed']);
  assert.deepEqual(output.availableVideoParameterKeys('runninghub'), []);
  assert.deepEqual(output.availableVideoParameterKeys('comfyui'), []);
  const api = { provider: 'runninghub' as const, runningHubMappedFields: [
    { nodeId: '263', fieldName: 'text', kind: 'prompt' as const },
    { nodeId: '7', fieldName: 'value', kind: 'parameter' as const, parameter: 'duration' },
    { nodeId: '8', fieldName: 'size', kind: 'parameter' as const, parameter: 'resolution' },
  ] };
  assert.deepEqual(output.availableVideoParameterKeys('runninghub', api), ['duration', 'resolution']);
  assert.deepEqual(output.availableVideoParameterKeys('api', api), ['duration', 'resolution']);
});
test('RunningHub 比例节点保留完整 COMBO 值并显示可选下拉', () => {
  const api = { provider: 'runninghub' as const, runningHubMappedFields: [
    { nodeId: '462', fieldName: 'aspect_ratio', kind: 'parameter' as const, parameter: 'aspect_ratio', originalValue: '9:16 (Portrait Widescreen)' },
  ], runningHubParameterControls: { aspect_ratio: { kind: 'select' as const, options: ['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)'] } } };
  assert.deepEqual(output.availableVideoParameterKeys('runninghub', api), ['aspect_ratio']);
  const changes: unknown[] = [];
  const tree = Output({ scope: 'single', source: 'runninghub', availableKeys: ['aspect_ratio'], parameterText: '{}', ...output.videoOutputParameterPresentation(api, {}), onChange: (...args) => changes.push(args) });
  const select = nodesOf(tree).find((node) => node.type === 'select' && node.props['aria-label'] === '本次视频画面比例选项');
  assert.ok(select); assert.equal(select.props.value, '__default__');
  const optionValues = nodesOf(select).filter((node) => node.type === 'option').map((node) => node.props.value).filter(Boolean);
  assert.ok(optionValues.includes('value:9:16 (Portrait Widescreen)'));
  select.props.onChange({ target: { value: 'value:16:9 (Widescreen)' } });
  assert.deepEqual(changes, [['aspect_ratio', '16:9 (Widescreen)']]);
  assert.deepEqual(output.changeVideoParameterText('{}', 'aspect_ratio', '16:9 (Widescreen)').value, { aspect_ratio: '16:9 (Widescreen)' });
  assert.equal(output.videoOutputParameterSummary({ aspect_ratio: '16:9 (Widescreen)' }), '请求画面比例 16:9 (Widescreen)');
});
test('time/seconds/size 和帧数不被猜成秒数或分辨率', () => {
  const keys = output.availableVideoParameterKeys('comfyui', undefined, { mapping: { prompt: [], images: [], parameters: {
    time: { nodeId: '1', inputName: 'value' }, seconds: { nodeId: '2', inputName: 'value' }, size: { nodeId: '3', inputName: 'value' }, frames: { nodeId: '4', inputName: 'value' },
  } } });
  assert.deepEqual(keys, ['time', 'seconds', 'size', 'frames']); assert.ok(keys.every((key) => !output.isVideoOutputParameterKey(key)));
});
test('快捷编辑以当前 JSON 为准，不丢未失焦编辑的嵌套数据', () => {
  const text = '{"seed":"9223372036854775807","nested":{"cfg":4},"custom":"原值"}';
  const changed = output.changeVideoParameterText(text, 'duration', '8');
  assert.equal(changed.issue, ''); assert.deepEqual(changed.value, { seed: '9223372036854775807', nested: { cfg: 4 }, custom: '原值', duration: 8 });
  assert.equal(text, '{"seed":"9223372036854775807","nested":{"cfg":4},"custom":"原值"}');
});
test('分辨率原样保留大小写与自定义格式，宽高互不推导', () => {
  const resolution = output.changeVideoParameterText('{"width":1280}', 'resolution', '1080P');
  assert.deepEqual(resolution.value, { width: 1280, resolution: '1080P' });
  const custom = output.changeVideoParameterText(resolution.text, 'resolution', '2048x1080 custom');
  assert.equal(custom.value.resolution, '2048x1080 custom'); assert.equal(custom.value.height, undefined);
  const width = output.changeVideoParameterText(custom.text, 'width', '1920'); assert.equal(width.value.width, 1920); assert.equal(width.value.height, undefined);
});
test('清空仅删除指定覆盖值，不转成 0/null 或修改其他参数', () => {
  const changed = output.changeVideoParameterText('{"duration":8,"resolution":"720p","seed":42}', 'duration', ' ');
  assert.deepEqual(changed.value, { resolution: '720p', seed: 42 });
  assert.equal(output.changeVideoParameterText(changed.text, 'resolution', '').value.resolution, undefined);
});
test('无效 JSON 保持原文本，数组/null 不被重建为默认参数', () => {
  for (const text of ['{"seed":', '[1,2]', 'null']) {
    const changed = output.changeVideoParameterText(text, 'duration', '8'); assert.equal(changed.text, text); assert.match(changed.issue, /原文本已保留/u);
  }
});
test('无操作编辑不重排原 JSON，冻结重试 baseline 不变', () => {
  const text = '{ "duration" : 8, "seed":42 }';
  assert.equal(output.changeVideoParameterText(text, 'duration', '8').text, text);
  assert.equal(output.changeVideoParameterText(text, 'resolution', '').text, text);
  assert.equal(output.readVideoParameterText(text).value.duration, 8);
});
test('部分数字文本继续可输入，长数字文本不会主动舍入', () => {
  assert.equal(output.changeVideoParameterText('{}', 'duration', '1.').value.duration, '1.');
  assert.equal(output.changeVideoParameterText('{}', 'duration', '1.5').value.duration, 1.5);
  assert.equal(output.changeVideoParameterText('{}', 'seed', '9223372036854775807').value.seed, '9223372036854775807');
});
test('已有裸64bit seed包括嵌套位置在解析前拒绝，编辑无关时长不舍入原文', () => {
  for (const text of ['{"seed":9223372036854775807}', '{"nested":[{"seed":18446744073709551615}],"duration":6}', '{"value":1e999}']) {
    const result = output.changeVideoParameterText(text, 'duration', '8'); assert.equal(result.text, text); assert.match(result.issue, /安全精度/u); assert.match(output.readVideoParameterText(text).issue, /双引号/u);
  }
  const safeText = '{"seed":"9223372036854775807","nested":{"quoted":"\\\"18446744073709551615\\\""},"duration":6}';
  const result = output.changeVideoParameterText(safeText, 'duration', '8'); assert.equal(result.issue, ''); assert.equal(result.value.seed, '9223372036854775807'); assert.deepEqual(result.value.nested, { quoted: '"18446744073709551615"' });
});
test('缺少映射的时长和分辨率常显但禁用，不会渲染时写入默认值', () => {
  const changes: unknown[] = []; let opened = 0;
  const tree = Output({ scope: 'single', source: 'runninghub', availableKeys: [], parameterText: '{}', onChange: (...args) => changes.push(args), onOpenSettings: () => { opened += 1; } });
  assert.equal(input(tree, '本次视频时长（秒）').props.disabled, true); assert.equal(input(tree, '本次视频分辨率').props.disabled, true); assert.deepEqual(changes, []);
  nodesOf(tree).find((node) => node.type === 'button')!.props.onClick(); assert.equal(opened, 1);
});
test('像素型工作流显示独立宽高，只有单字段分辨率时不创建宽高', () => {
  const render = (keys: string[]) => Output({ scope: 'batch', source: 'comfyui', availableKeys: keys, parameterText: '{}', onChange: () => assert.fail('render cannot write') });
  const pixels = render(['width', 'height']); assert.equal(input(pixels, '批量视频宽度（像素）').props.disabled, false); assert.equal(input(pixels, '批量视频高度（像素）').props.disabled, false);
  assert.equal(nodesOf(pixels).some((node) => node.props['aria-label'] === '批量视频分辨率'), false);
  const both = render(['duration', 'resolution', 'width', 'height']); assert.equal(input(both, '批量视频分辨率').props.disabled, false);
  assert.equal(input(render(['width']), '批量视频高度（像素）').props.disabled, true);
});
test('已有但不再映射的canonical覆盖仍显示并可清除；锁定时不能清除', () => {
  const changes: unknown[] = [];
  const props: VideoOutputParametersProps = { scope: 'single', source: 'runninghub', availableKeys: ['width'], parameterText: '{"duration":8,"resolution":"720P","height":1080}', onChange: (...args) => changes.push(args) };
  const tree = Output(props);
  for (const label of ['本次视频时长（秒）', '本次视频分辨率', '本次视频高度（像素）']) {
    assert.equal(input(tree, label).props.disabled, true);
    const clear = nodesOf(tree).find((node) => node.props['aria-label'] === `清除${label}覆盖`)!; assert.equal(clear.props.disabled, false); clear.props.onClick();
  }
  assert.deepEqual(changes, [['duration', ''], ['resolution', ''], ['height', '']]);
  assert.ok(nodesOf(Output({ ...props, disabled: true })).filter((node) => node.type === 'button').every((node) => node.props.disabled));
});
test('普通API已有JSON宽高按原协议可编辑，不声称存在节点绑定', () => {
  const tree = Output({ scope: 'single', source: 'api', availableKeys: ['duration', 'resolution'], parameterText: '{"width":1280,"height":720}', onChange: () => {} });
  assert.equal(input(tree, '本次视频宽度（像素）').props.disabled, false); assert.doesNotMatch(textOf(tree), /未绑定|节点/u);
});
test('错误 JSON 确实阻止快捷重建，并在原位置显示修复说明', () => {
  const tree = Output({ scope: 'single', source: 'api', availableKeys: ['duration', 'resolution'], parameterText: '{"seed":', onChange: () => assert.fail('must not edit') });
  assert.equal(input(tree, '本次视频时长（秒）').props.disabled, true); assert.match(textOf(tree), /原文本已保留/u);
});
test('批量请求摘要不把每段时长说成全片总时长', () => {
  assert.equal(output.videoOutputParameterSummary({ duration: 8, resolution: '1080P', width: 1920, height: 1080 }), '请求时长 8 秒 · 请求分辨率 1080P · 请求宽度 1920 像素 · 请求高度 1080 像素');
  assert.equal(output.videoOutputParameterSummary({ seed: 1, frames: 120 }), '');
  assert.match(textOf(Output({ scope: 'batch', source: 'api', availableKeys: ['duration', 'resolution'], parameterText: '{}', onChange: () => {} })), /每段统一覆盖时长，不是全片总时长/u);
});
test('紧凑批量说明保留映射警告、配置入口和可展开帮助，单段结构不变', () => {
  let opened = 0;
  const props: VideoOutputParametersProps = { scope: 'batch', source: 'runninghub', availableKeys: ['duration'], parameterText: '{}', onChange: () => assert.fail('render cannot write'), onOpenSettings: () => { opened += 1; } };
  const tree = Output(props);
  const notes = nodesOf(tree).find((node) => node.props.className === 'vop-batch-notes');
  assert.ok(notes, 'batch notes share a wrapping footer');
  assert.match(textOf(notes), /每段统一覆盖时长，不是全片总时长/u);
  assert.match(textOf(notes), /尚未绑定分辨率/u);
  assert.ok(nodesOf(notes).some((node) => node.type === 'details' && !node.props.open), 'help starts folded and remains expandable');
  nodesOf(notes).find((node) => node.type === 'button')!.props.onClick();
  assert.equal(opened, 1);
  assert.equal(nodesOf(Output({ ...props, scope: 'single' })).some((node) => node.props.className === 'vop-batch-notes'), false, 'single-generation notes keep their original structure');
});

const fixture = () => {
  const state = createInitialState(); const project = state.project; const settings = state.settings;
  project.id = `output-test-${Math.random()}`; project.assets = []; project.generationTasks = [];
  settings.videoBackend = 'api'; settings.videoSource = 'api'; settings.activeVideoApiProfileId = null; settings.videoApiProfiles = [];
  settings.videoTaskApi = { ...settings.videoTaskApi, enabled: true, provider: 'generic', model: 'test-model', apiKey: '', endpoint: 'https://video.example.test/generate', statusEndpointTemplate: 'https://video.example.test/status/{id}', requestTemplate: '' };
  const boards: Storyboard[] = [1, 2].map((index) => ({
    id: `board-${index}`, sceneId: project.scenes[0].id, sourceStoryTitle: '两段剧情', workflow: 'drama', inputMode: 'text_reference', durationSec: 10, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', globalReferenceAssetIds: [], shots: [], finalPrompt: `第${index}段保持原文`, officialPromptZh: `第${index}段保持原文`, sequencePlanId: 'plan', segmentId: `segment-${index}`, segmentIndex: index, segmentCount: 2, createdAt: 1, updatedAt: index,
  }));
  const plan: VideoSequencePlan = { id: 'plan', title: '两段剧情', sourceStoryTitle: '两段剧情', sourceStoryContent: '原始全文', durationMode: 'ai-estimated', totalDurationSec: 20, segmentDurationSec: 10, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', createdAt: 1, updatedAt: 1, segments: boards.map((board, index) => ({
    id: board.segmentId!, index: index + 1, title: `片段${index + 1}`, globalStartSec: index * 10, globalEndSec: (index + 1) * 10, durationSec: 10, content: `原文${index + 1}`, summary: '', sourceSceneIds: [board.sceneId], sourceBeatIds: [], narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: board.id, status: 'ready',
  })) };
  project.storyboards = boards; project.sequencePlans = [plan];
  return { project, settings };
};
const cloudFixture = () => {
  const value = fixture(); const workflow = runningHub.createRunningHubTutorialVideoWorkflow();
  workflow.id = 'cloud'; workflow.name = '测试云端'; workflow.mapping.images = [];
  workflow.requestTemplate = runningHub.ensureRunningHubVideoRequestNode(workflow.requestTemplate, { nodeId: 'size-node', fieldName: 'value', fieldValue: '720p' });
  workflow.mapping.parameters = { ...workflow.mapping.parameters, resolution: { nodeId: 'size-node', inputName: 'value' } };
  value.settings.videoSource = 'runninghub'; value.settings.runningHubVideo = { enabled: true, apiKey: '', baseUrl: 'https://runninghub.example.test', activeWorkflowId: workflow.id, workflows: [workflow] };
  return value;
};
interface Slot { value?: any; deps?: readonly unknown[]; cleanup?: () => void }
const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));

// Run the real director/batch callbacks with isolated hooks and a recording-only controller.
function harness(kind: 'single' | 'batch', initial = fixture(), extras: Props = {}) {
  let props: Props = { ...initial, ...extras }; let cursor = 0; let rerender = true; let effects: Array<() => void> = []; const slots: Slot[] = [];
  const starts: VideoGenerationDraft[] = []; const batches: VideoBatchStartInput[] = [];
  const controller = { start: async (draft: VideoGenerationDraft) => { starts.push(structuredClone(draft)); return 'task'; }, startBatch: async (value: VideoBatchStartInput) => { batches.push(structuredClone(value)); return { batchId: 'batch', taskIds: ['1', '2'], skipped: [] }; } };
  const hooks = {
    useState: (initialValue: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }; return [slots[index].value, (next: any) => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; rerender = true; } }]; },
    useRef: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    useMemo: (fn: () => unknown, deps?: readonly unknown[]) => { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) { const previous = slots[index]; slots[index] = { ...previous, deps }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = fn() || undefined; }); } },
  };
  const modules: Record<string, unknown> = {
    '../videoH3ReferenceBinding': h3ReferenceBinding,
    react: { ...React, ...hooks }, '../media': { assetPreviewUrl: () => '' }, '../userFacingError': { formatUserFacingError: String },
    '../errorDiagnostics': errorDiagnostics, '../videoTaskErrorDiagnostics': videoTaskErrorDiagnostics,
    './TaskErrorDetails': { TaskErrorDetails: () => null },
    './ReferenceImageName': { ReferenceImageName: ({ name }: { name: string }) => React.createElement('strong', null, name) },
    './VideoExecutionControls': { VideoExecutionControls: () => null },
    '../videoResultRecovery': {}, '../comfyuiVideo': {}, '../videoGenerationSource': source, '../runningHubVideo': runningHub,
    '../videoOutputParameters': output, './VideoOutputParameters': { VideoOutputParameters: Output }, '../videoRuntimeStore': {},
    '../videoProvenance': provenance, '../videoDirectorReferences': references, '../videoDirectorDraft': drafts,
    '../videoBatch': batch, '../videoBatchSelection': selection, './PreviousVideoTailDialog': { PreviousVideoTailDialog: () => null }, '../videoTailReference': tails, '../videoTailCharacters': tailCharacters, '../videoReferenceUsage': referenceUsage, '../videoReferenceSlots': referenceSlots,
  };
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', 'React', `${compile('VideoDirectorView')}\nmodule.exports.VideoBatchPanel = VideoBatchPanel;`)((name: string) => {
    if (name.endsWith('.css')) return {}; if (name in modules) return modules[name]; throw new Error(`Unexpected director import ${name}`);
  }, module, module.exports, React);
  let tree: React.ReactElement;
  const noChange = () => {};
  const render = () => {
    let attempts = 0;
    do {
      assert.ok(attempts++ < 20, 'hooks settle'); cursor = 0; rerender = false;
      tree = module.exports[kind === 'single' ? 'VideoDirectorView' : 'VideoBatchPanel']({
        controller, initialDraft: drafts.emptyVideoDraft(props.settings), initialParameterText: '{}', onSubmittingChange: noChange, ...props,
      });
      const pending = effects; effects = []; pending.forEach((effect) => effect());
    } while (rerender);
  };
  const find = (type: string, label: string) => nodesOf(tree).find((node) => node.type === type && (node.props['aria-label'] === label || textOf(node.props.children) === label));
  const required = (type: string, label: string) => { const node = find(type, label); assert.ok(node, `missing ${type} ${label}`); return node; };
  const change = (type: string, label: string, value: string | boolean) => { const node = required(type, label); assert.ok(!node.props.disabled, `${label} must be enabled`); node.props.onChange({ target: { value, checked: value } }); render(); };
  const click = (label: string) => { const node = required('button', label); assert.ok(!node.props.disabled, `${label} must be enabled`); node.props.onClick(); render(); };
  render();
  return { starts, batches, required, find, change, click, render, text: () => textOf(tree), visibleText: () => visibleTextOf(tree), nodes: () => nodesOf(tree),
    update: (patch: Props) => { props = { ...props, ...patch }; render(); },
    output: () => nodesOf(tree).find((node) => node.type === Output)!,
    dispose: () => slots.forEach((slot) => slot.cleanup?.()),
  };
}

const batchSettingsRegion = (h: ReturnType<typeof harness>, collapsed: boolean) => {
  const toggle = h.required('button', collapsed ? '展开批量设置' : '收起批量设置');
  assert.equal(toggle.props.type, 'button', 'a native non-submit button supports keyboard activation');
  assert.notEqual(toggle.props.tabIndex, -1, 'toggle stays in the native tab order');
  assert.ok(!toggle.props.disabled, 'pure display toggle stays enabled');
  assert.equal(toggle.props['aria-expanded'], !collapsed);
  const targetId = toggle.props['aria-controls'];
  assert.equal(typeof targetId, 'string'); assert.ok(targetId.trim());
  const targets = h.nodes().filter((node) => node.props.id === targetId);
  assert.equal(targets.length, 1, 'aria-controls resolves to exactly one mounted region');
  const region = targets[0]; assert.equal(Boolean(region.props.hidden), collapsed);
  const descendants = nodesOf(region);
  for (const label of ['批量全片计划', '批量生成方式', '搜索批量视频段', '重新生成已成功项', '批量视频时长（秒）', '批量公共参数 JSON']) {
    assert.ok(descendants.some((node) => node.props['aria-label'] === label), `${label} stays mounted inside the fold`);
  }
  assert.ok(!descendants.includes(toggle), 'toggle must not hide itself');
  for (const label of ['分段清单', '当前段预览']) assert.ok(!descendants.includes(h.required('button', label)), `${label} stays outside the fold`);
  const submit = h.nodes().find((node) => node.type === 'button' && /^检查并生成 \d+ 段视频$/u.test(textOf(node.props.children)));
  assert.ok(submit); assert.ok(!descendants.includes(submit), 'submission stays outside the fold');
  return region;
};

const applyBatchReferences = (h: ReturnType<typeof harness>, segment: number, references: VideoGenerationDraft['references']) => {
  h.click(`第 ${segment} 段选择参考图`);
  const picker = h.nodes().find((node) => typeof node.type === 'function' && node.type.name === 'VideoBatchImagePicker');
  assert.ok(picker, 'real batch image picker callback is mounted');
  picker.props.onApply(references); picker.props.onClose(); h.render();
};

test('批量折叠默认展开，所有配置保持挂载，折叠外的选段和预览仍可操作', () => {
  const initial = fixture();
  initial.project.assets.push({ id: 'fold-image', name: '折叠测试参考图', type: 'reference', role: 'style', mediaType: 'image', tags: [], createdAt: 1, updatedAt: 1 });
  const originalProject = JSON.stringify(initial.project); const h = harness('batch', initial);
  batchSettingsRegion(h, false);
  h.click('全选中文'); h.change('textarea', '批量公共参数 JSON', '{"seed":"9223372036854775807","custom":{"keep":true}}');
  h.change('input', '批量视频时长（秒）', '8'); h.change('input', '批量视频分辨率', '1080P');
  applyBatchReferences(h, 1, [{ assetId: 'fold-image', role: 'first-frame' }]);
  h.change('input', '搜索批量视频段', '1'); h.change('input', '重新生成已成功项', true);
  const parameterText = h.required('textarea', '批量公共参数 JSON').props.value;
  h.click('收起批量设置'); batchSettingsRegion(h, true);
  assert.equal(h.required('textarea', '批量公共参数 JSON').props.value, parameterText);
  assert.equal(h.required('input', '搜索批量视频段').props.value, '1');
  assert.equal(h.required('input', '重新生成已成功项').props.checked, true);
  assert.equal(h.required('input', '选择第 1 段').props.checked, true);
  assert.equal(h.required('button', '检查并生成 2 段视频').props.disabled, false);
  const summary = visibleTextOf(h.required('div', '当前批量设置摘要'));
  assert.match(summary, /两段剧情/u); assert.match(summary, /视频 API · test-model/u);
  assert.match(summary, /请求时长 8 秒 · 请求分辨率 1080P/u);
  assert.match(summary, /筛选[^。\n]*1/u); assert.match(summary, /重新生成/u);
  h.click('当前段预览'); assert.equal(h.required('button', '当前段预览').props['aria-selected'], true);
  h.click('分段清单'); assert.equal(h.required('button', '分段清单').props['aria-selected'], true);
  h.change('input', '选择第 1 段', false); assert.equal(h.required('button', '检查并生成 1 段视频').props.disabled, false);
  h.change('input', '选择第 1 段', true);
  h.click('展开批量设置'); batchSettingsRegion(h, false);
  assert.equal(h.required('textarea', '批量公共参数 JSON').props.value, parameterText);
  assert.equal(h.required('input', '批量视频时长（秒）').props.value, '8');
  assert.equal(h.required('input', '批量视频分辨率').props.value, '1080P');
  assert.equal(h.required('input', '搜索批量视频段').props.value, '1');
  assert.equal(h.required('input', '重新生成已成功项').props.checked, true);
  assert.equal(h.required('select', '批量全片计划').props.value, 'plan');
  assert.equal(h.required('select', '批量生成方式').props.value, 'api');
  h.change('input', '搜索批量视频段', ''); assert.equal(h.required('input', '选择第 2 段').props.checked, true);
  h.click('第 1 段选择参考图');
  const picker = h.nodes().find((node) => typeof node.type === 'function' && node.type.name === 'VideoBatchImagePicker')!;
  assert.deepEqual(picker.props.references, [{ assetId: 'fold-image', role: 'first-frame' }]);
  assert.equal(h.starts.length, 0); assert.equal(h.batches.length, 0); assert.equal(JSON.stringify(initial.project), originalProject); h.dispose();
});

test('收起设置后仍可确认批量提交，参数、勾选和各段独立参考图不丢失', () => {
  const initial = fixture();
  initial.project.assets.push({ id: 'fold-submit-image', name: '首帧', type: 'first-frame', role: 'first-frame', mediaType: 'image', tags: [], createdAt: 1, updatedAt: 1 });
  const h = harness('batch', initial);
  h.click('全选中文'); h.change('textarea', '批量公共参数 JSON', '{"seed":42,"custom":{"keep":"原值"}}');
  h.change('input', '批量视频时长（秒）', '6'); h.change('input', '批量视频分辨率', '720P');
  applyBatchReferences(h, 1, [{ assetId: 'fold-submit-image', role: 'first-frame' }]);
  h.click('收起批量设置'); batchSettingsRegion(h, true); h.click('检查并生成 2 段视频');
  assert.equal(h.batches.length, 0, 'folding and preparing confirmation cannot submit a task');
  assert.match(h.visibleText(), /请求时长 6 秒 · 请求分辨率 720P/u);
  h.change('input', '确认批量生成费用', true); h.click('确认生成 2 段');
  assert.equal(h.batches.length, 1); assert.equal(h.batches[0].items.length, 2);
  for (const item of h.batches[0].items) assert.deepEqual(item.draft.parameters, { seed: 42, custom: { keep: '原值' }, duration: 6, resolution: '720P' });
  assert.deepEqual(h.batches[0].items[0].draft.references, [{ assetId: 'fold-submit-image', role: 'first-frame' }]);
  assert.deepEqual(h.batches[0].items[1].draft.references, []); h.dispose();
});

test('错误JSON收起后仍有可见修复提醒，原文本不丢且不能绕过提交检查', () => {
  const h = harness('batch'); h.click('全选中文'); h.change('textarea', '批量公共参数 JSON', '{"seed":');
  h.click('收起批量设置'); batchSettingsRegion(h, true);
  const summary = visibleTextOf(h.required('div', '当前批量设置摘要'));
  assert.match(summary, /JSON/u); assert.match(summary, /展开/u); assert.match(summary, /原文本已保留/u);
  assert.equal(h.required('textarea', '批量公共参数 JSON').props.value, '{"seed":');
  assert.equal(h.required('button', '检查并生成 2 段视频').props.disabled, true);
  assert.equal(h.batches.length, 0); h.click('展开批量设置');
  assert.equal(h.required('textarea', '批量公共参数 JSON').props.value, '{"seed":');
  h.change('textarea', '批量公共参数 JSON', '{"duration":8}'); h.click('收起批量设置');
  assert.equal(h.required('button', '检查并生成 2 段视频').props.disabled, false);
  assert.match(h.visibleText(), /请求时长 8 秒/u); assert.equal(h.batches.length, 0); h.dispose();
});

test('单段真实组件：未失焦 JSON 与快捷输入合并，未改 prompt，未提交前无请求', () => {
  const h = harness('single');
  h.change('textarea', '本次生成使用的完整提示词', '原文保持 10 秒，不自动改写');
  h.change('textarea', '本次额外参数 JSON', '{"seed":42,"custom":{"keep":"原值"}}');
  h.change('input', '本次视频时长（秒）', '8'); h.change('input', '本次视频分辨率', '1080P');
  assert.equal(h.starts.length, 0); assert.equal(h.required('textarea', '本次生成使用的完整提示词').props.value, '原文保持 10 秒，不自动改写');
  h.click('生成视频'); assert.deepEqual(h.starts[0].parameters, { seed: 42, custom: { keep: '原值' }, duration: 8, resolution: '1080P' });
  h.dispose();
});
test('单段真实组件：错误 JSON 保留，修复后输入恢复；不可映射值不隐藏控件', () => {
  const h = harness('single', cloudFixture());
  h.change('textarea', '本次额外参数 JSON', '{"unknown":1,"duration":"坏数值"}');
  assert.equal(h.required('input', '本次视频时长（秒）').props.disabled, false);
  h.change('input', '本次视频时长（秒）', '8'); assert.equal(JSON.parse(h.required('textarea', '本次额外参数 JSON').props.value).unknown, 1);
  h.change('textarea', '本次额外参数 JSON', '{"seed":'); assert.equal(h.required('input', '本次视频时长（秒）').props.disabled, true); assert.match(h.text(), /原文本已保留/u);
  assert.equal(h.required('textarea', '本次额外参数 JSON').props.value, '{"seed":');
  h.change('textarea', '本次额外参数 JSON', '{}'); assert.equal(h.required('input', '本次视频时长（秒）').props.disabled, false); h.dispose();
});
test('单段与批量明确提交也拒绝裸长数，不绕过读取保护', () => {
  const text = '{"nested":{"seed":9223372036854775807},"duration":8}';
  const single = harness('single'); single.change('textarea', '本次生成使用的完整提示词', '原文'); single.change('textarea', '本次额外参数 JSON', text); single.click('生成视频');
  assert.equal(single.starts.length, 0); assert.equal(single.required('textarea', '本次额外参数 JSON').props.value, text); assert.match(single.text(), /安全精度/u); single.dispose();
  const multi = harness('batch'); multi.click('全选中文'); multi.change('textarea', '批量公共参数 JSON', text);
  assert.equal(multi.required('button', '检查并生成 2 段视频').props.disabled, true);
  multi.required('button', '检查并生成 2 段视频').props.onClick(); multi.render(); assert.equal(multi.batches.length, 0); assert.match(multi.text(), /安全精度/u); multi.dispose();
});
test('真实工作流 A→B→A 切换分别保留覆盖，不把分辨率档位带进像素工作流', () => {
  const initial = cloudFixture(); const a = initial.settings.runningHubVideo!.workflows[0]; const b = structuredClone(a); b.id = 'pixels'; b.name = '像素工作流';
  b.requestTemplate = runningHub.ensureRunningHubVideoRequestNode(b.requestTemplate, { nodeId: 'pixels', fieldName: 'width', fieldValue: 1280 });
  b.requestTemplate = runningHub.ensureRunningHubVideoRequestNode(b.requestTemplate, { nodeId: 'pixels', fieldName: 'height', fieldValue: 720 });
  b.mapping.parameters = { width: { nodeId: 'pixels', inputName: 'width' }, height: { nodeId: 'pixels', inputName: 'height' } }; initial.settings.runningHubVideo!.workflows.push(b);
  const h = harness('single', initial); h.change('input', '本次视频时长（秒）', '8'); h.change('input', '本次视频分辨率', '720P');
  h.change('select', 'RunningHub 云端工作流', b.id);
  assert.equal(h.find('input', '本次视频分辨率'), undefined);
  assert.deepEqual(JSON.parse(h.required('textarea', '本次额外参数 JSON').props.value), {});
  h.change('input', '本次视频宽度（像素）', '1920');
  h.change('select', 'RunningHub 云端工作流', a.id);
  assert.deepEqual(JSON.parse(h.required('textarea', '本次额外参数 JSON').props.value), { duration: 8, resolution: '720P' });
  h.change('select', 'RunningHub 云端工作流', b.id);
  assert.deepEqual(JSON.parse(h.required('textarea', '本次额外参数 JSON').props.value), { width: 1920 }); assert.equal(h.starts.length, 0); h.dispose();
});
test('单段真实组件：项目切换保持各自覆盖草稿，不串写', () => {
  const a = fixture(); const b = fixture(); const h = harness('single', a);
  h.change('input', '本次视频时长（秒）', '8'); h.update(b);
  assert.equal(h.required('input', '本次视频时长（秒）').props.value, ''); h.change('input', '本次视频时长（秒）', '6');
  h.update(a); assert.equal(h.required('input', '本次视频时长（秒）').props.value, '8'); h.dispose();
});
test('单段冻结云端重试使用原映射能力，不受当前工作流解绑影响', () => {
  const initial = cloudFixture(); const config = initial.settings.runningHubVideo!;
  const api = runningHub.compileRunningHubVideoApi(config, 'cloud');
  const saved: VideoGenerationTask = { id: 'frozen-cloud', kind: 'video', status: 'failed', targetId: 'test', storyboardId: '', requestBody: {}, createdAt: 1, updatedAt: 2,
    videoJob: { stage: 'failed', snapshot: { projectId: initial.project.id, clientId: 'client', images: [], connection: { backend: 'api', api },
      draft: { ...drafts.emptyVideoDraft(initial.settings), prompt: '冻结原文', parameters: { duration: 8, resolution: '1080P' } } } },
  };
  initial.project.generationTasks = [saved]; config.workflows[0].mapping.parameters = {};
  const h = harness('single', initial, { launchRequest: { id: 'launch-frozen', taskId: saved.id } });
  assert.equal(h.required('input', '本次视频时长（秒）').props.disabled, false);
  assert.equal(h.required('input', '本次视频分辨率').props.value, '1080P');
  h.change('input', '本次视频时长（秒）', '9'); h.click('生成视频');
  assert.equal(h.starts[0].reuseTaskId, saved.id); assert.equal(h.starts[0].parameters.duration, 9);
  assert.equal(saved.videoJob!.snapshot.draft.parameters.duration, 8); h.dispose();
});
test('批量真实组件：逐段参数覆盖与确认摘要一致，不改原稿和原计划时长', () => {
  const initial = fixture(); const original = JSON.stringify(initial.project); const h = harness('batch', initial);
  h.change('textarea', '批量公共参数 JSON', '{"seed":42,"custom":"keep"}'); h.change('input', '批量视频时长（秒）', '8'); h.change('input', '批量视频分辨率', '1080P');
  h.click('全选中文'); assert.match(h.text(), /原分段计划 10 秒/u); assert.match(h.text(), /请求时长 8 秒 · 请求分辨率 1080P/u);
  h.click('检查并生成 2 段视频'); assert.match(h.text(), /请求时长 8 秒 · 请求分辨率 1080P/u);
  assert.equal(h.batches.length, 0); h.change('input', '确认批量生成费用', true); h.click('确认生成 2 段');
  assert.equal(h.batches.length, 1); assert.equal(h.batches[0].items.length, 2);
  for (const item of h.batches[0].items) { assert.deepEqual(item.draft.parameters, { seed: 42, custom: 'keep', duration: 8, resolution: '1080P' }); assert.match(item.draft.prompt, /保持原文/u); }
  assert.equal(JSON.stringify(initial.project), original); h.dispose();
});
test('单段与批量初次继承后独立，快捷参数不会反向改写单段', () => {
  const initial = fixture(); const single = harness('single', initial); single.change('input', '本次视频时长（秒）', '8');
  single.click('长剧情批量'); const pane = harness('batch', initial, { initialParameterText: single.required('textarea', '本次额外参数 JSON').props.value });
  assert.equal(pane.required('input', '批量视频时长（秒）').props.value, '8'); pane.change('input', '批量视频时长（秒）', '6');
  assert.equal(single.required('input', '本次视频时长（秒）').props.value, '8'); single.dispose(); pane.dispose();
});
const addRetryTasks = ({ project, settings }: { project: Project; settings: AppSettings }) => {
  const ids = ['retry-1', 'retry-2'];
  project.generationTasks = ids.map((id, offset): VideoGenerationTask => ({
    id, kind: 'video', targetId: 'saved', storyboardId: `board-${offset + 1}`, sequencePlanId: 'plan', segmentId: `segment-${offset + 1}`, status: 'failed', requestBody: {}, createdAt: 1, updatedAt: 2,
    videoJob: { stage: 'failed', snapshot: { projectId: project.id, clientId: id, images: [], connection: { backend: 'api', api: { ...settings.videoTaskApi, model: '原连接快照' } }, draft: { name: id, prompt: `冻结原文${offset + 1}`, backend: 'api', references: [], parameters: { duration: offset ? 6 : 8, resolution: offset ? '720p' : '1080P', seed: offset + 1 }, source: { sequencePlanId: 'plan', segmentId: `segment-${offset + 1}`, storyboardId: `board-${offset + 1}`, language: 'zh' } } } },
  }));
  return ids;
};
test('冻结失败批次折叠往返不转换成公共覆盖，确认仍保留各段原始参数', () => {
  const initial = fixture(); const ids = addRetryTasks(initial); const saved = JSON.stringify(initial.project.generationTasks);
  const h = harness('batch', initial, { retryTaskIds: ids });
  const baseline = h.required('textarea', '批量公共参数 JSON').props.value;
  h.click('收起批量设置'); batchSettingsRegion(h, true);
  const summary = visibleTextOf(h.required('div', '当前批量设置摘要'));
  assert.match(summary, /失败重试项保留各段原参数；时长与分辨率请在确认清单逐段核对。/u);
  assert.doesNotMatch(summary, /请求时长 8 秒|请求分辨率 1080P/u, 'the first retry item must not be presented as a batch-wide override');
  h.click('展开批量设置'); batchSettingsRegion(h, false);
  h.click('收起批量设置'); batchSettingsRegion(h, true);
  assert.equal(h.required('textarea', '批量公共参数 JSON').props.value, baseline); assert.equal(h.batches.length, 0);
  h.click('检查并生成 2 段视频'); h.change('input', '确认批量生成费用', true); h.click('确认生成 2 段');
  assert.deepEqual(h.batches[0].items.map((item) => item.draft.parameters), [{ duration: 8, resolution: '1080P', seed: 1 }, { duration: 6, resolution: '720p', seed: 2 }]);
  assert.equal(JSON.stringify(initial.project.generationTasks), saved); h.dispose();
});
test('失败批次不编辑时，每段不同冻结参数保持原样', () => {
  const initial = fixture(); const ids = addRetryTasks(initial); const h = harness('batch', initial, { retryTaskIds: ids });
  const baseline = h.required('textarea', '批量公共参数 JSON').props.value; h.render(); assert.equal(h.required('textarea', '批量公共参数 JSON').props.value, baseline);
  h.change('input', '批量视频时长（秒）', '8'); assert.equal(h.required('textarea', '批量公共参数 JSON').props.value, baseline, 'no-op cannot switch retry from per-task to common overrides');
  h.click('检查并生成 2 段视频'); h.change('input', '确认批量生成费用', true); h.click('确认生成 2 段');
  assert.deepEqual(h.batches[0].items.map((item) => item.draft.parameters), [{ duration: 8, resolution: '1080P', seed: 1 }, { duration: 6, resolution: '720p', seed: 2 }]); h.dispose();
});
test('失败批次显式改动后才统一覆盖，旧任务快照不变', () => {
  const initial = fixture(); const ids = addRetryTasks(initial); const previous = JSON.stringify(initial.project.generationTasks); const h = harness('batch', initial, { retryTaskIds: ids });
  h.change('input', '批量视频时长（秒）', '9'); h.click('检查并生成 2 段视频'); h.change('input', '确认批量生成费用', true); h.click('确认生成 2 段');
  assert.ok(h.batches[0].items.every((item) => item.draft.parameters.duration === 9)); assert.equal(JSON.stringify(initial.project.generationTasks), previous); h.dispose();
});
test('RunningHub实际请求：时长保留云端标量类型，分辨率保留大小写，清空恢复原值', () => {
  const initial = cloudFixture(); const config = initial.settings.runningHubVideo!; const workflow = config.workflows[0];
  const parameters = output.changeVideoParameterText(output.changeVideoParameterText('{}', 'duration', '8').text, 'resolution', '1080P').value;
  const api = runningHub.compileRunningHubVideoApi(config, workflow.id, parameters);
  const draft: VideoGenerationDraft = { ...drafts.emptyVideoDraft(initial.settings), prompt: '原文', parameters };
  const body = buildVideoApiBody(api, draft, []) as { nodeInfoList: Array<{ nodeId: string; fieldValue: unknown }> };
  assert.equal(body.nodeInfoList.find((node) => node.nodeId === '132')?.fieldValue, '8'); assert.equal(body.nodeInfoList.find((node) => node.nodeId === 'size-node')?.fieldValue, '1080P');
  const original = JSON.parse(workflow.requestTemplate).nodeInfoList.find((node: { nodeId: string }) => node.nodeId === '132').fieldValue;
  const cleared = buildVideoApiBody(api, { ...draft, parameters: {} }, []) as typeof body;
  assert.equal(cleared.nodeInfoList.find((node) => node.nodeId === '132')?.fieldValue, original);
  assert.equal(cleared.nodeInfoList.find((node) => node.nodeId === 'size-node')?.fieldValue, '720p');
});
test('ComfyUI像素参数只覆盖显式宽度，不改高度、帧数和fps', () => {
  const preset = { workflowJson: JSON.stringify({ '1': { class_type: 'Input', inputs: { prompt: '', width: 1280, height: 720, frames: 121, fps: 24 } } }), mapping: { prompt: [{ nodeId: '1', inputName: 'prompt' }], images: [], parameters: { width: { nodeId: '1', inputName: 'width' }, height: { nodeId: '1', inputName: 'height' } } } };
  const nodes = bindComfyVideoWorkflow(preset, '原文', [], output.changeVideoParameterText('{}', 'width', '1920').value);
  assert.deepEqual(nodes['1'].inputs, { prompt: '原文', width: 1920, height: 720, frames: 121, fps: 24 });
});
test('旧Video API RunningHub模板按明确占位符开放参数，原提交协议不失效', () => {
  const initial = fixture(); initial.settings.videoTaskApi = { ...initial.settings.videoTaskApi, provider: 'runninghub', requestTemplate: JSON.stringify({ nodeInfoList: [
    { nodeId: '263', fieldName: 'text', fieldValue: '{{prompt}}' }, { nodeId: '7', fieldName: 'duration', fieldValue: '{{duration}}' }, { nodeId: '8', fieldName: 'resolution', fieldValue: '{{resolution}}' },
  ] }) };
  assert.deepEqual(output.availableVideoParameterKeys('api', initial.settings.videoTaskApi), ['duration', 'resolution']);
  assert.deepEqual(output.availableVideoParameterKeys('api', { provider: 'runninghub', requestTemplate: '{"duration":8,"resolution":"720p"}' }), []);
  assert.deepEqual(output.availableVideoParameterKeys('runninghub', initial.settings.videoTaskApi), [], 'independent workflows still require explicit mapping');
  const h = harness('single', initial); h.change('textarea', '本次生成使用的完整提示词', '原文'); h.change('input', '本次视频时长（秒）', '8'); h.change('input', '本次视频分辨率', '720P'); h.click('生成视频');
  const body = buildVideoApiBody(initial.settings.videoTaskApi, h.starts[0], []) as { nodeInfoList: Array<{ fieldValue: unknown }> };
  assert.deepEqual(body.nodeInfoList.map((node) => node.fieldValue), ['原文', 8, '720P']); h.dispose();
});

test('H3真实组件显示、复制、提交同一份引用绑定稿，移除和换图不重写对白', () => {
  const initial = fixture(); const board = initial.project.storyboards[0];
  const anchor = 'Identity: 合成人物 (S1), blue coat.';
  const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchor} 本段1–4秒：合成人物 (S1) says <d>[Chinese] 原话保持不变。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  initial.project.characters = [{ id: 'person', name: '合成人物', assetIds: ['identity'], gender: '', race: '人类', apparentAge: '成年', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' }];
  initial.project.assets = [{ id: 'identity', name: '身份图', type: 'character', role: 'character', sourceEntityId: 'person', sourceEntityKind: 'character', tags: [], createdAt: 1, updatedAt: 1 }];
  Object.assign(board, { officialPromptZh: prompt, finalPrompt: prompt, globalReferenceAssetIds: ['identity'], h3IdentityBindings: { version: 1, characters: [{ characterId: 'person', name: '合成人物', speakerToken: '(S1)', referenceAnchor: anchor }] } });
  const h = harness('single', initial, { launchRequest: { id: `h3-copy-${initial.project.id}`, storyboardId: board.id } });
  const displayed = h.required('textarea', '本次生成使用的完整提示词').props.value;
  assert.match(displayed, /合成人物 \(S1\): <Picture 1>/u);
  assert.match(displayed, /<d>\[Chinese\] 原话保持不变。<\/d>/u);
  h.click('移除图片 1');
  assert.equal(h.required('textarea', '本次生成使用的完整提示词').props.value, prompt);
  h.update({ launchRequest: { id: `h3-refill-${initial.project.id}`, assetIds: ['identity'] } });
  assert.equal(h.required('textarea', '本次生成使用的完整提示词').props.value, displayed);
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let copied = '';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: (text: string) => { copied = text; return Promise.resolve(); } } } });
  try { h.click('复制本次提示词'); assert.equal(copied, displayed); }
  finally { if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator'); }
  h.click('生成视频'); assert.equal(h.starts[0].prompt, displayed); assert.equal(board.officialPromptZh, prompt);
  h.dispose();
});

test('损坏导入人物绑定在真实选图组件中未绑定并提示，仍可提交且不猜测资产人物', () => {
  for (const malformed of [null, 123, 'person', ['person', 7]]) {
    const initial = fixture();
    const anchor = 'Identity: 合成人物 (S1), blue coat.';
    const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchor} 合成人物 (S1) says <d>[Chinese] 原话保持。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
    initial.project.characters = [{ id: 'person', name: '合成人物', assetIds: ['identity'], gender: '', race: '人类', apparentAge: '成年', appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' }];
    initial.project.assets = [{ id: 'identity', name: '损坏绑定的身份图', type: 'character', role: 'character', sourceEntityId: 'person', sourceEntityKind: 'character', tags: [], createdAt: 1, updatedAt: 1 }];
    const draft: VideoGenerationDraft = { name: '损坏元数据隔离测试', prompt, backend: 'api', parameters: {},
      references: [{ assetId: 'identity', role: 'character', slotIndex: 2, characterIds: malformed as unknown as string[] }],
      h3ReferenceBinding: { version: 1, projectId: initial.project.id, basePrompt: prompt, renderedPrompt: prompt,
        identities: { version: 1, characters: [{ characterId: 'person', name: '合成人物', speakerToken: '(S1)', referenceAnchor: anchor }] } } };
    const task: VideoGenerationTask = { id: 'corrupt-binding-task', kind: 'video', storyboardId: '', targetId: 'test-model',
      status: 'failed', requestBody: { prompt }, createdAt: 1, updatedAt: 1, videoJob: { stage: 'failed', snapshot: {
        projectId: initial.project.id, draft, clientId: 'synthetic-client',
        connection: { backend: 'api', api: initial.settings.videoTaskApi },
        images: [{ assetId: 'identity', role: 'character', slotIndex: 2, name: '损坏绑定的身份图', relativePath: 'image/synthetic.png', checksum: 'synthetic', freezeState: 'frozen' }],
      } } };
    initial.project.generationTasks.push(task);
    const saved = JSON.stringify(initial.project);
    const h = harness('single', initial, { launchRequest: { id: `corrupt-${initial.project.id}`, taskId: task.id } });
    // The hook harness only expands the root and parameter child; render the
    // extracted notice child explicitly so this still checks its real markup.
    const notices = h.nodes().find((node) => typeof node.type === 'function' && node.type.name === 'VideoH3ReferenceNotices');
    assert.ok(notices, 'frozen retry keeps the shared binding notice component');
    assert.match(textOf((notices.type as (props: Props) => React.ReactElement)(notices.props)), /人物绑定资料格式无效/u);
    assert.equal(h.required('textarea', '本次生成使用的完整提示词').props.value, prompt);
    h.click('从图片资产库选择');
    const panels = h.nodes().find((node) => typeof node.type === 'function' && node.type.name === 'VideoReferencePickerPanels');
    assert.ok(panels, 'the reference picker keeps its distinct image and slot panels');
    const editor = nodesOf(panels.props.slots).find((node) => typeof node.type === 'function' && node.type.name === 'VideoReferenceSlotUsageEditor');
    assert.ok(editor, 'the real per-slot editor is mounted');
    const renderedEditor = (editor.type as (props: Props) => React.ReactElement)(editor.props);
    assert.match(textOf(renderedEditor), /对应人物／形态：未绑定（不阻止生成）/u);
    assert.match(textOf(renderedEditor), /人物绑定资料格式无效/u);
    const checkboxes = nodesOf(renderedEditor).filter((node) => node.type === 'input' && node.props.type === 'checkbox');
    assert.equal(checkboxes.length, 1);
    assert.equal(checkboxes[0].props.checked, false, 'the asset owner cannot become an implicit selection');
    h.click('使用所选图片');
    assert.equal(h.required('textarea', '本次生成使用的完整提示词').props.value, prompt);
    h.click('生成视频');
    assert.equal(h.starts.length, 1, 'an optional identity warning never disables submission');
    assert.equal(h.starts[0].prompt, prompt);
    assert.deepEqual(h.starts[0].references, draft.references, 'the UI does not rewrite persisted invalid metadata or compact the slot');
    assert.equal(JSON.stringify(initial.project), saved);
    h.dispose();
  }
});

const mpFixture = () => {
  const initial = cloudFixture();
  const workflow = initial.settings.runningHubVideo!.workflows[0];
  workflow.requestTemplate = runningHub.ensureRunningHubVideoRequestNode(workflow.requestTemplate, { nodeId: 'mp', fieldName: 'megapixels', fieldValue: 0.5 });
  workflow.requestTemplate = runningHub.ensureRunningHubVideoRequestNode(workflow.requestTemplate, { nodeId: 'mp', fieldName: 'aspect_ratio', fieldValue: '16:9 (Widescreen)' });
  workflow.mapping.parameters!.resolution = { nodeId: 'mp', inputName: 'megapixels' };
  workflow.fieldControls = { '["mp","megapixels"]': { kind: 'select', unit: 'MP', min: 0.2, max: 1, step: 0.1,
    options: ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'],
    optionLabels: { '0.2': '608 × 352', '0.5': '960 × 544', '1.0': '1376 × 768' }, optionLabelAspectRatio: '16:9' } };
  const other = runningHub.copyRunningHubVideoWorkflow(cloudFixture().settings.runningHubVideo!.workflows[0]);
  other.id = 'other-resolution'; initial.settings.runningHubVideo!.workflows.push(other);
  return initial;
};

test('MP真实控件固定0.1档位并显示像素，历史非档位值只展示而不重写', () => {
  const initial = mpFixture(); const api = runningHub.compileRunningHubVideoApi(initial.settings.runningHubVideo!);
  const changes: unknown[] = [];
  const props: VideoOutputParametersProps = { scope: 'single', source: 'runninghub', parameterText: '{"resolution":"0.98"}', availableKeys: ['resolution'],
    ...output.videoOutputParameterPresentation(api), onChange: (...args) => changes.push(args) };
  const tree = Output(props);
  assert.equal(nodesOf(tree).find((node) => node.type === 'input' && node.props['aria-label'] === '本次视频分辨率'), undefined);
  const choices = nodesOf(tree).find((node) => node.type === 'select' && node.props['aria-label'] === '本次视频分辨率选项')!;
  assert.match(textOf(choices), /0\.5 MP（960 × 544）/u);
  assert.match(textOf(choices), /1\.0 MP（1376 × 768）/u);
  assert.equal(nodesOf(choices).filter((node) => node.type === 'option' && !node.props.disabled).length, 10);
  assert.equal(choices.props.value, '__custom__'); assert.deepEqual(changes, []);
  choices.props.onChange({ target: { value: 'value:0.98' } }); assert.deepEqual(changes, []);
  choices.props.onChange({ target: { value: 'value:1.0' } }); assert.deepEqual(changes, [['resolution', '1.0']]);
  choices.props.onChange({ target: { value: '__default__' } }); assert.deepEqual(changes[1], ['resolution', '']);
});

test('单段与批量MP/720P互切隔离草稿，恢复原覆盖，默认不覆盖请求', () => {
  for (const mode of ['single', 'batch'] as const) {
    const initial = mpFixture(); const h = harness(mode, initial); const prefix = mode === 'single' ? '本次' : '批量';
    const workflowLabel = mode === 'single' ? 'RunningHub 云端工作流' : '批量 RunningHub 云端工作流';
    const jsonLabel = mode === 'single' ? '本次额外参数 JSON' : '批量公共参数 JSON';
    h.change('select', `${prefix}视频分辨率选项`, 'value:1.0');
    assert.equal(JSON.parse(h.required('textarea', jsonLabel).props.value).resolution, '1.0');
    h.change('select', workflowLabel, 'other-resolution');
    assert.equal(h.required('input', `${prefix}视频分辨率`).props.value, '');
    h.change('input', `${prefix}视频分辨率`, '1080P');
    h.change('select', workflowLabel, 'cloud');
    assert.equal(h.required('select', `${prefix}视频分辨率选项`).props.value, 'value:1.0');
    h.change('select', `${prefix}视频分辨率选项`, '__default__');
    assert.deepEqual(JSON.parse(h.required('textarea', jsonLabel).props.value), {});
    h.change('select', workflowLabel, 'other-resolution');
    assert.equal(h.required('input', `${prefix}视频分辨率`).props.value, '1080P'); h.dispose();
  }
});

test('工作流切换保留尚未完成的JSON原文，不带进另一个工作流', () => {
  const h = harness('single', mpFixture()); const unfinished = '{ "resolution":';
  h.change('textarea', '本次额外参数 JSON', unfinished);
  h.change('select', 'RunningHub 云端工作流', 'other-resolution');
  assert.equal(h.required('textarea', '本次额外参数 JSON').props.value, '{}');
  h.change('select', 'RunningHub 云端工作流', 'cloud');
  assert.equal(h.required('textarea', '本次额外参数 JSON').props.value, unfinished); h.dispose();
});

test('单段和批量比例覆盖即时隐藏不匹配尺寸，切回16:9恢复标签而不改MP值', () => {
  for (const mode of ['single', 'batch'] as const) {
    const initial = mpFixture(); const workflow = initial.settings.runningHubVideo!.workflows[0];
    workflow.mapping.parameters!.aspect = { nodeId: 'mp', inputName: 'aspect_ratio' };
    const h = harness(mode, initial); const prefix = mode === 'single' ? '本次' : '批量';
    const jsonLabel = mode === 'single' ? '本次额外参数 JSON' : '批量公共参数 JSON';
    h.change('select', `${prefix}视频分辨率选项`, 'value:0.5');
    assert.match(textOf(h.required('select', `${prefix}视频分辨率选项`)), /960 × 544/u);
    h.change('textarea', jsonLabel, '{"resolution":"0.5","aspect":"9:16 (Portrait Widescreen)"}');
    assert.doesNotMatch(textOf(h.required('select', `${prefix}视频分辨率选项`)), /960 × 544/u);
    assert.equal(h.required('select', `${prefix}视频分辨率选项`).props.value, 'value:0.5');
    h.change('textarea', jsonLabel, '{"resolution":"0.5","aspect":"16:9 (Widescreen)"}');
    assert.match(textOf(h.required('select', `${prefix}视频分辨率选项`)), /960 × 544/u); h.dispose();
  }
});

test('仅修改MP选项和尺寸标签不会改变批量请求指纹或云端请求', () => {
  const initial = mpFixture(); const api = runningHub.compileRunningHubVideoApi(initial.settings.runningHubVideo!);
  const draft = { ...drafts.emptyVideoDraft(initial.settings), prompt: '雨后空镜', parameters: { resolution: '0.5' } };
  const { runningHubParameterControls: _controls, ...legacyApi } = api;
  const current = { backend: 'api', api }; const legacy = { backend: 'api', api: legacyApi };
  assert.equal(batch.videoBatchRequestFingerprint(draft, [], current), batch.videoBatchRequestFingerprint(draft, [], legacy));
  const body = buildVideoApiBody(api, draft, []);
  assert.deepEqual(body, buildVideoApiBody(legacyApi, draft, []));
  assert.doesNotMatch(JSON.stringify(body), /optionLabels|ParameterControls|control/u);
});

test('默认竖屏改为16:9显示已保存的尺寸表，清除覆盖后恢复竖屏展示', () => {
  for (const mode of ['single', 'batch'] as const) {
    const initial = mpFixture(); const workflow = initial.settings.runningHubVideo!.workflows[0];
    workflow.mapping.parameters!.aspect = { nodeId: 'mp', inputName: 'aspect_ratio' };
    workflow.requestTemplate = runningHub.updateRunningHubVideoNodeValue(workflow.requestTemplate, { nodeId: 'mp', inputName: 'aspect_ratio' }, '9:16 (Portrait Widescreen)');
    const h = harness(mode, initial); const prefix = mode === 'single' ? '本次' : '批量';
    const jsonLabel = mode === 'single' ? '本次额外参数 JSON' : '批量公共参数 JSON';
    assert.doesNotMatch(textOf(h.required('select', `${prefix}视频分辨率选项`)), /960 × 544/u);
    h.change('textarea', jsonLabel, '{"aspect":"16:9 (Widescreen)"}');
    assert.match(textOf(h.required('select', `${prefix}视频分辨率选项`)), /960 × 544/u);
    h.change('textarea', jsonLabel, '{}');
    assert.doesNotMatch(textOf(h.required('select', `${prefix}视频分辨率选项`)), /960 × 544/u); h.dispose();
  }
});

test('冻结任务清除比例覆盖按originalValue展示，永不读取当前工作流标签', () => {
  const initial = mpFixture(); const workflow = initial.settings.runningHubVideo!.workflows[0];
  workflow.mapping.parameters!.aspect = { nodeId: 'mp', inputName: 'aspect_ratio' };
  workflow.requestTemplate = runningHub.updateRunningHubVideoNodeValue(workflow.requestTemplate, { nodeId: 'mp', inputName: 'aspect_ratio' }, '9:16 (Portrait Widescreen)');
  const api = runningHub.compileRunningHubVideoApi(initial.settings.runningHubVideo!, workflow.id, { aspect: '16:9 (Widescreen)' });
  const frozen = JSON.stringify(api);
  assert.equal(output.videoOutputParameterPresentation(api, { aspect: '16:9 (Widescreen)' }).controls.resolution.optionLabels?.['0.5'], '960 × 544');
  assert.equal(output.videoOutputParameterPresentation(api).controls.resolution.optionLabels, undefined);
  assert.equal(output.videoOutputParameterPresentation(api, { aspect: undefined }).controls.resolution.optionLabels, undefined);
  assert.equal(JSON.stringify(api), frozen);
});

test('旧快照只依据原字段识别MP单位，不读取当前工作流档位和尺寸标签', () => {
  const view = output.videoOutputParameterPresentation({ runningHubMappedFields: [{ nodeId: 'old', fieldName: 'megapixels', kind: 'parameter', parameter: 'resolution', originalValue: '0.98' }] });
  assert.deepEqual(view.controls.resolution, { kind: 'number', unit: 'MP' });
  assert.equal(view.defaultValues.resolution, '0.98');
});

test('旧冻结width/height MP只显示像素单项，继续编辑原键且不出现空的另一维', () => {
  for (const key of ['width', 'height'] as const) {
    const original = { runningHubMappedFields: [{ nodeId: 'old', fieldName: 'megapixels', kind: 'parameter' as const, parameter: key, originalValue: 0.5 }] };
    const saved = JSON.stringify(original); const changes: unknown[] = [];
    const tree = Output({ scope: 'single', source: 'runninghub', parameterText: JSON.stringify({ [key]: 0.5 }), availableKeys: [key],
      ...output.videoOutputParameterPresentation(original), onChange: (...args) => changes.push(args) });
    assert.match(textOf(tree), /像素（MP）/u);
    assert.doesNotMatch(textOf(tree), /宽度（像素）|高度（像素）|高级：指定宽高/u);
    const inputs = nodesOf(tree).filter((node) => node.type === 'input' && !node.props.disabled);
    assert.equal(inputs.length, 1); inputs[0].props.onChange({ target: { value: '0.6' } });
    assert.deepEqual(changes, [[key, '0.6']]); assert.equal(JSON.stringify(original), saved);
    assert.equal(output.videoOutputParameterSummary({ [key]: 0.5 }, original), '请求像素 0.5 MP');
  }
});

test('独立宽高在可展开高级区，MP主项不混用像素长度单位', () => {
  const tree = Output({ scope: 'batch', source: 'comfyui', parameterText: '{"width":800,"height":448}', availableKeys: ['width', 'height'], onChange: () => {} });
  const advanced = nodesOf(tree).find((node) => node.type === 'details' && node.props.className === 'vop-dimensions');
  assert.ok(advanced); assert.equal(advanced.props.open, undefined);
  assert.match(textOf(advanced), /高级：指定宽高/u);
  assert.equal(input(advanced, '批量视频宽度（像素）').props.value, '800');
  assert.equal(input(advanced, '批量视频高度（像素）').props.value, '448');
});

test('MP摘要读取当前或冻结API的单位尺寸，默认选项也展示尺寸', () => {
  const initial = mpFixture(); const api = runningHub.compileRunningHubVideoApi(initial.settings.runningHubVideo!);
  assert.equal(output.videoOutputParameterSummary({ resolution: '1.0' }, api), '请求像素 1.0 MP（1376 × 768）');
  assert.equal(output.videoOutputParameterSummary({ width: 800, height: 448 }), '请求宽度 800 像素 · 请求高度 448 像素');
  const tree = Output({ scope: 'single', source: 'runninghub', parameterText: '{}', availableKeys: ['resolution'],
    ...output.videoOutputParameterPresentation(api), onChange: () => assert.fail('render must not edit') });
  assert.match(textOf(tree), /像素（MP）/u);
  assert.match(textOf(tree), /使用默认值（0\.5 MP（960 × 544））/u);
  assert.doesNotMatch(textOf(tree), /宽度（像素）|高度（像素）/u);
});

test('批量段清单与确认摘要显示MP，提交原值不受展示改变', () => {
  const initial = mpFixture(); const h = harness('batch', initial);
  h.change('select', '批量视频分辨率选项', 'value:0.5');
  assert.match(h.text(), /请求像素 0\.5 MP（960 × 544）/u);
  assert.doesNotMatch(h.text(), /请求分辨率 0\.5|请求宽度 0\.5 像素/u);
  h.dispose();
});

console.log(`Video output parameters: ${groups} groups passed; no network or generation calls.`);
