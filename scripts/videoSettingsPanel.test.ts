import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import type { VideoGenerationSettingsProps } from '../src/components/VideoGenerationSettings';
import type { VideoWorkflowManagerProps } from '../src/components/VideoWorkflowManager';
import { importComfyVideoWorkflow, parseComfyVideoWorkflow } from '../src/comfyuiVideo';
import { createInitialState } from '../src/storage';
import type { AppSettings } from '../src/types';
import { formatUserFacingError } from '../src/userFacingError';
import { assertNoEmbeddedVideoCredentials, defaultRunningHubVideoApi, videoApiSubmitEndpoint } from '../src/videoGenerationApi';
import { defaultComfyVideoConfig, type ComfyVideoWorkflowPreset } from '../src/videoGenerationTypes';
import { isVideoWorkflowReady, uniqueVideoWorkflowName } from '../src/videoWorkflowLibrary';
import * as videoWorkflowLibrary from '../src/videoWorkflowLibrary';
import { createRunningHubTutorialVideoWorkflow, defaultRunningHubVideoConfig } from '../src/runningHubVideo';
import { defaultRhTvApi } from '../src/rhtvBridge';
import { genericVideoApiBaseUrl, genericVideoApiEndpoints } from '../src/genericVideoApi';
import type { VideoTaskApiConfig } from '../src/types';

// Compile the actual production component in memory. A small hook runner lets
// its real callbacks/effects rerender without a browser, Electron, CSS loader,
// provider requests, or disk/project writes. No settings behavior is re-created.
const source = readFileSync(new URL('../src/components/VideoGenerationSettings.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('VideoGenerationSettings.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = parsed.statements.filter((node) => (
  ts.isFunctionDeclaration(node) && node.name?.text === 'VideoGenerationSettings'
  || ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => ['idFor', 'parseSettingsJson'].includes(entry.name.getText(parsed)))
));
assert.equal(declarations.length, 3, 'exercise the production settings component, ID generator and JSON parser');
const compiled = ts.transpileModule(declarations.map((node) => node.getText(parsed).replace(/^export\s+/u, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;

interface NodeProps {
  children?: React.ReactNode;
  value?: unknown;
  type?: string;
  role?: string;
  disabled?: boolean;
  readOnly?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-selected'?: boolean;
  onClick?: () => void;
  onChange?: (event: any) => void;
  [key: string]: any;
}
type Node = React.ReactElement<NodeProps>;
const textOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return React.isValidElement<NodeProps>(value) ? textOf(value.props.children) : '';
};
const nodesOf = (value: React.ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  return React.isValidElement<NodeProps>(value) ? [value, ...nodesOf(value.props.children)] : [];
};
const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
interface HookSlot { value?: any; deps?: readonly unknown[]; cleanup?: () => void }

function fixture(backend: AppSettings['videoBackend'] = 'api'): AppSettings {
  const settings = createInitialState().settings;
  settings.videoBackend = backend;
  settings.videoTaskApi = { ...settings.videoTaskApi, enabled: true, provider: 'generic', model: 'video-fixture',
    endpoint: 'https://video.example.invalid/create', statusEndpointTemplate: 'https://video.example.invalid/jobs/{id}',
    apiKey: 'fake-video-secret', authHeader: 'Authorization', authScheme: 'Bearer' };
  settings.videoApiProfiles = [];
  settings.activeVideoApiProfileId = null;
  settings.comfyuiVideo = { ...defaultComfyVideoConfig, apiKey: 'fake-comfy-secret', workflows: [], activeWorkflowId: null };
  return settings;
}
const workflowJson = JSON.stringify({
  '11': { class_type: 'CLIPTextEncode', inputs: { text: 'original prompt' } },
  '22': { class_type: 'LoadImage', inputs: { image: 'original.png' } },
  '33': { class_type: 'SaveVideo', inputs: { positive: ['11', 0], image: ['22', 0], seed: 123 } },
});
const workflow = (id: string, name = id): ComfyVideoWorkflowPreset => ({ id, name, ...importComfyVideoWorkflow(workflowJson), createdAt: 1, updatedAt: 2 });

type DiscoveryResult = { models: string[]; patch: Partial<VideoTaskApiConfig>; source: 'openapi' | 'standard'; message: string; warnings: string[] };
type DiscoveryOptions = { signal?: AbortSignal; allowPrivateNetwork?: boolean };
const autoDiscoveryFixture = (config: VideoTaskApiConfig): DiscoveryResult => {
  const base = genericVideoApiBaseUrl(config).replace(/\/+$/u, '');
  return { models: ['video-fixture', 'video-second', 'image-model'], source: 'openapi', message: '已依据接口说明补齐高级配置。', warnings: [], patch: {
    endpoint: `${base}/v1/videos`, statusEndpointTemplate: `${base}/v1/videos/{id}`, authHeader: 'X-Api-Key', authScheme: '',
    taskIdPath: 'data.id', statusPath: 'data.status', resultUrlPath: 'data.output.url', requestTemplate: '',
    fileIdPath: '', fileEndpointTemplate: '', fileUrlPath: '', imageUploadEndpoint: '', imageUploadField: '', imageUploadUrlPath: '', cancelEndpointTemplate: '',
  } };
};
function harness(initial = fixture(), modelFetcher?: (config: VideoTaskApiConfig, options: DiscoveryOptions) => Promise<string[]>,
  discoveryFetcher?: (config: VideoTaskApiConfig, options: DiscoveryOptions) => Promise<DiscoveryResult>) {
  let current = structuredClone(initial);
  let displayed: AppSettings | undefined;
  let tree: React.ReactElement;
  let cursor = 0;
  let rerenderNeeded = true;
  let disposed = false;
  const slots: HookSlot[] = [];
  let pendingEffects: Array<() => void> = [];
  const patches: Partial<AppSettings>[] = [];
  const confirms: string[] = [];
  const confirmAnswers: boolean[] = [];
  const permissions: boolean[] = [];
  const modelRequests: Array<{ config: VideoTaskApiConfig; options: { signal?: AbortSignal; allowPrivateNetwork?: boolean } }> = [];
  const discoveryRequests: Array<{ config: VideoTaskApiConfig; options: DiscoveryOptions }> = [];
  const listeners = new Map<string, Set<(event: any) => void>>();
  const Icon = () => null;
  const Manager = () => null;
  const RunningHub = () => null;
  const dependencies = {
    React, Copy: Icon, Film: Icon, FolderOpen: Icon, RefreshCw: Icon, Save: Icon, Settings2: Icon, Trash2: Icon, Upload: Icon, X: Icon,
    VideoWorkflowManager: Manager, RunningHubVideoSettings: RunningHub, defaultRunningHubVideoConfig,
    RhTvBridgeSettings: () => null, defaultRhTvApi,
    formatUserFacingError, importComfyVideoWorkflow, assertNoEmbeddedVideoCredentials, defaultRunningHubVideoApi,
    videoApiSubmitEndpoint, defaultComfyVideoConfig, isVideoWorkflowReady, uniqueVideoWorkflowName,
    genericVideoApiBaseUrl, genericVideoApiEndpoints,
    fetchGenericVideoModels: (config: VideoTaskApiConfig, options: { signal?: AbortSignal; allowPrivateNetwork?: boolean }) => {
      modelRequests.push({ config: structuredClone(config), options });
      return modelFetcher ? modelFetcher(config, options) : Promise.resolve(['video-fixture', 'video-second', 'image-model']);
    },
    discoverGenericVideoApi: (config: VideoTaskApiConfig, options: DiscoveryOptions) => {
      discoveryRequests.push({ config: structuredClone(config), options });
      return discoveryFetcher ? discoveryFetcher(config, options) : Promise.resolve(autoDiscoveryFixture(config));
    },
    window: {
      confirm: (message: string) => { confirms.push(message); return confirmAnswers.shift() ?? false; },
      addEventListener: (name: string, callback: (event: any) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); },
      removeEventListener: (name: string, callback: (event: any) => void) => listeners.get(name)?.delete(callback),
    },
    useState: (initialValue: unknown) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      return [slots[index].value, (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; rerenderNeeded = true; }
      }];
    },
    useRef: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    useMemo: (calculate: () => unknown, deps?: readonly unknown[]) => {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: calculate(), deps };
      return slots[index].value;
    },
    useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        const previous = slots[index];
        slots[index] = { ...previous, deps };
        pendingEffects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect() || undefined; });
      }
    },
  };
  const Component = new Function(...Object.keys(dependencies), `${compiled}\nreturn VideoGenerationSettings;`)(...Object.values(dependencies)) as (props: VideoGenerationSettingsProps) => React.ReactElement;
  const render = () => {
    assert.equal(disposed, false, 'cannot rerender an unmounted component');
    let attempts = 0;
    do {
      assert.ok(attempts++ < 15, 'hook effects must settle rather than loop forever');
      cursor = 0; rerenderNeeded = false;
      tree = Component({ settings: displayed || current, getCurrentSettings: () => current,
        onChange: (patch) => { patches.push(structuredClone(patch)); current = { ...current, ...patch }; rerenderNeeded = true; },
        allowPrivateNetwork: true, onPrivateNetworkChange: (allowed) => permissions.push(allowed) });
      const effects = pendingEffects; pendingEffects = []; effects.forEach((effect) => effect());
    } while (rerenderNeeded);
    return tree!;
  };
  const all = () => nodesOf(tree!);
  const find = (type: string, label: string) => all().find((node) => node.type === type && (node.props['aria-label'] === label || textOf(node.props.children) === label));
  const required = (type: string, label: string): Node => {
    const node = find(type, label); assert.ok(node, `missing ${type}: ${label}`); return node;
  };
  const click = (label: string) => { const node = required('button', label); assert.ok(!node.props.disabled, `${label} is enabled`); node.props.onClick!(); render(); };
  const change = (type: string, label: string, value: string) => { const node = required(type, label); assert.ok(!node.props.disabled, `${label} is enabled`); node.props.onChange!({ target: { value } }); render(); };
  const importFile = (text: () => Promise<string>, name = 'imported.json') => {
    const node = all().find((candidate) => candidate.type === 'input' && candidate.props.type === 'file'); assert.ok(node, 'file import input exists');
    const target = { value: name, files: [{ name, text }] };
    node.props.onChange!({ target }); assert.equal(target.value, '', 'same file can be imported again'); render();
  };
  const dispose = () => { slots.forEach((slot) => slot.cleanup?.()); disposed = true; };
  render();
  return { render, all, find, required, click, change, importFile, dispose, Manager, RunningHub, patches, confirms, confirmAnswers, permissions, modelRequests, discoveryRequests,
    state: () => current,
    text: () => textOf(tree!),
    staleDisplay: () => { displayed = current; },
    refreshDisplay: () => { displayed = undefined; render(); },
    external: (update: (settings: AppSettings) => AppSettings, reRender = false) => { current = update(current); if (reRender) render(); },
    settle: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); if (!disposed) render(); },
  };
}

// Exercise the manager's real callbacks too: parent settings can advance before
// React delivers another config prop, notably when two file reads finish close
// together. DOM/focus effects are irrelevant to this state-isolation regression.
const managerSource = readFileSync(new URL('../src/components/VideoWorkflowManager.tsx', import.meta.url), 'utf8');
const managerParsed = ts.createSourceFile('VideoWorkflowManager.tsx', managerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const managerCompiled = ts.transpileModule(managerParsed.statements.filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(managerParsed).replace(/^export\s+/u, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
}).outputText;
function managerHarness(props: VideoWorkflowManagerProps) {
  const slots: HookSlot[] = [];
  let cursor = 0;
  let tree: React.ReactElement;
  const dependencies = {
    React, importComfyVideoWorkflow, parseComfyVideoWorkflow, ...videoWorkflowLibrary,
    useEffect: () => {},
    useState: (initialValue: any) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      return [slots[index].value, (next: any) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useRef: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    useMemo: (calculate: () => unknown, deps?: readonly unknown[]) => {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: calculate(), deps };
      return slots[index].value;
    },
  };
  const Component = new Function(...Object.keys(dependencies), `${managerCompiled}\nreturn VideoWorkflowManager;`)(...Object.values(dependencies)) as (props: VideoWorkflowManagerProps) => React.ReactElement;
  const render = () => { cursor = 0; tree = Component(props); };
  const required = (type: string, label: string): Node => {
    const node = nodesOf(tree).find((candidate) => candidate.type === type && (candidate.props['aria-label'] === label || textOf(candidate.props.children) === label));
    assert.ok(node, `missing manager ${type}: ${label}`); return node;
  };
  render();
  return {
    click: (label: string) => { const node = required('button', label); assert.ok(!node.props.disabled, `${label} is enabled`); node.props.onClick!(); render(); },
    change: (label: string, value: string) => { required('input', label).props.onChange!({ target: { value } }); render(); },
    importFile: (text: () => Promise<string>, name: string) => {
      required('input', '导入视频工作流 API JSON 文件').props.onChange!({ target: { value: name, files: [{ name, size: workflowJson.length, text }] } }); render();
    },
    settle: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); render(); },
    text: () => textOf(tree),
  };
}

let count = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); console.log(`ok ${++count} - ${name}`); };

await test('common settings stay in bounded cards; advanced fields are mounted only on demand', () => {
  const h = harness();
  for (const label of ['已保存的视频接口', '视频接口协议', '默认视频生成方式']) h.required('select', label);
  for (const label of ['视频连接名称', '视频模型 ID', '视频 API 地址', 'API 密钥']) h.required('input', label);
  h.required('button', '获取模型'); h.required('button', '自动获取并补齐'); h.required('select', '选择视频模型');
  assert.doesNotMatch(h.text(), /老李/u, 'the generic settings UI does not advertise a specific service');
  assert.equal(h.find('input', '提交端点'), undefined); assert.equal(h.find('input', '任务查询端点'), undefined);
  assert.equal(h.required('input', 'API 密钥').props.type, 'password');
  assert.deepEqual(nodesOf(h.required('select', '视频接口协议').props.children).filter((node) => node.type === 'option').map((node) => node.props.value), ['generic', 'minimax', 'runninghub', 'rhtv_web']);
  assert.equal(h.all().filter((node) => String(node.props.className || '').split(' ').includes('vgs-card')).length, 3);
  assert.equal(h.all().filter((node) => node.type === 'textarea' || node.type === 'details' || node.props.role === 'dialog').length, 0);
  assert.equal(h.find('input', '认证头名称'), undefined);
  h.click('高级协议与请求模板'); h.required('section', '视频 API 高级设置'); h.required('textarea', '视频请求模板 JSON');
  h.required('input', '提交端点'); h.required('input', '任务查询端点');
  assert.equal(h.find('input', '认证头名称'), undefined);
  h.click('认证与结果映射');
  for (const label of ['认证头名称', '认证前缀', '任务 ID 字段路径', '任务状态字段路径', '视频下载 URL 字段路径', '进度字段路径', '服务端错误字段路径', '文件 ID 字段路径', '根据文件 ID 取下载 URL', '文件下载 URL 字段路径']) h.required('input', label);
  assert.equal(h.find('textarea', '视频请求模板 JSON'), undefined);
  h.click('图片上传与取消');
  for (const label of ['参考图片上传端点（可选）', '上传表单字段', '上传响应图片 URL 字段', '取消本任务端点（可选）']) h.required('input', label);
  h.required('select', '取消请求方法'); h.click('关闭');
  assert.equal(h.all().some((node) => node.props.role === 'dialog'), false);
  assert.deepEqual(h.patches, [], 'opening/editing tabs must not change settings or start tasks'); h.dispose();
});

await test('ComfyUI has separate connection and workflow cards without inline mapping/JSON editors', () => {
  const settings = fixture('comfyui'); settings.comfyuiVideo!.workflows = [workflow('a', '工作流甲'), workflow('b', '工作流乙')]; settings.comfyuiVideo!.activeWorkflowId = 'b';
  const h = harness(settings);
  h.required('input', 'ComfyUI 视频地址'); h.required('select', '视频 ComfyUI 接口路径模式');
  assert.equal(h.required('input', 'ComfyUI 视频认证密钥').props.type, 'password');
  assert.equal(h.required('select', '当前视频 Workflow').props.value, 'b');
  assert.match(h.text(), /2 份已保存/u); assert.match(h.text(), /当前实际生效：工作流乙/u);
  assert.equal(h.all().some((node) => node.type === 'textarea' || node.type === 'details' || node.type === h.Manager), false);
  h.click('管理 Workflow'); assert.equal(h.all().filter((node) => node.type === h.Manager).length, 1);
  const manager = h.all().find((node) => node.type === h.Manager)!;
  assert.equal(manager.props.initialWorkflowId, 'b'); assert.deepEqual(manager.props.config.workflows, settings.comfyuiVideo!.workflows);
  manager.props.onClose(); h.render(); assert.equal(h.all().some((node) => node.type === h.Manager), false); h.dispose();
});

await test('manual generic address and advanced automatic endpoints preserve secrets and custom request templates', () => {
  const settings = fixture(); const template = '{"custom":"{{prompt}}"}'; settings.videoTaskApi.requestTemplate = template;
  const h = harness(settings); const oldEndpoints = { endpoint: settings.videoTaskApi.endpoint, statusEndpointTemplate: settings.videoTaskApi.statusEndpointTemplate };
  h.change('input', '视频 API 地址', 'https://new-service.invalid/v1');
  assert.equal(h.state().videoTaskApi.baseUrl, 'https://new-service.invalid/v1');
  assert.equal(h.state().videoTaskApi.endpoint, oldEndpoints.endpoint, 'editing the base address preserves explicit legacy overrides');
  assert.match(h.text(), /已保留自定义任务端点/u);
  h.click('高级协议与请求模板'); h.click('使用地址自动生成端点');
  assert.equal(h.state().videoTaskApi.endpoint, ''); assert.equal(h.state().videoTaskApi.statusEndpointTemplate, '');
  assert.equal(h.state().videoTaskApi.apiKey, 'fake-video-secret'); assert.equal(h.state().videoTaskApi.requestTemplate, template);
  assert.match(h.text(), /new-service\.invalid\/v1\/videos/u); h.click('关闭');
  assert.equal(h.find('button', '填入老李视频地址'), undefined); h.dispose();
});

await test('automatic completion uses each current website and applies one protocol patch while preserving key, model and profiles', async () => {
  for (const baseUrl of ['https://site-a.example.invalid', 'https://site-b.example.invalid/prefix']) {
    const settings = fixture(); settings.videoTaskApi = { ...settings.videoTaskApi, baseUrl,
      requestTemplate: '{"old":"{{prompt}}"}', fileIdPath: 'file_id', fileEndpointTemplate: 'https://api.minimaxi.com/v1/files/retrieve?file_id={id}', fileUrlPath: 'file.download_url',
      imageUploadEndpoint: 'https://old.example.invalid/upload', cancelEndpointTemplate: 'https://old.example.invalid/cancel/{id}' };
    settings.videoApiProfiles = [{ ...settings.videoTaskApi, id: 'active', name: '当前服务', createdAt: 1, updatedAt: 2 },
      { ...settings.videoTaskApi, id: 'other', name: '其它服务', createdAt: 3, updatedAt: 4 }];
    settings.activeVideoApiProfileId = 'active';
    const h = harness(settings); const other = structuredClone(settings.videoApiProfiles[1]);
    h.click('自动获取并补齐'); assert.equal(h.required('button', '正在补齐…').props.disabled, true);
    assert.equal(h.required('button', '获取模型').props.disabled, true); await h.settle();
    assert.equal(h.discoveryRequests.length, 1); assert.equal(h.discoveryRequests[0].config.baseUrl, baseUrl);
    assert.equal(h.discoveryRequests[0].options.allowPrivateNetwork, true);
    assert.equal(h.patches.length, 1, 'protocol fields and the active profile are saved atomically');
    const applied = h.state().videoTaskApi;
    assert.equal(applied.baseUrl, baseUrl); assert.equal(applied.apiKey, 'fake-video-secret'); assert.equal(applied.model, 'video-fixture');
    assert.equal(applied.endpoint, `${baseUrl}/v1/videos`); assert.equal(applied.statusEndpointTemplate, `${baseUrl}/v1/videos/{id}`);
    assert.equal(applied.authHeader, 'X-Api-Key'); assert.equal(applied.requestTemplate, '');
    for (const field of ['fileIdPath', 'fileEndpointTemplate', 'fileUrlPath', 'imageUploadEndpoint', 'cancelEndpointTemplate'] as const) assert.equal(applied[field], '', `${field}: previous service mapping cleared by explicit automatic completion`);
    const choices = nodesOf(h.required('select', '选择视频模型').props.children).filter((node) => node.type === 'option').map((node) => node.props.value);
    assert.deepEqual(choices, ['', 'video-fixture', 'video-second', 'image-model'], 'the list survives the endpoint and authentication patch without model filtering');
    assert.equal(h.required('select', '选择视频模型').props.disabled, false);
    assert.equal(h.state().videoApiProfiles![0].endpoint, applied.endpoint); assert.equal(h.state().videoApiProfiles![0].apiKey, applied.apiKey);
    assert.equal(h.state().videoApiProfiles![0].model, applied.model); assert.deepEqual(h.state().videoApiProfiles![1], other);
    h.change('select', '选择视频模型', 'image-model'); assert.equal(h.state().videoTaskApi.model, 'image-model'); h.dispose();
  }
});

await test('automatic completion failures preserve every existing field and present errors without a stale model list', async () => {
  const h = harness(fixture(), undefined, async () => { throw new Error('请求失败，请检查 API 地址与密钥。'); });
  const before = structuredClone(h.state()); h.click('自动获取并补齐'); await h.settle();
  assert.deepEqual(h.state(), before); assert.deepEqual(h.patches, []); assert.ok(h.all().some((node) => node.props.role === 'alert'));
  assert.equal(h.required('button', '自动获取并补齐').props.disabled, false); assert.equal(h.required('select', '选择视频模型').props.disabled, true); h.dispose();
});

await test('automatic completion ignores switched or edited connections and preserves models edited in flight', async () => {
  for (const changed of ['address', 'key', 'profile', 'panel', 'advanced', 'external', 'unmount']) {
    let release!: (result: DiscoveryResult) => void;
    const h = harness(fixture(), undefined, () => new Promise<DiscoveryResult>((resolve) => { release = resolve; })); h.click('自动获取并补齐');
    const response = autoDiscoveryFixture(h.discoveryRequests[0].config);
    if (changed === 'address') h.change('input', '视频 API 地址', 'https://different.example.invalid');
    if (changed === 'key') h.change('input', 'API 密钥', 'different-synthetic-secret');
    if (changed === 'profile') h.external((state) => ({ ...state, activeVideoApiProfileId: 'new-profile' }), true);
    if (changed === 'panel') h.click('ComfyUI 视频');
    if (changed === 'advanced') { h.click('高级协议与请求模板'); h.change('input', '任务查询端点', 'https://latest.example.invalid/tasks/{id}'); }
    if (changed === 'external') { h.staleDisplay(); h.external((state) => ({ ...state, videoTaskApi: { ...state.videoTaskApi, baseUrl: 'https://changed-externally.example.invalid' } })); }
    if (changed === 'unmount') h.dispose();
    const before = structuredClone(h.state()); const patchCount = h.patches.length; release(response); await h.settle();
    assert.deepEqual(h.state(), before, `${changed}: older discovery cannot overwrite newer settings`); assert.equal(h.patches.length, patchCount);
    assert.doesNotMatch(h.text(), /已依据接口说明/u); if (changed !== 'unmount') h.dispose();
  }
  let release!: (result: DiscoveryResult) => void;
  const h = harness(fixture(), undefined, () => new Promise<DiscoveryResult>((resolve) => { release = resolve; })); h.click('自动获取并补齐');
  h.change('input', '视频模型 ID', 'chosen-while-loading');
  const response = autoDiscoveryFixture(h.discoveryRequests[0].config); response.patch.model = 'stale-model'; response.patch.apiKey = 'stale-key'; response.patch.baseUrl = 'https://stale.example.invalid';
  release(response); await h.settle(); assert.equal(h.state().videoTaskApi.model, 'chosen-while-loading'); assert.equal(h.state().videoTaskApi.apiKey, 'fake-video-secret');
  assert.equal(h.state().videoTaskApi.baseUrl, fixture().videoTaskApi.baseUrl); assert.match(h.text(), /已依据接口说明/u); h.dispose();
});

await test('model discovery keeps the complete server list and never replaces the chosen or manually entered model', async () => {
  const h = harness(); const before = structuredClone(h.state().videoTaskApi); h.click('获取模型');
  assert.equal(h.required('button', '获取中').props.disabled, true); await h.settle();
  assert.deepEqual(h.state().videoTaskApi, before, 'discovery is read-only and does not choose a model');
  const choices = nodesOf(h.required('select', '选择视频模型').props.children).filter((node) => node.type === 'option').map((node) => node.props.value);
  assert.deepEqual(choices, ['', 'video-fixture', 'video-second', 'image-model'], 'image or alias IDs are not filtered');
  assert.equal(h.modelRequests[0].config.apiKey, 'fake-video-secret'); assert.equal(h.modelRequests[0].options.allowPrivateNetwork, true);
  h.change('select', '选择视频模型', 'image-model'); assert.equal(h.state().videoTaskApi.model, 'image-model');
  h.change('input', '视频模型 ID', 'manual-model'); assert.equal(h.state().videoTaskApi.model, 'manual-model');
  assert.equal(h.required('select', '选择视频模型').props.value, ''); assert.doesNotMatch(h.text(), /fake-video-secret/u); h.dispose();
});

await test('late model responses cannot populate a different address, secret, profile or page', async () => {
  for (const changed of ['address', 'key', 'profile', 'panel', 'external'] as const) {
    let release!: (models: string[]) => void;
    const h = harness(fixture(), () => new Promise<string[]>((resolve) => { release = resolve; })); h.click('获取模型');
    if (changed === 'address') h.change('input', '视频 API 地址', 'https://different.invalid');
    if (changed === 'key') h.change('input', 'API 密钥', 'different-synthetic-secret');
    if (changed === 'profile') h.external((state) => ({ ...state, activeVideoApiProfileId: 'new-profile' }), true);
    if (changed === 'panel') h.click('ComfyUI 视频');
    if (changed === 'external') { h.staleDisplay(); h.external((state) => ({ ...state, videoTaskApi: { ...state.videoTaskApi, baseUrl: 'https://changed-externally.invalid' } })); }
    const before = structuredClone(h.state()); release(['old-request-model']); await h.settle();
    assert.deepEqual(h.state(), before, `${changed}: old model responses never change saved settings`);
    assert.equal(h.all().some((node) => node.type === 'option' && node.props.value === 'old-request-model'), false, `${changed}: old results stay out of the picker`);
    assert.doesNotMatch(h.text(), /已获取 1 个模型/u); h.dispose();
  }
});

await test('model selection checks authoritative connection and unmounted fetches cannot update settings', async () => {
  const h = harness(); h.click('获取模型'); await h.settle(); h.staleDisplay();
  h.external((state) => ({ ...state, videoTaskApi: { ...state.videoTaskApi, apiKey: 'latest-synthetic-secret' } }));
  h.change('select', '选择视频模型', 'video-second'); assert.equal(h.state().videoTaskApi.model, 'video-fixture');
  assert.match(h.text(), /API 配置已改变/u); h.dispose();
  let release!: (models: string[]) => void;
  const disposed = harness(fixture(), () => new Promise<string[]>((resolve) => { release = resolve; }));
  disposed.click('获取模型'); disposed.dispose(); assert.equal(disposed.modelRequests[0].options.signal?.aborted, true);
  release(['after-unmount']); await disposed.settle(); assert.equal(disposed.patches.length, 0);
});

await test('rhTV creates a dedicated profile and retains saved or unsaved previous connections', () => {
  for (const saved of [false, true]) {
    const settings = fixture(); const original = structuredClone(settings.videoTaskApi);
    if (saved) {
      settings.videoApiProfiles = [{ ...original, id: 'prior', name: 'Original', createdAt: 1, updatedAt: 1 }];
      settings.activeVideoApiProfileId = 'prior';
    }
    const h = harness(settings);
    h.change('select', '视频接口协议', 'rhtv_web');
    assert.equal(h.state().videoTaskApi.provider, 'rhtv_web');
    assert.equal(h.state().videoApiProfiles!.length, 2);
    assert.equal(h.state().videoTaskApi.apiKey, '', 'never copy third-party secrets into bridge');
    assert.equal(h.find('input', 'API 密钥'), undefined);
    assert.equal(h.find('input', '提交端点'), undefined);
    assert.deepEqual(h.state().comfyuiVideo, settings.comfyuiVideo);
    h.change('select', '已保存的视频接口', h.state().videoApiProfiles![0].id);
    assert.deepEqual(h.state().videoTaskApi, original); h.dispose();
  }
  const addressOnly = fixture(); addressOnly.videoTaskApi = { ...addressOnly.videoTaskApi, baseUrl: 'https://address-only.invalid', endpoint: '', apiKey: '' };
  const h = harness(addressOnly); const original = structuredClone(addressOnly.videoTaskApi);
  h.change('select', '视频接口协议', 'rhtv_web');
  assert.equal(h.state().videoApiProfiles!.length, 2, 'an unsaved base-address-only connection is kept before adding the bridge');
  h.change('select', '已保存的视频接口', h.state().videoApiProfiles![0].id);
  assert.deepEqual(h.state().videoTaskApi, original); h.dispose();
});

await test('RunningHub is a third independent tab without replacing legacy video API or local ComfyUI', () => {
  const settings = fixture('comfyui'); const cloud = createRunningHubTutorialVideoWorkflow();
  settings.comfyuiVideo!.workflows = [workflow('local', '本地工作流')];
  settings.runningHubVideo = { ...structuredClone(defaultRunningHubVideoConfig), apiKey: 'isolated-cloud-key', workflows: [cloud], activeWorkflowId: cloud.id };
  const baseline = structuredClone(settings); const h = harness(settings);
  h.click('RunningHub 云端');
  const panel = h.all().find((node) => node.type === h.RunningHub); assert.ok(panel, 'independent cloud settings component mounts');
  assert.deepEqual(panel.props.config, settings.runningHubVideo);
  assert.equal(h.find('input', 'ComfyUI 视频地址'), undefined); assert.equal(h.find('input', '提交端点'), undefined);
  assert.equal(h.all().some((node) => node.type === h.Manager), false);
  h.click('视频 API'); h.required('select', '视频接口协议'); assert.equal(h.all().some((node) => node.type === h.RunningHub), false);
  h.click('ComfyUI 视频'); h.required('input', 'ComfyUI 视频地址'); assert.deepEqual(h.state(), baseline);
  assert.deepEqual(h.patches, [], 'viewing connection tabs never alters configuration or initiates cloud tasks'); h.dispose();
});

await test('default generation source distinguishes cloud from underlying API transport without modifying any connection', () => {
  const settings = fixture('comfyui'); settings.runningHubVideo = { ...structuredClone(defaultRunningHubVideoConfig), apiKey: 'separate-cloud-key' };
  const h = harness(settings); const before = structuredClone(h.state());
  const options = nodesOf(h.required('select', '默认视频生成方式').props.children).filter((node) => node.type === 'option').map((node) => node.props.value);
  assert.deepEqual(options, ['api', 'comfyui', 'runninghub']);
  h.change('select', '默认视频生成方式', 'runninghub'); assert.equal(h.state().videoSource, 'runninghub'); assert.equal(h.state().videoBackend, 'api');
  assert.deepEqual(h.state().videoTaskApi, before.videoTaskApi); assert.deepEqual(h.state().comfyuiVideo, before.comfyuiVideo); assert.deepEqual(h.state().runningHubVideo, before.runningHubVideo);
  assert.deepEqual(Object.keys(h.patches.at(-1)!).sort(), ['videoBackend', 'videoSource']);
  h.change('select', '默认视频生成方式', 'comfyui'); assert.equal(h.state().videoSource, 'comfyui'); assert.equal(h.state().videoBackend, 'comfyui');
  h.change('select', '默认视频生成方式', 'api'); assert.equal(h.state().videoSource, 'api'); assert.equal(h.state().videoBackend, 'api'); h.dispose();
  const reopened = harness({ ...settings, videoSource: 'runninghub', videoBackend: 'api' });
  assert.equal(reopened.required('select', '默认视频生成方式').props.value, 'runninghub'); assert.ok(reopened.all().some((node) => node.type === reopened.RunningHub)); reopened.dispose();
});

await test('cloud child callbacks use authoritative config and preserve concurrently changed unrelated connections', () => {
  const settings = fixture(); settings.videoSource = 'runninghub';
  settings.runningHubVideo = { ...structuredClone(defaultRunningHubVideoConfig), workflows: [createRunningHubTutorialVideoWorkflow()] };
  const h = harness(settings); const child = h.all().find((node) => node.type === h.RunningHub); assert.ok(child);
  h.staleDisplay(); h.external((current) => ({ ...current,
    videoTaskApi: { ...current.videoTaskApi, model: 'new-legacy-model', apiKey: 'new-legacy-key' },
    comfyuiVideo: { ...current.comfyuiVideo!, baseUrl: 'http://new-local.invalid' },
    runningHubVideo: { ...current.runningHubVideo!, apiKey: 'new-cloud-key', workflows: [...current.runningHubVideo!.workflows, createRunningHubTutorialVideoWorkflow()] },
  }));
  const latestCloud = child.props.getCurrentConfig(); assert.equal(latestCloud.apiKey, 'new-cloud-key'); assert.equal(latestCloud.workflows.length, 2);
  child.props.onChange!({ ...latestCloud, baseUrl: 'https://www.runninghub.cn' }); h.render();
  assert.equal(h.state().runningHubVideo!.baseUrl, 'https://www.runninghub.cn'); assert.equal(h.state().runningHubVideo!.apiKey, 'new-cloud-key');
  assert.equal(h.state().runningHubVideo!.workflows.length, 2); assert.equal(h.state().videoTaskApi.apiKey, 'new-legacy-key');
  assert.equal(h.state().videoTaskApi.model, 'new-legacy-model'); assert.equal(h.state().comfyuiVideo!.baseUrl, 'http://new-local.invalid');
  assert.deepEqual(Object.keys(h.patches.at(-1)!), ['runningHubVideo']); h.dispose();
});

await test('manager callbacks read authoritative settings before saving, activating or finishing an import', async () => {
  const settings = fixture('comfyui');
  settings.comfyuiVideo!.workflows = [workflow('a', '工作流甲'), workflow('b', '工作流乙')]; settings.comfyuiVideo!.activeWorkflowId = 'a';
  const h = harness(settings); h.click('管理 Workflow');
  const manager = h.all().find((node) => node.type === h.Manager)!;
  const props = { ...manager.props, initialWorkflowId: 'b' } as unknown as VideoWorkflowManagerProps;
  assert.equal(typeof props.getCurrentConfig, 'function');
  const editor = managerHarness(props);
  h.external((state) => ({ ...state, comfyuiVideo: { ...state.comfyuiVideo!, baseUrl: 'http://latest-connection.invalid', apiKey: 'latest-fake-secret',
    workflows: [...state.comfyuiVideo!.workflows, workflow('parallel', '并行新增')] } }));
  assert.equal(props.config.baseUrl, settings.comfyuiVideo!.baseUrl, 'rendered manager config deliberately remains stale');
  assert.equal(props.getCurrentConfig!().baseUrl, 'http://latest-connection.invalid');
  assert.deepEqual(props.getCurrentConfig!().workflows.map((item) => item.id), ['a', 'b', 'parallel']);
  editor.change('视频工作流名称', '工作流乙已修改'); editor.click('保存工作流');
  assert.equal(h.state().comfyuiVideo!.baseUrl, 'http://latest-connection.invalid');
  assert.equal(h.state().comfyuiVideo!.apiKey, 'latest-fake-secret');
  assert.deepEqual(h.state().comfyuiVideo!.workflows.map((item) => item.id), ['a', 'b', 'parallel']);
  assert.equal(h.state().comfyuiVideo!.workflows[1].name, '工作流乙已修改');
  assert.equal(h.state().comfyuiVideo!.activeWorkflowId, 'a', 'save does not silently activate the draft');
  editor.click('设为当前');
  assert.equal(h.state().comfyuiVideo!.activeWorkflowId, 'b');
  assert.equal(h.state().comfyuiVideo!.workflows.length, 3);
  let release!: (value: string) => void;
  editor.importFile(() => new Promise<string>((resolve) => { release = resolve; }), '工作流乙已修改.json');
  h.external((state) => ({ ...state, comfyuiVideo: { ...state.comfyuiVideo!, promptPath: '/latest/prompt',
    workflows: [...state.comfyuiVideo!.workflows, workflow('during-read', '读取期间新增')] } }));
  release(workflowJson); await editor.settle();
  assert.deepEqual(h.state().comfyuiVideo!.workflows.slice(0, 4).map((item) => item.id), ['a', 'b', 'parallel', 'during-read']);
  assert.equal(h.state().comfyuiVideo!.workflows[4].name, '工作流乙已修改 (2)');
  assert.equal(h.state().comfyuiVideo!.baseUrl, 'http://latest-connection.invalid');
  assert.equal(h.state().comfyuiVideo!.promptPath, '/latest/prompt');
  assert.equal(h.state().comfyuiVideo!.activeWorkflowId, 'b', 'manager import does not silently activate its new workflow');
  assert.doesNotMatch(editor.text(), /latest-fake-secret/u); h.dispose();
});

await test('profile switch, patch, rename/save and copy preserve credentials and unrecognized config fields', () => {
  const settings = fixture();
  const future = { region: 'custom-zone', values: [1, 'two', true] };
  settings.videoApiProfiles = [
    { ...settings.videoTaskApi, id: 'a', name: '接口甲', createdAt: 1, updatedAt: 2 },
    { ...settings.videoTaskApi, id: 'b', name: '接口乙', createdAt: 3, updatedAt: 4, provider: 'runninghub', runningHubAppId: '123456', extensionFromFuture: future } as any,
  ];
  settings.activeVideoApiProfileId = 'a';
  const h = harness(settings); h.change('select', '已保存的视频接口', 'b');
  assert.equal(h.state().videoTaskApi.apiKey, 'fake-video-secret'); assert.deepEqual((h.state().videoTaskApi as any).extensionFromFuture, future);
  assert.equal('id' in h.state().videoTaskApi || 'name' in h.state().videoTaskApi, false);
  h.change('input', '显示名称（可选）', '重命名模型');
  assert.equal(h.state().videoApiProfiles![1].model, '重命名模型'); assert.deepEqual((h.state().videoApiProfiles![1] as any).extensionFromFuture, future);
  h.change('input', '视频连接名称', '保存后的接口乙'); h.click('保存连接');
  assert.equal(h.state().videoApiProfiles![1].name, '保存后的接口乙'); assert.equal(h.state().videoApiProfiles![1].createdAt, 3);
  const beforeCopy = structuredClone(h.state().videoApiProfiles!); h.click('另存为新接口');
  assert.equal(h.state().videoApiProfiles!.length, 3); assert.deepEqual(h.state().videoApiProfiles!.slice(0, 2), beforeCopy);
  const copy = h.state().videoApiProfiles![2] as any; assert.notEqual(copy.id, 'b'); assert.equal(copy.apiKey, 'fake-video-secret'); assert.deepEqual(copy.extensionFromFuture, future);
  assert.notEqual(copy.extensionFromFuture, (h.state().videoTaskApi as any).extensionFromFuture, 'saved nested future config must be cloned');
  assert.equal(settings.videoApiProfiles[1].model, 'video-fixture', 'source settings were never mutated'); h.dispose();
});

await test('field callbacks use latest settings when the rendered profile/connection is stale', () => {
  const h = harness(); h.staleDisplay();
  h.external((state) => ({ ...state, videoTaskApi: { ...state.videoTaskApi, endpoint: 'https://latest.invalid/new', apiKey: 'new-fake-secret', futureFlag: true } as any,
    videoApiProfiles: [{ ...state.videoTaskApi, id: 'external-profile', name: '外部新增', createdAt: 1, updatedAt: 1 }] }));
  h.change('input', '视频模型 ID', 'latest-model');
  assert.equal(h.state().videoTaskApi.endpoint, 'https://latest.invalid/new'); assert.equal(h.state().videoTaskApi.apiKey, 'new-fake-secret');
  assert.equal((h.state().videoTaskApi as any).futureFlag, true); assert.equal(h.state().videoApiProfiles![0].id, 'external-profile'); h.dispose();
});

await test('deleting a saved connection requires confirmation and retains live parameters and other entries', () => {
  const settings = fixture(); settings.videoApiProfiles = ['a', 'b'].map((id) => ({ ...settings.videoTaskApi, id, name: id, createdAt: 1, updatedAt: 2 })); settings.activeVideoApiProfileId = 'a';
  const h = harness(settings); h.click('删除'); assert.equal(h.state().videoApiProfiles!.length, 2);
  const parameters = structuredClone(h.state().videoTaskApi); h.confirmAnswers.push(true); h.click('删除');
  assert.deepEqual(h.state().videoApiProfiles!.map((profile) => profile.id), ['b']); assert.equal(h.state().activeVideoApiProfileId, null);
  assert.deepEqual(h.state().videoTaskApi, parameters); assert.equal(h.confirms.length, 2); h.dispose();
  const raced = harness(settings); raced.staleDisplay(); raced.external((state) => ({ ...state, activeVideoApiProfileId: 'b' }));
  raced.confirmAnswers.push(true); raced.click('删除'); assert.equal(raced.state().activeVideoApiProfileId, 'b', 'a newer selected profile must not be cleared'); raced.dispose();
});

await test('Generic, MiniMax and RunningHub retain their real protocol controls and secret field', () => {
  const h = harness(); h.change('select', '视频接口协议', 'minimax'); h.click('填入 MiniMax 国内官方端点');
  assert.equal(h.state().videoTaskApi.endpoint, 'https://api.minimaxi.com/v1/video_generation');
  assert.equal(h.state().videoTaskApi.fileUrlPath, 'file.download_url'); assert.equal(h.state().videoTaskApi.apiKey, 'fake-video-secret');
  h.change('select', '视频接口协议', 'runninghub');
  assert.equal(h.state().videoTaskApi.provider, 'runninghub'); assert.equal(h.state().videoTaskApi.imageUploadEndpoint, defaultRunningHubVideoApi.imageUploadEndpoint);
  assert.match(h.state().videoTaskApi.requestTemplate || '', /nodeInfoList/u); h.change('input', 'RunningHub AI 应用 ID', '654321');
  assert.equal(h.required('input', '实际提交端点').props.value, 'https://www.runninghub.ai/openapi/v2/run/ai-app/654321');
  assert.equal(h.required('input', '实际提交端点').props.readOnly, true);
  h.click('恢复 RunningHub 预设'); assert.equal(h.state().videoTaskApi.runningHubAppId, '654321'); assert.equal(h.state().videoTaskApi.apiKey, 'fake-video-secret');
  h.click('高级协议与请求模板'); assert.match(h.text(), /nodeInfoList.*fieldValue/u); h.click('关闭');
  h.change('select', '视频接口协议', 'generic'); h.required('input', '视频 API 地址'); assert.equal(h.find('input', '提交端点'), undefined);
  assert.equal(h.state().videoTaskApi.apiKey, 'fake-video-secret');
  for (const node of h.all().filter((node) => node.type === 'input' && String(node.props.value || '').includes('fake-video-secret'))) assert.equal(node.props.type, 'password');
  assert.doesNotMatch(h.text(), /fake-video-secret/u); h.dispose();
});

await test('advanced request templates reject malformed JSON and embedded credentials before saving', () => {
  const settings = fixture(); settings.videoApiProfiles = [{ ...settings.videoTaskApi, id: 'a', name: 'a', createdAt: 1, updatedAt: 1 }]; settings.activeVideoApiProfileId = 'a';
  const h = harness(settings); h.click('高级协议与请求模板'); const baseline = h.state().videoTaskApi.requestTemplate;
  h.change('textarea', '视频请求模板 JSON', '{'); h.click('保存请求模板');
  assert.equal(h.state().videoTaskApi.requestTemplate, baseline); assert.ok(h.all().some((node) => node.props.role === 'alert'));
  assert.match(h.text(), /JSON 格式无法读取/u, 'malformed JSON must be classified as a local format error');
  assert.match(h.text(), /现有配置未被覆盖/u, 'the UI must explicitly confirm the previous template was kept');
  h.change('textarea', '视频请求模板 JSON', JSON.stringify({ apiKey: 'do-not-store-secret', prompt: '{{prompt}}' })); h.click('保存请求模板');
  assert.equal(h.state().videoTaskApi.requestTemplate, baseline);
  const text = JSON.stringify({ prompt: '{{prompt}}', references: '{{references}}', future: { typed: [1, false] } });
  h.change('textarea', '视频请求模板 JSON', text); h.click('保存请求模板');
  assert.equal(h.state().videoTaskApi.requestTemplate, text); assert.equal(h.state().videoApiProfiles![0].requestTemplate, text);
  assert.equal(h.state().videoTaskApi.apiKey, 'fake-video-secret'); h.click('关闭'); assert.equal(h.confirms.length, 0); h.dispose();
});

await test('a changed profile or externally changed template cannot be overwritten by an older editor', () => {
  for (const changeProfile of [true, false]) {
    const h = harness(); h.click('高级协议与请求模板'); h.change('textarea', '视频请求模板 JSON', '{"prompt":"{{prompt}}"}');
    h.external((state) => ({ ...state, activeVideoApiProfileId: changeProfile ? 'newer-profile' : state.activeVideoApiProfileId,
      videoTaskApi: { ...state.videoTaskApi, requestTemplate: changeProfile ? state.videoTaskApi.requestTemplate : '{"latest":true}' } }));
    const expected = h.state().videoTaskApi.requestTemplate; h.click('保存请求模板');
    assert.equal(h.state().videoTaskApi.requestTemplate, expected); assert.match(h.text(), /其它位置改变/u); h.dispose();
  }
});

await test('closing advanced settings guards unsaved template text', () => {
  const h = harness(); h.click('高级协议与请求模板'); h.change('textarea', '视频请求模板 JSON', '{"new":true}');
  h.click('关闭'); h.required('section', '视频 API 高级设置'); assert.equal(h.confirms.length, 1);
  h.confirmAnswers.push(true); h.click('关闭'); assert.equal(h.find('section', '视频 API 高级设置'), undefined);
  assert.notEqual(h.state().videoTaskApi.requestTemplate, '{"new":true}'); h.dispose();
});

await test('Comfy path modes and copying a latest image connection preserve both workflow libraries', () => {
  const settings = fixture('comfyui'); settings.imageApi = { ...settings.imageApi, backend: 'comfyui', baseUrl: 'http://old-image.invalid', apiKey: 'old-image-key' };
  settings.comfyuiVideo!.workflows = [workflow('existing')]; settings.comfyuiVideo!.activeWorkflowId = 'existing';
  const h = harness(settings); assert.equal(h.required('input', '视频任务提交路径').props.disabled, true);
  h.change('select', '视频 ComfyUI 接口路径模式', 'custom'); h.change('input', '视频任务提交路径', '/custom/prompt');
  assert.equal(h.state().comfyuiVideo!.promptPath, '/custom/prompt'); h.change('select', '视频 ComfyUI 接口路径模式', 'standard');
  assert.equal(h.state().comfyuiVideo!.promptPath, '/prompt');
  h.external((state) => ({ ...state, imageApi: { ...state.imageApi, baseUrl: 'http://latest-image.invalid', apiKey: 'latest-image-key' } }));
  const imageBefore = structuredClone(h.state().imageApi); h.click('复制生图连接地址');
  assert.equal(h.state().comfyuiVideo!.baseUrl, 'http://latest-image.invalid'); assert.equal(h.state().comfyuiVideo!.apiKey, 'latest-image-key');
  assert.deepEqual(h.state().comfyuiVideo!.workflows, settings.comfyuiVideo!.workflows); assert.deepEqual(h.state().imageApi, imageBefore); h.dispose();
});

await test('deferred import appends to latest workflows and never restores a stale connection', async () => {
  const settings = fixture('comfyui'); settings.comfyuiVideo!.workflows = [workflow('before')]; settings.comfyuiVideo!.activeWorkflowId = 'before';
  const h = harness(settings); let release!: (value: string) => void;
  h.importFile(() => new Promise<string>((resolve) => { release = resolve; }), '新工作流.json');
  assert.equal(h.required('button', '正在导入…').props.disabled, true);
  h.external((state) => ({ ...state, comfyuiVideo: { ...state.comfyuiVideo!, baseUrl: 'http://new-connection.invalid', apiKey: 'new-secret',
    workflows: [...state.comfyuiVideo!.workflows, workflow('parallel', '同时保存的工作流')] } }));
  const imageBefore = structuredClone(h.state().imageApi); release(workflowJson); await h.settle();
  assert.deepEqual(h.state().comfyuiVideo!.workflows.slice(0, 2).map((item) => item.id), ['before', 'parallel']);
  const imported = h.state().comfyuiVideo!.workflows[2]; assert.equal(imported.name, '新工作流'); assert.notEqual(imported.id, 'before');
  assert.equal(h.state().comfyuiVideo!.baseUrl, 'http://new-connection.invalid'); assert.equal(h.state().comfyuiVideo!.apiKey, 'new-secret');
  assert.equal(h.state().comfyuiVideo!.activeWorkflowId, imported.id); assert.equal(imported.workflowJson, workflowJson);
  assert.deepEqual(h.state().imageApi, imageBefore); h.dispose();
});

await test('repeated main-page imports get distinct names against the latest workflow list', async () => {
  const h = harness(fixture('comfyui'));
  h.importFile(async () => workflowJson, '同名工作流.json'); await h.settle();
  const first = structuredClone(h.state().comfyuiVideo!.workflows[0]);
  let release!: (value: string) => void;
  h.importFile(() => new Promise<string>((resolve) => { release = resolve; }), '同名工作流.json');
  h.external((state) => ({ ...state, comfyuiVideo: { ...state.comfyuiVideo!, workflows: [...state.comfyuiVideo!.workflows, workflow('parallel-suffix', '同名工作流 (2)')] } }));
  release(workflowJson); await h.settle();
  assert.deepEqual(h.state().comfyuiVideo!.workflows.map((item) => item.name), ['同名工作流', '同名工作流 (2)', '同名工作流 (3)']);
  assert.deepEqual(h.state().comfyuiVideo!.workflows[0], first, 'earlier same-name workflows remain untouched');
  assert.notEqual(h.state().comfyuiVideo!.workflows[2].id, first.id);
  assert.equal(h.state().comfyuiVideo!.activeWorkflowId, h.state().comfyuiVideo!.workflows[2].id);
  h.dispose();
});

await test('invalid or credential-bearing imports never replace existing workflows', async () => {
  for (const text of ['{', '{"nodes":[],"links":[]}', JSON.stringify({ prompt: JSON.parse(workflowJson), apiKey: 'embedded-secret' })]) {
    const settings = fixture('comfyui'); settings.comfyuiVideo!.workflows = [workflow('kept')]; settings.comfyuiVideo!.activeWorkflowId = 'kept';
    const h = harness(settings); const before = structuredClone(h.state().comfyuiVideo); h.importFile(async () => text); await h.settle();
    assert.deepEqual(h.state().comfyuiVideo, before); assert.ok(h.all().some((node) => node.props.role === 'alert'));
    if (text === '{') {
      assert.match(h.text(), /JSON 格式无法读取/u);
      assert.match(h.text(), /现有配置未被覆盖/u);
    }
    h.dispose();
  }
});

await test('inactive drafts and explicit no-current state cannot masquerade as an active workflow', () => {
  const settings = fixture('comfyui'); settings.comfyuiVideo!.workflows = [{ ...workflow('draft'), workflowJson: '{}', mapping: { prompt: [], images: [] } }, workflow('valid')];
  settings.comfyuiVideo!.activeWorkflowId = null;
  const h = harness(settings); assert.equal(h.required('select', '当前视频 Workflow').props.value, '');
  assert.match(h.text(), /尚未选择可用工作流/u);
  const draftOption = h.all().find((node) => node.type === 'option' && node.props.value === 'draft'); assert.equal(draftOption?.props.disabled, true);
  h.change('select', '当前视频 Workflow', 'draft'); assert.equal(h.state().comfyuiVideo!.activeWorkflowId, null);
  h.change('select', '当前视频 Workflow', 'valid'); assert.equal(h.state().comfyuiVideo!.activeWorkflowId, 'valid'); h.dispose();
});

await test('a file read completing after settings unmount cannot save into another page', async () => {
  const h = harness(fixture('comfyui')); let release!: (value: string) => void;
  h.importFile(() => new Promise<string>((resolve) => { release = resolve; }));
  h.dispose(); release(workflowJson); await h.settle(); assert.equal(h.patches.length, 0);
});

assert.match(source, /getCurrentSettings\?\.\(\)/u, 'async updates retain the authoritative settings accessor');
assert.match(source, /managerOpen\s*&&\s*<VideoWorkflowManager/u, 'workflow manager must not be mounted on the common page');
assert.match(source, /advancedOpen\s*&&/u, 'advanced protocol editors must not be mounted until requested');
assert.doesNotMatch(source, /\bfetch\s*\(|\.videoRequest\s*\(|\.startBatch\s*\(/u, 'settings edits must not start or submit paid video tasks');
console.log(`videoSettingsPanel: ${count} actual-component behavior checks passed without browser/API/data writes`);
