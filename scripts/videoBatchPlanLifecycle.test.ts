import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import ts from 'typescript';
import { createInitialState } from '../src/storage';
import { emptyVideoDraft } from '../src/videoDirectorDraft';
import type { Project, Storyboard, VideoGenerationTask, VideoSequencePlan } from '../src/types';
import type { VideoDirectorBatchDraft } from '../src/videoDirectorDraft';

type Props = Record<string, any>;
type Element = React.ReactElement<Props>;
interface Slot { value?: any; deps?: readonly unknown[]; cleanup?: () => void }
const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
const nodesOf = (value: React.ReactNode): Element[] => Array.isArray(value) ? value.flatMap(nodesOf)
  : React.isValidElement<Props>(value) ? [value, ...nodesOf(value.props.children)] : [];
const textOf = (value: React.ReactNode): string => value == null || typeof value === 'boolean' ? ''
  : Array.isArray(value) ? value.map(textOf).join('') : React.isValidElement<Props>(value) ? textOf(value.props.children) : String(value);

function fixture(prefix = 'plan') {
  const state = createInitialState();
  const project = { ...state.project, id: 'plan-lifecycle-project', assets: [], generationTasks: [] } as Project;
  const settings = { ...state.settings, videoBackend: 'api' as const, videoSource: 'api' as const, activeVideoApiProfileId: null, videoApiProfiles: [],
    videoTaskApi: { ...state.settings.videoTaskApi, enabled: true, provider: 'generic' as const, model: 'local-test', apiKey: '', endpoint: 'https://local-test.invalid/generate', requestTemplate: '' } };
  const boards = [1, 2].map((index): Storyboard => ({
    id: `${prefix}-board-${index}`, sceneId: project.scenes[0].id, sourceStoryTitle: '两段剧情', workflow: 'drama', inputMode: 'text_reference',
    durationSec: 10, durationPreset: '15s', shotMode: 'auto', pace: 'standard', aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo',
    stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', globalReferenceAssetIds: [], shots: [], finalPrompt: `第${index}段保留原文`,
    sequencePlanId: prefix, segmentId: `${prefix}-segment-${index}`, segmentIndex: index, segmentCount: 2, createdAt: 1, updatedAt: index,
  }));
  const plan: VideoSequencePlan = { id: prefix, title: '两段剧情', sourceStoryTitle: '两段剧情', sourceStoryContent: '原始全文', durationMode: 'ai-estimated',
    totalDurationSec: 20, segmentDurationSec: 10, segmentationMode: 'natural', fitStatus: 'balanced', planningStage: 'segmented', createdAt: 1, updatedAt: 1,
    segments: boards.map((board, index) => ({ id: board.segmentId!, index: index + 1, title: `片段${index + 1}`, globalStartSec: index * 10,
      globalEndSec: (index + 1) * 10, durationSec: 10, content: `原文${index + 1}`, summary: '', sourceSceneIds: [board.sceneId], sourceBeatIds: [],
      narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', storyboardId: board.id, status: 'ready' })) };
  project.storyboards = boards; project.sequencePlans = [plan];
  return { project, settings, plan, boards };
}

/** The production batch component runs with in-memory hooks and a controller
 * that rejects execution. No browser storage or paid request is used. */
function harness(initial: Props) {
  let props = { ...initial }, cursor = 0, dirty = true;
  let pending: Array<() => void> = [];
  const slots: Slot[] = [];
  const drafts: VideoDirectorBatchDraft[] = [];
  let submissions = 0;
  const hooks = {
    useState(initialValue: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      const slot = slots[index];
      return [slot.value, (next: any) => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; } }];
    },
    useRef(value: unknown) { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    useMemo(run: () => unknown, deps?: readonly unknown[]) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: run(), deps }; return slots[index].value; },
    useEffect(run: () => (() => void) | void, deps?: readonly unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        const previous = slots[index]; slots[index] = { ...previous, deps };
        pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = run() || undefined; });
      }
    },
  };
  const productionRequire = createRequire(new URL('../src/components/VideoDirectorView.tsx', import.meta.url));
  const components = new Map<string, (props: Props) => null>();
  const componentExports = new Proxy({}, { get(_target, name) {
    if (name === '__esModule') return true;
    const key = String(name);
    if (!components.has(key)) components.set(key, Object.defineProperty(() => null, 'name', { value: key }));
    return components.get(key);
  } });
  const module = { exports: {} as Record<string, any> };
  const compiled = ts.transpileModule(readFileSync(new URL('../src/components/VideoDirectorView.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  new Function('require', 'module', 'exports', 'React', `${compiled}\nmodule.exports.Batch = VideoBatchPanel;`)((name: string) => {
    if (name === 'react') return { ...React, ...hooks };
    if (name.endsWith('.css')) return {};
    if (name.startsWith('./')) return componentExports;
    return productionRequire(name);
  }, module, module.exports, React);
  let tree: React.ReactNode;
  const controller = { startBatch: async () => { submissions += 1; throw new Error('Plan UI tests must never submit video'); } };
  const noChange = () => {};
  const onBatchDraftChange = (draft: VideoDirectorBatchDraft) => drafts.push(structuredClone(draft));
  const render = () => {
    let attempts = 0;
    do {
      assert.ok(attempts++ < 20, 'batch hooks settle'); cursor = 0; dirty = false;
      tree = module.exports.Batch({ controller, initialDraft: { ...emptyVideoDraft(props.settings), source: { promptFormat: 'ordinary' } },
        initialParameterText: '{}', onSubmittingChange: noChange, onBatchDraftChange, ...props });
      const effects = pending; pending = []; effects.forEach((effect) => effect());
    } while (dirty);
  };
  const find = (label: string, type?: string) => nodesOf(tree).find((node) => (!type || node.type === type)
    && (node.props['aria-label'] === label || textOf(node.props.children) === label));
  const required = (label: string, type?: string) => { const node = find(label, type); assert.ok(node, `missing ${label}`); return node; };
  render();
  return {
    required, nodes: () => nodesOf(tree), text: () => textOf(tree), draft: () => drafts.at(-1)!, submissions: () => submissions,
    rows: () => nodesOf(tree).filter((node) => String(node.props.className || '').split(' ').includes('vd-batch-row')),
    click: (label: string) => { const node = required(label, 'button'); assert.ok(!node.props.disabled, `${label} enabled`); node.props.onClick(); render(); },
    update: (patch: Props) => { props = { ...props, ...patch }; render(); }, render,
    dispose: () => slots.forEach((slot) => slot.cleanup?.()),
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Plan lifecycle checks must never request a remote API'); };
try {
  const initial = fixture();
  const h = harness({ ...initial, project: { ...initial.project, sequencePlans: [], storyboards: [] } });
  assert.equal(h.required('批量全片计划', 'select').props.value, '');
  assert.match(h.text(), /当前章节尚无已分段计划/u);
  h.update({ project: initial.project });
  assert.equal(h.required('批量全片计划', 'select').props.value, initial.plan.id);
  assert.equal(h.rows().length, 2);
  h.click('全选中文');
  h.click('第 1 段选择参考图');
  const picker = h.nodes().find((node) => typeof node.type === 'function' && node.type.name === 'VideoBatchImagePicker')!;
  picker.props.onApply([{ assetId: 'fake-image', role: 'scene' }], ['scene']); picker.props.onClose(); h.render();
  const audio = h.nodes().find((node) => typeof node.type === 'function' && node.type.name === 'VideoAudioReferenceEditor')!;
  audio.props.onChange({ audioSelectionMode: 'override', audioReferences: [] }); h.render();
  const retained = structuredClone(h.draft());
  h.update({ project: { ...initial.project, name: '无关项目名称修改' } });
  assert.equal(h.required('批量全片计划', 'select').props.value, initial.plan.id);
  assert.deepEqual(h.draft(), retained, 'unrelated updates preserve legal plan and edited batch draft');
  const replacement = fixture('replacement');
  h.update({ project: replacement.project });
  assert.equal(h.required('批量全片计划', 'select').props.value, replacement.plan.id);
  assert.equal(h.rows().length, 2);
  for (const field of ['languages', 'promptFormats', 'referenceOverrides', 'referenceRoleOverrides', 'audioOverrides', 'automaticTails', 'tailCharacterModes'] as const) {
    assert.deepEqual(h.draft()[field], {}, `${field} cleared when plan replaced`);
  }
  assert.deepEqual(h.draft().selectedKeys, []);
  const alternate = fixture('alternate');
  h.update({ project: { ...replacement.project, sequencePlans: [replacement.plan, alternate.plan], storyboards: [...replacement.boards, ...alternate.boards] } });
  assert.equal(h.required('批量全片计划', 'select').props.value, replacement.plan.id, 'adding a plan preserves existing legal selection');
  h.update({ project: alternate.project });
  assert.equal(h.required('批量全片计划', 'select').props.value, alternate.plan.id, 'deleting selected plan selects remaining plan');
  h.update({ project: { ...alternate.project, sequencePlans: [] } });
  assert.equal(h.required('批量全片计划', 'select').props.value, '');
  assert.equal(h.rows().length, 0);
  assert.equal(h.submissions(), 0);
  h.dispose();

  const persisted = harness({ ...initial, savedBatch: { ...retained, planId: 'removed-saved-plan' } });
  assert.equal(persisted.draft().planId, initial.plan.id);
  assert.deepEqual(persisted.draft().referenceOverrides, {}, 'invalid saved plan cannot apply its references to a replacement');
  assert.deepEqual(persisted.draft().audioOverrides, {});
  persisted.dispose();

  const stale = fixture('stale');
  stale.plan.sourceStale = true;
  const frozenDraft = { ...emptyVideoDraft(stale.settings), name: '失败任务快照', prompt: '旧原文冻结提示词', source: {
    sequencePlanId: stale.plan.id, segmentId: stale.boards[0].segmentId, storyboardId: stale.boards[0].id, language: 'zh' as const, promptFormat: 'ordinary' as const,
  } };
  stale.project.generationTasks = [{ id: 'failed-stale-task', kind: 'video', status: 'failed', storyboardId: stale.boards[0].id, targetId: 'test',
    requestBody: {}, createdAt: 1, updatedAt: 1, videoJob: { stage: 'failed', snapshot: { projectId: stale.project.id, draft: frozenDraft,
      connection: { backend: 'api', api: stale.settings.videoTaskApi }, images: [], clientId: 'local-test' } } } as VideoGenerationTask];
  const opened: Array<{ id: string; source: Props }> = [];
  const staleUi = harness({ ...stale, retryTaskIds: ['failed-stale-task'], onOpenPrompt: (id: string, source: Props) => opened.push({ id, source }) });
  assert.equal(staleUi.required('批量全片计划', 'select').props.value, stale.plan.id);
  assert.ok(staleUi.nodes().some((node) => node.type === 'option' && node.props.value === stale.plan.id && textOf(node).includes('原文已变化，需更新')));
  assert.equal(staleUi.rows().length, 2, 'stale plans keep their real segment list visible');
  assert.equal(staleUi.required('选择第 1 段', 'input').props.disabled, true, 'frozen failure snapshot cannot bypass stale source filtering');
  assert.equal(staleUi.required('检查并生成 0 段视频', 'button').props.disabled, true);
  assert.match(staleUi.text(), /已有分段和原稿仍保留，暂不能提交视频/u);
  staleUi.click('打开提示词导演台更新');
  assert.equal(opened[0].id, stale.boards[0].id);
  assert.equal(opened[0].source.sequencePlanId, stale.plan.id);
  staleUi.click('收起批量设置');
  assert.match(textOf(staleUi.required('当前批量设置摘要')), /2 段 · 原文已变化，需更新/u);
  assert.equal(staleUi.submissions(), 0);
  staleUi.dispose();
  console.log('Video batch plan lifecycle checks passed: live plan updates, saved drafts, stale display and execution blocking; no remote requests or generation.');
} finally {
  globalThis.fetch = originalFetch;
}
