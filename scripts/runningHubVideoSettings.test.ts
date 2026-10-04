import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import ts from 'typescript';
import * as library from '../src/runningHubVideo';
import * as nodeLibrary from '../src/runningHubVideoNodes';
import * as fieldChoices from '../src/runningHubVideoFieldChoices';
import * as outputLibrary from '../src/runningHubVideoOutput';
import * as imageSlots from '../src/runningHubImageSlots';
import type { RunningHubVideoConfig, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';

// Execute the actual TSX callbacks with isolated hooks. No browser, cloud endpoint,
// real API keys or production project data is used by this regression suite.
interface Props { children?: React.ReactNode; [key: string]: any }
type Node = React.ReactElement<Props>;
const textOf = (value: React.ReactNode): string => {
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('');
  return React.isValidElement<Props>(value) ? textOf(value.props.children) : '';
};
const nodesOf = (value: React.ReactNode): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!React.isValidElement<Props>(value)) return [];
  if (typeof value.type === 'function' && value.type.name === 'Pager') return [value, ...nodesOf((value.type as (props: Props) => React.ReactElement)(value.props))];
  return [value, ...nodesOf(value.props.children)];
};
const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
interface Slot { value?: any; deps?: readonly unknown[]; cleanup?: () => void }
const seed = (name = '云端甲'): RunningHubVideoWorkflow => {
  const workflow = library.createRunningHubTutorialVideoWorkflow(); workflow.name = name; return workflow;
};
const fixture = (workflows: RunningHubVideoWorkflow[] = []): RunningHubVideoConfig => ({ enabled: false, baseUrl: 'https://www.runninghub.ai', apiKey: 'isolated-connection-key', workflows, activeWorkflowId: null });
interface DiscoveryIdentity { id: string; remoteId: string; runKind: 'ai-app' | 'workflow'; baseUrl: string; apiKey: string }
type DiscoveryResult = nodeLibrary.RunningHubVideoNodesResult;
interface HarnessOptions { discover?: (identity: DiscoveryIdentity, signal: AbortSignal) => Promise<DiscoveryResult> }

function harness(kind: 'manager' | 'settings', initial = fixture(), options: HarnessOptions = {}) {
  let current = structuredClone(initial); let displayed: RunningHubVideoConfig | undefined;
  let tree: React.ReactElement; let cursor = 0; let rerenderNeeded = true; let disposed = false; let closed = 0; let updatesAfterDispose = 0;
  const slots: Slot[] = []; let effects: Array<() => void> = []; const changes: RunningHubVideoConfig[] = [];
  const discoveryCalls: Array<{ identity: DiscoveryIdentity; signal: AbortSignal }> = [];
  const ensuredFields: string[] = [];
  const hooks = {
    useState: (initialValue: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }; return [slots[index].value, (next: unknown) => { if (disposed) updatesAfterDispose += 1; const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; rerenderNeeded = true; } }]; },
    useRef: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    useMemo: (calculate: () => unknown, deps?: readonly unknown[]) => { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: calculate(), deps }; return slots[index].value; },
    useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) { const previous = slots[index]; slots[index] = { ...previous, deps }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect() || undefined; }); } },
  };
  const filename = kind === 'manager' ? 'RunningHubWorkflowManager' : 'RunningHubVideoSettings';
  const source = readFileSync(new URL(`../src/components/${filename}.tsx`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const fakeRequire = (name: string) => {
    if (name === 'react') return { ...React, ...hooks };
    if (name === 'react-dom') return { createPortal: (value: unknown) => value };
    if (name === '../runningHubVideo') return { ...library, ensureRunningHubVideoRequestNode: (...args: Parameters<typeof library.ensureRunningHubVideoRequestNode>) => {
      ensuredFields.push(JSON.stringify([args[1].nodeId, args[1].fieldName])); return library.ensureRunningHubVideoRequestNode(...args);
    } };
    if (name === '../runningHubVideoNodes') return nodeLibrary;
    if (name === '../runningHubVideoFieldChoices') return fieldChoices;
    if (name === '../runningHubVideoOutput') return outputLibrary;
    if (name === '../runningHubImageSlots') return imageSlots;
    if (name === '../services/runningHubVideoDiscovery') return { discoverRunningHubVideoNodes: (identity: DiscoveryIdentity, signal: AbortSignal) => {
      discoveryCalls.push({ identity: structuredClone(identity), signal });
      return options.discover ? options.discover(identity, signal) : Promise.reject(new Error('测试禁止未经显式模拟的节点读取'));
    } };
    if (name === './RunningHubWorkflowManager') return { RunningHubWorkflowManager: () => null };
    if (name === 'lucide-react') return { Cloud: () => null, ExternalLink: () => null, FolderOpen: () => null };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected component import: ${name}`);
  };
  new Function('require', 'module', 'exports', 'React', compiled)(fakeRequire, module, module.exports, React);
  const Component = module.exports[filename] as (props: Props) => React.ReactElement;
  function render() {
    assert.equal(disposed, false); let attempts = 0;
    do { assert.ok(attempts++ < 20, 'effects settle without a render loop'); cursor = 0; rerenderNeeded = false;
      tree = Component({ config: displayed || current, getCurrentConfig: () => current, onChange: (next: RunningHubVideoConfig) => { current = next; changes.push(structuredClone(next)); rerenderNeeded = true; }, onClose: () => { closed += 1; } });
      const queue = effects; effects = []; queue.forEach((effect) => effect());
    } while (rerenderNeeded);
    return tree!;
  }
  const all = () => nodesOf(tree!);
  const find = (type: string, label: string) => all().find((node) => node.type === type && (node.props['aria-label'] === label || textOf(node.props.children) === label));
  const required = (type: string, label: string) => { const node = find(type, label); assert.ok(node, `missing ${type}: ${label}`); return node; };
  const click = (label: string) => { const node = required('button', label); assert.ok(!node.props.disabled, `${label} is enabled`); node.props.onClick(); render(); };
  const change = (type: string, label: string, value: string | boolean) => { const node = required(type, label); assert.ok(!node.props.disabled, `${label} is enabled`); node.props.onChange({ target: { value, checked: value } }); render(); };
  const file = (name: string, text: () => Promise<string>, size = 50, label = '导入 RunningHub 配置文件') => {
    const input = required('input', label); assert.equal(input.props.type, 'file');
    input.props.onChange({ target: { value: name, files: [{ name, text, size }] } }); render();
  };
  render();
  return { click, change, file, required, find, all, render, discoveryCalls, ensuredFields, get state() { return current; }, get patches() { return changes; }, get closed() { return closed; }, get updatesAfterDispose() { return updatesAfterDispose; }, text: () => textOf(tree!),
    external: (next: RunningHubVideoConfig, stale = false) => { if (stale) displayed = current; current = next; render(); },
    dispose: () => { for (const slot of slots) slot.cleanup?.(); disposed = true; } };
}

let groups = 0;
const test = (name: string, action: () => void) => { action(); groups += 1; console.log(`PASS ${name}`); };
const testAsync = async (name: string, action: () => Promise<void>) => { await action(); groups += 1; console.log(`PASS ${name}`); };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; };
const optionValues = (h: ReturnType<typeof harness>, label: string): string[] => nodesOf(h.required('select', label).props.children)
  .filter((node) => node.type === 'option').map((node) => String(node.props.value));
const fieldOptionValues = (h: ReturnType<typeof harness>, label: string): string[] => optionValues(h, label).filter((value) => value !== '["",""]');

test('独立连接密钥隐藏，地区与开关只修改云端连接', () => {
  const original = seed(); const h = harness('settings', fixture([original]));
  assert.equal(h.required('input', 'RunningHub API Key').props.type, 'password');
  h.change('select', 'RunningHub 服务地区', 'cn'); assert.equal(h.state.baseUrl, 'https://www.runninghub.cn');
  h.change('select', 'RunningHub 服务地区', 'custom'); assert.equal(h.state.baseUrl, 'https://www.runninghub.cn', 'choosing custom must not erase the address');
  h.change('input', 'RunningHub API Key', 'new-fake-key'); h.change('input', '启用 RunningHub 云端视频', true);
  assert.equal(h.state.enabled, true); assert.equal(h.state.apiKey, 'new-fake-key'); assert.deepEqual(h.state.workflows, [original]);
  h.dispose();
});

await testAsync('邀请注册保留指定邀请码，桌面浏览器正确打开且不改变任何API配置', async () => {
  const originalWindow = globalThis.window;
  const expected = 'https://www.runninghub.ai?inviteCode=e19djpw0';
  const opened: string[] = [];
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
      lianhuaDesktop: { openExternal: async (url: string) => { opened.push(url); } },
    } });
    const h = harness('settings', { ...fixture(), baseUrl: 'https://www.runninghub.cn' });
    const before = structuredClone(h.state);
    const link = h.required('a', '通过邀请链接注册 RunningHub');
    assert.equal(link.props.href, expected);
    assert.equal(link.props.target, '_blank');
    assert.equal(link.props.rel, 'noopener noreferrer');
    let prevented = false;
    await link.props.onClick({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(opened, [expected], 'invite URL must not follow the selected API region or drop its query');
    assert.deepEqual(h.state, before);
    assert.equal(h.patches.length, 0, 'registration must not save config, enable the backend or submit a task');
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} });
    await link.props.onClick({ preventDefault: () => assert.fail('web mode must use the real anchor fallback') });
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
      lianhuaDesktop: { openExternal: async () => { throw new Error('mock browser failure'); } },
    } });
    await link.props.onClick({ preventDefault: () => {} });
    h.render();
    assert.match(h.text(), /无法打开 RunningHub 邀请链接/u);
    assert.deepEqual(h.state, before);
    h.dispose();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
  }
});

test('主面板权威 getter 防止旧 props 覆盖新工作流与密钥', () => {
  const original = seed(); const h = harness('settings', fixture([original])); const added = seed('外部新增');
  h.external({ ...h.state, apiKey: 'newer-external-key', workflows: [original, added] }, true);
  h.change('input', 'RunningHub API 根地址', 'https://cloud.example.invalid');
  assert.equal(h.state.apiKey, 'newer-external-key'); assert.equal(h.state.workflows.length, 2);
  h.change('select', '当前 RunningHub 工作流', original.id); assert.equal(h.state.activeWorkflowId, original.id);
  h.change('select', '当前 RunningHub 工作流', ''); assert.equal(h.state.activeWorkflowId, null); assert.equal(h.state.enabled, false);
  h.dispose();
});

test('教程样板空剧情、不自动保存激活、不请求云端', () => {
  const h = harness('manager'); h.click('教程结构样板'); assert.equal(h.state.workflows.length, 0);
  h.click('保存工作流'); const workflow = h.state.workflows[0]; assert.ok(workflow);
  assert.match(workflow.requestTemplate, /\{\{prompt\}\}/u); assert.match(workflow.requestTemplate, /\{\{image_1\}\}/u);
  assert.equal(h.state.activeWorkflowId, null); assert.equal(h.state.enabled, false);
  h.click('设为当前'); assert.equal(h.state.activeWorkflowId, workflow.id); assert.equal(h.state.enabled, false);
  h.dispose();
});

test('复制重命名独立保存，显式切换不改原件', () => {
  const original = seed(); const h = harness('manager', { ...fixture([original]), enabled: true, activeWorkflowId: original.id });
  h.click('复制'); h.change('input', 'RunningHub 工作流名称', '云端乙'); h.click('保存工作流');
  assert.equal(h.state.workflows.length, 2); assert.deepEqual(h.state.workflows[0], original); assert.equal(h.state.activeWorkflowId, original.id);
  const copy = h.state.workflows[1]; assert.notEqual(copy.id, original.id); h.click('设为当前'); assert.equal(h.state.activeWorkflowId, copy.id);
  h.click('删除'); h.click('取消'); assert.equal(h.state.workflows.length, 2);
  h.click('删除'); assert.match(h.text(), /删除后当前工作流切换为“云端甲”/u); h.click('确认删除云端工作流');
  assert.equal(h.state.workflows.length, 1); assert.equal(h.state.activeWorkflowId, original.id); assert.equal(h.state.enabled, true);
  h.dispose();
});

test('空草稿可保存但不可激活，未保存关闭必须确认', () => {
  const h = harness('manager'); h.click('新建'); h.change('input', 'RunningHub 工作流名称', '草稿');
  h.click('完成'); assert.equal(h.closed, 0); h.click('取消'); assert.equal(h.required('input', 'RunningHub 工作流名称').props.value, '草稿');
  h.click('保存工作流'); assert.equal(h.state.workflows.length, 1); assert.equal(h.required('button', '设为当前').props.disabled, true);
  h.change('input', 'RunningHub 工作流名称', '新名字'); h.click('完成'); h.click('放弃编辑并继续');
  assert.equal(h.closed, 1); assert.equal(h.state.workflows[0].name, '草稿'); h.dispose();
});

const importBody = JSON.stringify({ nodeInfoList: [{ nodeId: '137', fieldName: 'image', fieldValue: 'original.png' }, { nodeId: '138', fieldName: 'value', fieldValue: 'original prompt' }, { nodeId: '164', fieldName: 'audio', fieldValue: 'None' }], usePersonalQueue: 'false' });
const importCurl = `curl --request POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/2084261333662810113' --header 'Authorization: Bearer fake-import-secret' --data-raw '${importBody}'`;
test('cURL只读取不执行，导入新增未激活，图片自动列出而提示词明确绑定', () => {
  const original = seed(); const h = harness('manager', { ...fixture([original]), activeWorkflowId: original.id });
  h.click('导入 cURL / JSON'); h.change('input', '导入的 RunningHub 工作流名称', '导入云端视频');
  h.change('textarea', 'RunningHub 导入文本', importCurl); h.click('导入为新工作流');
  assert.equal(h.state.workflows.length, 2); assert.equal(h.state.activeWorkflowId, original.id); assert.equal(h.state.apiKey, 'isolated-connection-key');
  const imported = h.state.workflows[1]; assert.equal(imported.remoteId, '2084261333662810113'); assert.equal(imported.mapping.prompt.length, 0);
  assert.doesNotMatch(JSON.stringify(h.state), /fake-import-secret/u);
  h.click('添加云端提示词输入'); h.change('select', '云端映射字段范围', 'all');
  assert.ok(fieldOptionValues(h, '云端提示词 1 节点字段').includes(JSON.stringify(['138', 'value'])), 'the unknown value field is reachable through advanced options');
  h.change('select', '云端提示词 1 节点字段', JSON.stringify(['138', 'value']));
  h.click('参考图片槽 1'); assert.equal(textOf(h.required('code', '云端图片槽 1 节点字段')), '137.image');
  assert.equal(h.find('select', '云端图片槽 1 用途'), undefined, 'slot purpose is selected per video segment, not in API settings');
  h.click('保存工作流'); h.click('设为当前');
  const saved = h.state.workflows.find((workflow) => workflow.id === imported.id)!;
  assert.equal(saved.mapping.images[0].role, 'general', 'newly detected slots keep a neutral compatibility role; purpose is selected per segment'); assert.equal(library.readRunningHubVideoRequest(saved.requestTemplate).nodeInfoList[2].fieldValue, 'None');
  h.dispose();
});

test('JSON编辑不重新推断映射，坏JSON不会覆盖已保存设置', () => {
  const original = seed(); original.mapping.images[0].role = 'first-frame'; const h = harness('manager', fixture([original]));
  h.click('请求 JSON'); h.change('textarea', 'RunningHub 请求 JSON 编辑稿', '{'); h.click('保存工作流');
  assert.deepEqual(h.state.workflows, [original]); assert.ok(h.all().some((node) => node.props.role === 'alert'));
  h.change('textarea', 'RunningHub 请求 JSON 编辑稿', original.requestTemplate.replace('"default"', '"plus"')); h.click('保存工作流');
  assert.deepEqual(h.state.workflows[0].mapping, original.mapping); assert.equal(library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate).instanceType, 'plus'); h.dispose();
});

test('保留秒数允许逐字符输入，默认无费用，清空后不发送', () => {
  const original = seed(); const h = harness('manager', fixture([original])); h.click('云端运行');
  assert.equal(h.required('input', 'RunningHub 实例保留秒数').props.value, '');
  h.change('input', 'RunningHub 实例保留秒数', '1'); assert.equal(h.required('input', 'RunningHub 实例保留秒数').props.value, '1');
  h.click('保存工作流'); assert.deepEqual(h.state.workflows, [original]); assert.match(h.text(), /10–180/u);
  h.change('input', 'RunningHub 实例保留秒数', '120'); h.change('select', 'RunningHub 个人队列', 'true'); h.click('保存工作流');
  let request = library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate); assert.equal(request.retainSeconds, 120); assert.equal(request.usePersonalQueue, true);
  h.change('input', 'RunningHub 实例保留秒数', ''); h.change('input', 'RunningHub Webhook 回调地址', 'https://callback.example.invalid/video'); h.click('保存工作流');
  request = library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate); assert.equal(request.retainSeconds, undefined); assert.equal(request.webhookUrl, 'https://callback.example.invalid/video');
  h.change('input', 'RunningHub Webhook 回调地址', ''); h.click('保存工作流'); assert.equal(library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate).webhookUrl, undefined); h.dispose();
});

test('常量编辑保留类型和无关字段，图片与提示词不能作为常量乱改', () => {
  const original = seed(); const h = harness('manager', fixture([original])); h.click('节点参数');
  assert.equal(h.required('input', '云端字段 137.image 默认值').props.disabled, true);
  h.change('input', '云端字段 160.value 默认值', 'true'); h.click('保存工作流');
  const request = library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate); assert.equal(request.nodeInfoList[1].fieldValue, 'true');
  assert.equal(request.nodeInfoList[2].fieldValue, 'None'); assert.equal(request.nodeInfoList[6].fieldValue, 'MysticXXX_MMH3-V1.safetensors');
  h.dispose();
});

test('权威配置并发更新不丢失密钥或新库条目，选中工作流冲突不覆盖', () => {
  const original = seed(); const h = harness('manager', fixture([original])); const added = seed('外部工作流');
  h.external({ ...h.state, apiKey: 'new-authoritative-key', workflows: [original, added] }, true);
  h.change('input', 'RunningHub 工作流名称', '重命名甲'); h.click('保存工作流');
  assert.equal(h.state.workflows.length, 2); assert.equal(h.state.apiKey, 'new-authoritative-key'); assert.equal(h.state.workflows[1].id, added.id);
  const changedExternally = { ...h.state.workflows[0], name: '外部重命名甲', updatedAt: Date.now() + 2000 };
  h.external({ ...h.state, workflows: [changedExternally, added] }, true);
  h.change('input', 'RunningHub 工作流名称', '不可覆盖'); h.click('保存工作流');
  assert.equal(h.state.workflows[0].name, '外部重命名甲'); assert.match(h.text(), /已在其他位置变化/u);
  h.dispose();
});

test('选择前发生外部修改时禁止按陈旧预览激活', () => {
  const original = seed(); const h = harness('manager', fixture([original]));
  h.external({ ...h.state, workflows: [{ ...original, remoteId: '9000000000000000099' }] }, true);
  h.click('设为当前'); assert.equal(h.state.activeWorkflowId, null); assert.match(h.text(), /重新打开核对/u); h.dispose();
});

test('无关本地ComfyUI图拒绝导入且不覆盖现有工作流', () => {
  const original = seed(); const h = harness('manager', fixture([original])); h.click('导入 cURL / JSON');
  h.change('textarea', 'RunningHub 导入文本', JSON.stringify({ '4': { class_type: 'KSampler', inputs: { seed: 33 } } }));
  h.click('导入为新工作流'); assert.deepEqual(h.state.workflows, [original]); assert.match(h.text(), /nodeInfoList/u); h.dispose();
});

test('损坏nodeInfoList草稿可检查修复，切换参数/映射页不白屏', () => {
  const original = seed(); original.requestTemplate = '{"nodeInfoList":[null,17,{}, {"nodeId":"138","fieldName":"value","fieldValue":"a"}]}';
  const h = harness('manager', fixture([original]));
  h.click('节点参数'); assert.ok(h.required('input', '云端字段 138.value 默认值'));
  h.click('提示词与图片'); assert.ok(h.required('select', '云端提示词 1 节点字段'));
  assert.equal(h.required('button', '设为当前').props.disabled, true); h.dispose();
});

test('丢弃导入文本也需要确认，取消不影响原草稿', () => {
  const original = seed(); const h = harness('manager', fixture([original]));
  h.change('input', 'RunningHub 工作流名称', '原编辑稿'); h.click('导入 cURL / JSON'); h.change('textarea', 'RunningHub 导入文本', importCurl);
  h.click('关闭导入'); h.click('取消'); assert.equal(h.required('textarea', 'RunningHub 导入文本').props.value, importCurl);
  h.click('关闭导入'); h.click('放弃导入文本'); assert.equal(h.required('input', 'RunningHub 工作流名称').props.value, '原编辑稿'); h.dispose();
});

// Persisted workflows already normalize the legacy string queue flag to a boolean.
const emptyNodeRequest = '{\n  "addMetadata": true, "nodeInfoList": [],\n  "instanceType": "default", "usePersonalQueue": false, "customFlag": "keep-original"\n}';
const emptyNodeWorkflow = (name = '空节点工作流'): RunningHubVideoWorkflow => ({ ...library.createRunningHubVideoWorkflow(), name, runKind: 'workflow', remoteId: '2093983063180054529', requestTemplate: emptyNodeRequest, mapping: { prompt: [], images: [] } });
const apiNodeGraph = JSON.stringify({
  '12': { class_type: 'CLIPTextEncode', _meta: { title: '视频正文' }, inputs: { text: 'cloud prompt', clip: ['11', 0] } },
  '20': { class_type: 'LoadImage', _meta: { title: '起始图片' }, inputs: { image: 'cloud-original.png' } },
  '30': { class_type: 'KSampler', _meta: { title: '采样参数' }, inputs: { seed: 7, steps: 20, cfg: 7.5, sampler_name: 'euler', model: ['11', 0] } },
  '40': { class_type: 'SaveVideo', inputs: { filename_prefix: 'cloud-result', images: ['35', 0] } },
});
const importNodes = (h: ReturnType<typeof harness>, source = apiNodeGraph) => { h.click('导入节点 JSON'); h.change('textarea', 'RunningHub 节点 JSON', source); h.click('加入节点目录'); };
const draftRequest = (h: ReturnType<typeof harness>) => { h.click('请求 JSON'); return String(h.required('textarea', 'RunningHub 请求 JSON 编辑稿').props.value); };
const fieldKey = (nodeId: string, inputName: string) => JSON.stringify([nodeId, inputName]);
const seventyFourFieldWorkflow = (name = '七十四字段甲'): RunningHubVideoWorkflow => {
  const nodeCatalog = [
    { nodeId: '10', fieldName: 'text', fieldValue: 'cloud prompt', description: '正向提示词 · CLIPTextEncode' },
    { nodeId: '20', fieldName: 'image', fieldValue: 'cloud-reference.png', description: '参考图片 · LoadImage' },
    { nodeId: '30', fieldName: 'seed', fieldValue: 7, description: '随机种子' },
    { nodeId: '30', fieldName: 'steps', fieldValue: 20, description: '采样步数' },
    { nodeId: '30', fieldName: 'width', fieldValue: 1280, description: '视频宽度' },
    { nodeId: '30', fieldName: 'height', fieldValue: 720, description: '视频高度' },
    ...Array.from({ length: 68 }, (_, index) => ({ nodeId: String(100 + index), fieldName: `custom_field_${index}`, fieldValue: `cloud-default-${index}`, description: '内部字段 · CustomNode' })),
  ];
  return { ...emptyNodeWorkflow(name), nodeCatalog,
    requestTemplate: JSON.stringify({ nodeInfoList: nodeCatalog.slice(0, 2).map(({ nodeId, fieldName, fieldValue }) => ({ nodeId, fieldName, fieldValue })), addMetadata: true, instanceType: 'default', usePersonalQueue: false, customFlag: 'keep-74' }),
    mapping: { prompt: [{ nodeId: '10', inputName: 'text' }], images: [{ nodeId: '20', inputName: 'image' }] },
  };
};

test('74字段默认按提示词与图片用途筛选，高级与搜索可找未知字段且不会改请求', () => {
  const original = seventyFourFieldWorkflow(); const h = harness('manager', fixture([original])); h.click('提示词与图片');
  assert.equal(original.nodeCatalog?.length, 74);
  assert.deepEqual(optionValues(h, '云端映射字段范围'), ['common', 'all']);
  assert.equal(h.required('select', '云端映射字段范围').props.value, 'common');
  assert.deepEqual(fieldOptionValues(h, '云端提示词 1 节点字段'), [fieldKey('10', 'text')]);
  h.change('select', '云端映射字段范围', 'all');
  const allPromptFields = fieldOptionValues(h, '云端提示词 1 节点字段');
  assert.equal(allPromptFields.length, 74); assert.equal(new Set(allPromptFields).size, 74);
  assert.ok(allPromptFields.includes(fieldKey('100', 'custom_field_0')));
  h.change('input', '搜索云端映射字段', 'custom_field_67');
  assert.deepEqual(fieldOptionValues(h, '云端提示词 1 节点字段'), [fieldKey('10', 'text'), fieldKey('167', 'custom_field_67')]);
  h.change('select', '云端映射字段范围', 'common');
  assert.deepEqual(fieldOptionValues(h, '云端提示词 1 节点字段'), [fieldKey('10', 'text')], 'unknown fields do not leak into the common list through search');
  h.change('input', '搜索云端映射字段', ''); h.click('参考图片槽 1');
  assert.equal(textOf(h.required('code', '云端图片槽 1 节点字段')), '20.image');
  assert.equal(h.find('select', '云端图片槽 1 节点字段'), undefined, 'image node identities are read-only');
  assert.equal(h.find('select', '云端映射字段范围'), undefined, 'all image slots are shown without a filter');
  assert.equal(h.find('button', '添加云端图片槽'), undefined);
  assert.equal(draftRequest(h), original.requestTemplate);
  assert.equal(h.required('button', '保存工作流').props.disabled, true); assert.deepEqual(h.state.workflows, [original]);
  assert.equal(h.ensuredFields.length, 0); assert.equal(h.patches.length, 0); assert.equal(h.discoveryCalls.length, 0);
  h.click('完成'); assert.equal(h.closed, 1, 'view filters do not create an unsaved-edit confirmation'); h.dispose();
});

test('未知旧绑定在常用候选和不匹配搜索下仍可见，不自动移除或改成推荐节点', () => {
  const original = seventyFourFieldWorkflow('旧绑定');
  const request = library.readRunningHubVideoRequest(original.requestTemplate);
  request.nodeInfoList.push(...original.nodeCatalog!.filter((node) => ['165', '166'].includes(node.nodeId)).map((node) => ({ ...node })));
  original.requestTemplate = JSON.stringify(request);
  original.mapping = { prompt: [{ nodeId: '165', inputName: 'custom_field_65' }], images: [{ nodeId: '166', inputName: 'custom_field_66', role: 'first-frame' }] };
  const h = harness('manager', fixture([original])); h.click('提示词与图片');
  assert.deepEqual(fieldOptionValues(h, '云端提示词 1 节点字段'), [fieldKey('10', 'text'), fieldKey('165', 'custom_field_65')]);
  h.change('input', '搜索云端映射字段', 'no-matching-candidate');
  assert.deepEqual(fieldOptionValues(h, '云端提示词 1 节点字段'), [fieldKey('165', 'custom_field_65')]);
  assert.equal(h.required('select', '云端提示词 1 节点字段').props.value, fieldKey('165', 'custom_field_65'));
  h.change('input', '搜索云端映射字段', ''); h.click('参考图片槽 2');
  assert.equal(textOf(h.required('code', '云端图片槽 1 节点字段')), '166.custom_field_66');
  assert.equal(textOf(h.required('code', '云端图片槽 2 节点字段')), '20.image', 'recognized image appends without displacing a custom legacy slot');
  assert.equal(h.find('select', '云端图片槽 1 用途'), undefined, 'legacy slot roles are read-only compatibility metadata');
  assert.equal(draftRequest(h), original.requestTemplate); assert.deepEqual(h.state.workflows, [original]);
  assert.equal(h.required('button', '保存工作流').props.disabled, false, 'only the new editor slot is pending explicit save'); assert.equal(h.ensuredFields.length, 0); h.dispose();

  const missing = seventyFourFieldWorkflow('目录中缺失的旧绑定'); missing.mapping.prompt = [{ nodeId: '999', inputName: 'missing_value' }];
  const absent = harness('manager', fixture([missing])); absent.click('提示词与图片');
  absent.change('input', '搜索云端映射字段', 'no-matching-candidate');
  assert.deepEqual(fieldOptionValues(absent, '云端提示词 1 节点字段'), [fieldKey('999', 'missing_value')]);
  assert.equal(absent.required('select', '云端提示词 1 节点字段').props.value, fieldKey('999', 'missing_value'));
  assert.match(textOf(absent.required('select', '云端提示词 1 节点字段').props.children), /节点目录中不存在/u);
  assert.equal(absent.required('button', '保存工作流').props.disabled, true); assert.equal(absent.ensuredFields.length, 0); absent.dispose();
});

test('节点参数常用范围保留原请求与显式参数映射，未知目录字段仅在高级出现', () => {
  const original = seventyFourFieldWorkflow('参数兼容'); const request = library.readRunningHubVideoRequest(original.requestTemplate);
  request.nodeInfoList.push({ ...original.nodeCatalog!.find((node) => node.nodeId === '160')! }); original.requestTemplate = JSON.stringify(request);
  original.mapping.parameters = { legacy_special: { nodeId: '167', inputName: 'custom_field_67' } };
  const h = harness('manager', fixture([original])); h.click('节点参数');
  assert.deepEqual(optionValues(h, '云端参数字段范围'), ['common', 'all']); assert.equal(h.required('select', '云端参数字段范围').props.value, 'common');
  assert.ok(h.find('input', '云端字段 10.text 默认值')); assert.ok(h.find('input', '云端字段 20.image 默认值'));
  h.change('input', '搜索云端节点字段', '160.custom_field_60'); assert.ok(h.find('input', '云端字段 160.custom_field_60 默认值'), 'an old request field remains accessible without changing scope');
  h.change('input', '搜索云端节点字段', '167.custom_field_67'); assert.ok(h.find('input', '云端字段 167.custom_field_67 默认值'), 'an explicit parameter binding remains accessible');
  assert.equal(h.required('input', '云端字段 167.custom_field_67 参数名').props.value, 'legacy_special');
  h.change('input', '搜索云端节点字段', '30.seed'); assert.ok(h.find('input', '云端字段 30.seed 默认值'));
  h.change('input', '搜索云端节点字段', '100.custom_field_0'); assert.equal(h.find('input', '云端字段 100.custom_field_0 默认值'), undefined);
  h.change('select', '云端参数字段范围', 'all'); assert.ok(h.find('input', '云端字段 100.custom_field_0 默认值'));
  assert.equal(draftRequest(h), original.requestTemplate); assert.deepEqual(h.state.workflows, [original]);
  assert.equal(h.required('button', '保存工作流').props.disabled, true); assert.equal(h.ensuredFields.length, 0); assert.equal(h.patches.length, 0); h.dispose();
});

test('切换工作流恢复常用范围并清空两处搜索，筛选本身不会造成未保存弹窗', () => {
  const first = seventyFourFieldWorkflow('筛选甲'); const second = seventyFourFieldWorkflow('筛选乙');
  const h = harness('manager', fixture([first, second])); h.click('提示词与图片');
  h.change('select', '云端映射字段范围', 'all'); h.change('input', '搜索云端映射字段', 'custom_field_67');
  h.click('节点参数'); h.change('select', '云端参数字段范围', 'all'); h.change('input', '搜索云端节点字段', '100.custom_field_0');
  assert.equal(h.required('button', '保存工作流').props.disabled, true); h.click('编辑云端工作流 筛选乙');
  assert.equal(h.find('button', '放弃编辑并继续'), undefined);
  h.click('提示词与图片'); assert.equal(h.required('select', '云端映射字段范围').props.value, 'common');
  assert.equal(h.required('input', '搜索云端映射字段').props.value, '');
  assert.deepEqual(fieldOptionValues(h, '云端提示词 1 节点字段'), [fieldKey('10', 'text')]);
  h.click('节点参数'); assert.equal(h.required('select', '云端参数字段范围').props.value, 'common');
  assert.equal(h.required('input', '搜索云端节点字段').props.value, '');
  assert.equal(draftRequest(h), second.requestTemplate); assert.deepEqual(h.state.workflows, [first, second]);
  assert.equal(h.ensuredFields.length, 0); assert.equal(h.patches.length, 0); assert.equal(h.discoveryCalls.length, 0); h.dispose();
});

test('空提交模板导入真实节点自动列出图片槽，提示词仍需明确绑定', () => {
  const original = emptyNodeWorkflow(); const h = harness('manager', fixture([original]));
  h.click('提示词与图片'); assert.match(h.text(), /nodeInfoList 为空/u); importNodes(h);
  assert.equal(h.discoveryCalls.length, 0, 'local node import never queries a cloud endpoint');
  assert.deepEqual(h.state.workflows, [original], 'node discovery does not save or activate');
  const imageOnlyRequest = library.readRunningHubVideoRequest(draftRequest(h));
  assert.deepEqual(imageOnlyRequest.nodeInfoList.map((node) => [node.nodeId, node.fieldName]), [['20', 'image']], 'only a real image input is added to the unsaved draft');
  h.click('保存工作流'); assert.deepEqual(h.state.workflows[0].mapping.images, [{ nodeId: '20', inputName: 'image', role: 'general' }]);
  assert.equal(h.state.workflows[0].nodeCatalog?.length, 7, 'links are not editable scalar fields');
  h.click('提示词与图片'); h.click('添加云端提示词输入');
  const options = textOf(h.required('select', '云端提示词 1 节点字段').props.children);
  assert.match(options, /12\.text/u); assert.doesNotMatch(options, /20\.image/u); assert.doesNotMatch(options, /12\.clip/u);
  assert.deepEqual(fieldOptionValues(h, '云端提示词 1 节点字段'), [JSON.stringify(['12', 'text'])]);
  h.change('select', '云端提示词 1 节点字段', JSON.stringify(['12', 'text']));
  let request = library.readRunningHubVideoRequest(draftRequest(h));
  assert.deepEqual(request.nodeInfoList.map((node) => [node.nodeId, node.fieldName]), [['20', 'image'], ['12', 'text']]);
  h.click('提示词与图片'); h.click('参考图片槽 1');
  assert.equal(textOf(h.required('code', '云端图片槽 1 节点字段')), '20.image'); assert.equal(h.find('select', '云端图片槽 1 用途'), undefined);
  h.click('保存工作流'); request = library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate);
  assert.deepEqual(request.nodeInfoList.map((node) => [node.nodeId, node.fieldName, node.fieldValue]), [['20', 'image', 'cloud-original.png'], ['12', 'text', 'cloud prompt']]);
  assert.equal(request.addMetadata, true); assert.equal(request.usePersonalQueue, false); assert.equal(request.customFlag, 'keep-original');
  assert.equal(h.state.workflows[0].remoteId, '2093983063180054529'); assert.equal(h.state.workflows[0].mapping.images[0].role, 'general');
  assert.equal(h.state.activeWorkflowId, null); assert.equal(h.state.enabled, false); h.dispose();
});

test('节点目录支持搜索和分页，只显式编辑的标量入请求，保存复制与备份重载保持独立', () => {
  const original = emptyNodeWorkflow(); const h = harness('manager', fixture([original]));
  h.click('节点参数'); importNodes(h);
  h.change('select', '云端参数字段范围', 'all');
  assert.ok(h.find('input', '云端字段 12.text 默认值')); assert.ok(h.find('input', '云端字段 20.image 默认值'));
  h.click('云端节点参数下一页'); assert.ok(h.find('input', '云端字段 30.seed 默认值')); assert.ok(h.find('input', '云端字段 30.steps 默认值'));
  h.change('input', '搜索云端节点字段', '30.cfg'); assert.ok(h.find('input', '云端字段 30.cfg 默认值')); assert.equal(h.find('input', '云端字段 30.seed 默认值'), undefined);
  h.change('input', '云端字段 30.cfg 默认值', '9.25');
  h.change('input', '搜索云端节点字段', '30.seed'); h.change('input', '云端字段 30.seed 参数名', 'seed'); h.change('input', '云端字段 30.seed 默认值', '42');
  h.click('保存工作流'); const saved = structuredClone(h.state.workflows[0]);
  const request = library.readRunningHubVideoRequest(saved.requestTemplate);
  assert.deepEqual(request.nodeInfoList.map((node) => [node.nodeId, node.fieldName]).sort(), [['20', 'image'], ['30', 'cfg'], ['30', 'seed']]);
  assert.equal(request.nodeInfoList.find((node) => node.fieldName === 'cfg')?.fieldValue, 9.25);
  assert.equal(request.nodeInfoList.find((node) => node.fieldName === 'seed')?.fieldValue, 42);
  assert.deepEqual(saved.mapping.parameters, { seed: { nodeId: '30', inputName: 'seed' } });
  assert.equal(saved.nodeCatalog?.length, 7); assert.equal(request.customFlag, 'keep-original');
  h.change('input', '搜索云端节点字段', 'no-such-field'); assert.match(h.text(), /未找到匹配字段/u);
  h.click('复制'); h.change('input', 'RunningHub 工作流名称', '目录独立副本'); h.click('保存工作流');
  assert.equal(h.state.workflows.length, 2); assert.deepEqual(h.state.workflows[0], saved);
  const copied = h.state.workflows[1]; assert.notEqual(copied.id, saved.id); assert.deepEqual(copied.nodeCatalog, saved.nodeCatalog);
  h.click('节点参数'); h.change('input', '搜索云端节点字段', '30.seed'); h.change('input', '云端字段 30.seed 默认值', '99'); h.click('保存工作流');
  assert.deepEqual(h.state.workflows[0], saved, 'copy edits cannot write the original workflow');
  const backup = library.exportRunningHubVideoWorkflow(saved);
  assert.doesNotMatch(backup, /isolated-connection-key/u);
  h.click('导入 cURL / JSON'); h.change('textarea', 'RunningHub 导入文本', backup); h.click('导入为新工作流');
  assert.equal(h.state.workflows.length, 3); assert.deepEqual(h.state.workflows[2].nodeCatalog, saved.nodeCatalog); assert.equal(h.state.workflows[2].requestTemplate, saved.requestTemplate);
  const reloaded = harness('manager', { ...h.state, activeWorkflowId: saved.id });
  reloaded.click('节点参数'); reloaded.change('input', '搜索云端节点字段', '30.cfg');
  assert.equal(reloaded.required('input', '云端字段 30.cfg 默认值').props.value, '9.25');
  assert.equal(reloaded.discoveryCalls.length, 0); reloaded.dispose(); h.dispose();
});

test('手动字段仅加入目录，类型验证失败和坏JSON或普通画布不改请求', () => {
  const original = emptyNodeWorkflow(); const h = harness('manager', fixture([original])); h.click('节点参数');
  h.click('手动添加字段'); assert.equal(h.required('button', '添加字段').props.disabled, true);
  h.change('input', '手动节点 ID', '700'); h.change('input', '手动节点字段名', 'seed'); h.change('select', '手动节点字段类型', 'number'); h.change('input', '手动节点默认值', '9007199254740993');
  h.click('添加字段'); assert.match(h.text(), /精度|有效数字/u); assert.deepEqual(h.state.workflows, [original]);
  h.change('input', '手动节点默认值', '19'); h.click('添加字段');
  assert.equal(draftRequest(h), emptyNodeRequest); h.click('节点参数');
  assert.equal(h.required('input', '云端字段 700.seed 默认值').props.value, '19');
  h.click('将此默认值加入请求'); h.click('保存工作流'); const saved = structuredClone(h.state.workflows[0]);
  assert.deepEqual(library.readRunningHubVideoRequest(saved.requestTemplate).nodeInfoList.map((node) => [node.nodeId, node.fieldName, node.fieldValue]), [['700', 'seed', 19]]);
  for (const malformed of ['{', JSON.stringify({ nodes: [{ id: 12, type: 'CLIPTextEncode', widgets_values: ['cannot-guess-field-name'] }], links: [] })]) {
    h.click('导入节点 JSON'); h.change('textarea', 'RunningHub 节点 JSON', malformed); h.click('加入节点目录');
    assert.ok(h.all().some((node) => node.props.role === 'alert')); h.click('关闭节点编辑');
    assert.equal(draftRequest(h), saved.requestTemplate); assert.deepEqual(h.state.workflows[0], saved); h.click('节点参数');
  }
  h.click('手动添加字段'); h.change('input', '手动节点 ID', '701'); h.change('input', '手动节点字段名', 'enabled'); h.change('select', '手动节点字段类型', 'boolean'); h.change('select', '手动节点默认值', 'true'); h.click('添加字段');
  h.change('select', '云端参数字段范围', 'all');
  h.change('input', '搜索云端节点字段', '701.enabled'); assert.equal(h.required('select', '云端字段 701.enabled 默认值').props.value, 'true');
  h.click('保存工作流'); assert.equal(h.state.workflows[0].requestTemplate, saved.requestTemplate, 'saving a new unbound candidate does not submit its default');
  assert.equal(h.discoveryCalls.length, 0); h.dispose();
});

test('云端ID或类型真正改变时清除旧候选目录，但保留用户请求与显式映射', () => {
  const original = imageSlots.syncRunningHubImageSlots({
    ...emptyNodeWorkflow(),
    requestTemplate: '{"nodeInfoList":[{"nodeId":"12","fieldName":"text","fieldValue":"user-kept-prompt"}],"addMetadata":true}',
    mapping: { prompt: [{ nodeId: '12', inputName: 'text' }], images: [] },
    nodeCatalog: nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph).nodes,
  });
  for (const field of ['remoteId', 'runKind'] as const) {
    const h = harness('manager', fixture([original]));
    h.click('提示词与图片'); h.click('导入节点 JSON'); h.change('textarea', 'RunningHub 节点 JSON', apiNodeGraph); h.click('关闭节点编辑');
    h.click('手动添加字段'); h.change('input', '手动节点 ID', 'staged-old-node'); h.change('input', '手动节点字段名', 'staged-old-field'); h.change('input', '手动节点默认值', 'staged-old-value'); h.click('关闭节点编辑');
    h.click('基本信息');
    h.change('input', 'RunningHub 云端 ID', original.remoteId);
    assert.equal(h.required('button', '保存工作流').props.disabled, true, 're-entering the same identity is not a destructive change');
    h.click('提示词与图片'); h.change('select', '云端映射字段范围', 'all'); assert.ok(fieldOptionValues(h, '云端提示词 1 节点字段').includes(JSON.stringify(['20', 'image'])));
    h.click('导入节点 JSON'); assert.equal(h.required('textarea', 'RunningHub 节点 JSON').props.value, apiNodeGraph); h.click('关闭节点编辑');
    h.click('手动添加字段'); assert.equal(h.required('input', '手动节点 ID').props.value, 'staged-old-node'); h.click('关闭节点编辑');
    h.click('基本信息');
    if (field === 'remoteId') h.change('input', 'RunningHub 云端 ID', '2093983063180054530'); else h.change('select', 'RunningHub 云端调用类型', 'ai-app');
    h.click('提示词与图片'); h.click('导入节点 JSON'); assert.equal(h.required('textarea', 'RunningHub 节点 JSON').props.value, '', 'staged JSON belongs to the former cloud identity'); h.click('关闭节点编辑');
    h.click('手动添加字段'); assert.equal(h.required('input', '手动节点 ID').props.value, ''); assert.equal(h.required('input', '手动节点字段名').props.value, ''); assert.equal(h.required('input', '手动节点默认值').props.value, ''); h.click('关闭节点编辑');
    h.click('保存工作流'); const saved = h.state.workflows[0];
    assert.equal(saved.nodeCatalog?.length || 0, 0); assert.equal(saved.requestTemplate, original.requestTemplate); assert.deepEqual(saved.mapping, original.mapping);
    h.click('提示词与图片'); const options = textOf(h.required('select', '云端提示词 1 节点字段').props.children);
    assert.match(options, /12\.text/u); assert.doesNotMatch(options, /30\.seed/u, 'a different cloud workflow cannot inherit unbound discovered candidates'); h.dispose();
  }
});

await testAsync('云端节点读取显式触发，只合并目录且保留等待期间编辑的请求、映射和默认值', async () => {
  const original = seed('并发编辑'); const pending = deferred<DiscoveryResult>(); const h = harness('manager', fixture([original]), { discover: () => pending.promise });
  h.click('提示词与图片'); assert.equal(h.discoveryCalls.length, 0); h.click('读取云端节点');
  assert.equal(h.discoveryCalls.length, 1); assert.equal(h.discoveryCalls[0].identity.remoteId, original.remoteId); assert.equal(h.discoveryCalls[0].identity.baseUrl, fixture().baseUrl);
  assert.equal(h.required('button', '读取节点中…').props.disabled, true);
  h.click('参考图片槽 1'); assert.equal(h.find('select', '云端图片槽 1 用途'), undefined);
  h.click('节点参数'); h.change('input', '云端字段 160.value 默认值', 'edited-while-reading');
  const editedRequest = draftRequest(h).replace('"default"', '"plus"'); h.change('textarea', 'RunningHub 请求 JSON 编辑稿', editedRequest);
  pending.resolve(nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph)); await settle(); h.render();
  const synchronized = imageSlots.syncRunningHubImageSlots({ ...original, requestTemplate: editedRequest, nodeCatalog: nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph).nodes });
  assert.equal(h.required('textarea', 'RunningHub 请求 JSON 编辑稿').props.value, synchronized.requestTemplate);
  assert.deepEqual(h.state.workflows, [original], 'the read never auto-saves the draft'); h.click('保存工作流');
  const saved = h.state.workflows[0]; assert.equal(saved.requestTemplate, synchronized.requestTemplate); assert.equal(saved.mapping.images[0].role, original.mapping.images[0]?.role);
  assert.equal(library.readRunningHubVideoRequest(saved.requestTemplate).nodeInfoList.find((node) => node.nodeId === '160')?.fieldValue, 'edited-while-reading');
  assert.equal(saved.nodeCatalog?.length, 7); assert.equal(h.state.activeWorkflowId, null); h.dispose();
});

await testAsync('后台读取返回不清空用户搜索或跳回首页，不卸载正在编辑的节点输入', async () => {
  for (const action of ['search', 'page'] as const) {
    const original = seed(); const pending = deferred<DiscoveryResult>(); const h = harness('manager', fixture([original]), { discover: () => pending.promise });
    h.click('节点参数'); h.click('读取云端节点');
    if (action === 'search') {
      h.change('input', '搜索云端节点字段', '160.value'); h.change('input', '云端字段 160.value 默认值', 'partially-edited');
    } else {
      h.click('云端节点参数下一页'); assert.ok(h.find('input', '云端字段 164.audio 默认值'));
    }
    pending.resolve(nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph)); await settle(); h.render();
    if (action === 'search') {
      assert.equal(h.required('input', '搜索云端节点字段').props.value, '160.value');
      assert.equal(h.required('input', '云端字段 160.value 默认值').props.value, 'partially-edited');
      assert.equal(h.find('input', '云端字段 137.image 默认值'), undefined);
    } else {
      assert.ok(h.find('input', '云端字段 164.audio 默认值'), 'the current parameter page survives the background response');
      assert.equal(h.find('input', '云端字段 137.image 默认值'), undefined);
    }
    assert.deepEqual(h.state.workflows, [original]); h.dispose();
  }
});

await testAsync('取消节点读取后晚到成功或失败不污染目录和消息，新读取可以正常完成', async () => {
  for (const completion of ['resolve', 'reject'] as const) {
    const original = emptyNodeWorkflow(); const pending = deferred<DiscoveryResult>(); const h = harness('manager', fixture([original]), { discover: () => pending.promise });
    h.click('提示词与图片'); h.click('读取云端节点'); h.click('取消读取');
    assert.equal(h.discoveryCalls[0].signal.aborted, true);
    if (completion === 'resolve') pending.resolve(nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph)); else pending.reject(new Error('late transport failure'));
    await settle(); h.render(); assert.match(h.text(), /已取消读取节点/u); assert.doesNotMatch(h.text(), /late transport failure/u);
    assert.deepEqual(h.state.workflows, [original]); assert.equal(h.required('button', '保存工作流').props.disabled, true);
    assert.equal(draftRequest(h), emptyNodeRequest); h.dispose();
  }
  const first = deferred<DiscoveryResult>(); const second = deferred<DiscoveryResult>(); let invocation = 0;
  const h = harness('manager', fixture([emptyNodeWorkflow()]), { discover: () => invocation++ === 0 ? first.promise : second.promise });
  h.click('提示词与图片'); h.click('读取云端节点'); h.click('取消读取'); h.click('读取云端节点');
  first.resolve({ nodes: [{ nodeId: '999', fieldName: 'old', fieldValue: 'stale' }], warnings: [] }); await settle(); h.render();
  assert.equal(h.required('button', '读取节点中…').props.disabled, true, 'the stale finally must not finish the newer read');
  second.resolve(nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph)); await settle(); h.render(); h.click('保存工作流');
  assert.equal(h.state.workflows[0].nodeCatalog?.length, 7); assert.ok(!h.state.workflows[0].nodeCatalog?.some((node) => node.nodeId === '999')); h.dispose();
});

await testAsync('切换工作流、云端ID、调用类型或连接后忽略旧节点结果', async () => {
  for (const action of ['workflow', 'remoteId', 'runKind', 'baseUrl', 'apiKey', 'stale-getter'] as const) {
    const original = emptyNodeWorkflow('甲'); const other = emptyNodeWorkflow('乙'); const pending = deferred<DiscoveryResult>();
    const h = harness('manager', fixture([original, other]), { discover: () => pending.promise });
    h.click('提示词与图片'); h.click('读取云端节点');
    if (action === 'workflow') h.click('编辑云端工作流 乙');
    else if (action === 'remoteId') { h.click('基本信息'); h.change('input', 'RunningHub 云端 ID', '2093983063180054530'); }
    else if (action === 'runKind') { h.click('基本信息'); h.change('select', 'RunningHub 云端调用类型', 'ai-app'); }
    else if (action === 'baseUrl') h.external({ ...h.state, baseUrl: 'https://www.runninghub.cn' });
    else h.external({ ...h.state, apiKey: 'new-isolated-key' }, action === 'stale-getter');
    if (action !== 'stale-getter') assert.equal(h.discoveryCalls[0].signal.aborted, true, `${action} cancels transport`);
    pending.resolve(nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph)); await settle(); h.render();
    if (action === 'remoteId' || action === 'runKind') h.click('保存工作流');
    assert.ok(h.state.workflows.every((workflow) => !workflow.nodeCatalog?.length), `${action} does not inherit the old workflow catalog`);
    assert.equal(draftRequest(h), emptyNodeRequest); assert.doesNotMatch(h.text(), /已读取 7 个/u); h.dispose();
  }
});

await testAsync('关闭或卸载管理器后晚到读取不写配置，失败只显示错误不替换旧结果', async () => {
  for (const mode of ['close', 'dispose'] as const) {
    const original = emptyNodeWorkflow(); const pending = deferred<DiscoveryResult>(); const h = harness('manager', fixture([original]), { discover: () => pending.promise });
    h.click('提示词与图片'); h.click('读取云端节点');
    if (mode === 'close') { h.click('完成'); assert.equal(h.closed, 1); } else h.dispose();
    assert.equal(h.discoveryCalls[0].signal.aborted, true); pending.resolve(nodeLibrary.parseRunningHubVideoNodes(apiNodeGraph)); await settle();
    assert.deepEqual(h.state.workflows, [original]); assert.equal(h.patches.length, 0); assert.equal(h.updatesAfterDispose, 0);
    if (mode === 'close') { h.render(); assert.equal(h.required('button', '保存工作流').props.disabled, true); h.dispose(); }
  }
  const original = emptyNodeWorkflow(); const pending = deferred<DiscoveryResult>(); const h = harness('manager', fixture([original]), { discover: () => pending.promise });
  h.click('提示词与图片'); h.click('读取云端节点'); pending.reject(new Error('节点读取权限不足，请检查当前工作流访问权限')); await settle(); h.render();
  assert.match(h.text(), /节点读取权限不足/u); assert.deepEqual(h.state.workflows, [original]); assert.equal(h.required('button', '读取云端节点').props.disabled, false);
  h.dispose();
});

await testAsync('节点文件异步读取在关闭导入或切换工作流后不串写', async () => {
  for (const mode of ['close-node-dialog', 'workflow', 'dispose'] as const) {
    const original = emptyNodeWorkflow('甲'); const other = emptyNodeWorkflow('乙'); const pending = deferred<string>();
    const h = harness('manager', fixture([original, other])); h.click('节点参数'); h.click('导入节点 JSON');
    h.file('nodes.json', () => pending.promise, 100, '导入 RunningHub 节点文件');
    if (mode === 'close-node-dialog') h.click('关闭节点编辑'); else if (mode === 'workflow') h.click('编辑云端工作流 乙'); else h.dispose();
    pending.resolve(apiNodeGraph); await settle(); assert.deepEqual(h.state.workflows, [original, other]); assert.equal(h.updatesAfterDispose, 0);
    if (mode !== 'dispose') { h.render(); assert.equal(h.required('button', '保存工作流').props.disabled, true); assert.equal(draftRequest(h), emptyNodeRequest); h.dispose(); }
  }
});

{
  const h = harness('manager'); h.click('导入 cURL / JSON');
  let resolve!: (value: string) => void; const promise = new Promise<string>((done) => { resolve = done; });
  h.file('deferred.curl', () => promise); h.dispose(); resolve(importCurl); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.state.workflows.length, 0); groups += 1; console.log('PASS 卸载后晚到文件读取不修改配置');
}

const outputFields = {
  duration: { nodeId: '40', inputName: 'duration', label: 'RunningHub 视频时长', value: 6 },
  resolution: { nodeId: '41', inputName: 'resolution', label: 'RunningHub 分辨率', value: '720P' },
  width: { nodeId: '42', inputName: 'width', label: 'RunningHub 像素宽度', value: '1280' },
  height: { nodeId: '42', inputName: 'height', label: 'RunningHub 像素高度', value: 720 },
} as const;
type OutputKey = keyof typeof outputFields;
const outputKeys = Object.keys(outputFields) as OutputKey[];
const outputWorkflow = (name = '时长分辨率工作流'): RunningHubVideoWorkflow => {
  const requestTemplate = JSON.stringify({
    addMetadata: true,
    nodeInfoList: [
      { nodeId: '10', fieldName: 'text', fieldValue: '原视频全文\n对白保持原句', description: '原提示词字段附加信息' },
      { nodeId: '20', fieldName: 'image', fieldValue: 'original-reference.png' },
      { nodeId: '60', fieldName: 'audio', fieldValue: 'keep-audio.wav' },
      { nodeId: '61', fieldName: 'seed', fieldValue: '9223372036854775807' },
      { nodeId: '62', fieldName: 'strength', fieldValue: 0.6000000000000001 },
      { nodeId: '63', fieldName: 'enabled', fieldValue: false },
    ],
    instanceType: 'plus', usePersonalQueue: false, webhookUrl: 'https://callback.example.invalid/result',
    customFlag: { untouched: ['image', 0], text: 'Keep {{prompt}} here literally' },
  }, null, 2);
  return {
    ...emptyNodeWorkflow(name), requestTemplate,
    mapping: { prompt: [{ nodeId: '10', inputName: 'text' }], images: [{ nodeId: '20', inputName: 'image', role: 'first-frame' }] },
    nodeCatalog: [
      ...outputKeys.map((key) => ({ nodeId: outputFields[key].nodeId, fieldName: outputFields[key].inputName, fieldValue: outputFields[key].value })),
      { nodeId: '90', fieldName: 'custom_output', fieldValue: 'custom-value', description: '作者自定义内部值' },
      { nodeId: '91', fieldName: 'duration', fieldValue: false, description: '开关不是秒数' },
    ],
  };
};
const outputSection = (h: ReturnType<typeof harness>, key: OutputKey) => {
  h.click('时长与分辨率'); h.click(key === 'width' || key === 'height' ? '高级：指定宽高' : '时长与像素 / 分辨率');
};
const bindOutput = (h: ReturnType<typeof harness>, key: OutputKey) => {
  outputSection(h, key); const field = outputFields[key];
  h.change('select', `${field.label}节点字段`, fieldKey(field.nodeId, field.inputName));
};
const outputValue = (template: string, key: OutputKey) => {
  const field = outputFields[key];
  return library.readRunningHubVideoRequest(template).nodeInfoList.find((node) => node.nodeId === field.nodeId && node.fieldName === field.inputName)?.fieldValue;
};
const readyOutputWorkflow = (name?: string): RunningHubVideoWorkflow => {
  const workflow = outputWorkflow(name);
  workflow.mapping.parameters = Object.fromEntries(outputKeys.map((key) => [key, { nodeId: outputFields[key].nodeId, inputName: outputFields[key].inputName }]));
  for (const key of outputKeys) {
    const field = outputFields[key];
    workflow.requestTemplate = library.ensureRunningHubVideoRequestNode(workflow.requestTemplate, { nodeId: field.nodeId, fieldName: field.inputName, fieldValue: field.value });
  }
  return workflow;
};

test('时长分辨率只查看筛选不绑定，四字段分为两屏且留空不创建覆盖项', () => {
  const original = outputWorkflow(); const h = harness('manager', fixture([original]));
  outputSection(h, 'duration');
  assert.deepEqual(optionValues(h, '时长分辨率字段范围'), ['common', 'all']);
  assert.equal(h.required('select', '时长分辨率字段范围').props.value, 'common');
  assert.equal(h.required('select', 'RunningHub 视频时长节点字段').props.value, fieldKey('', ''));
  assert.equal(h.required('select', 'RunningHub 分辨率节点字段').props.value, fieldKey('', ''));
  assert.equal(h.find('select', 'RunningHub 像素宽度节点字段'), undefined, 'only two parameter cards occupy the active screen');
  assert.ok(fieldOptionValues(h, 'RunningHub 视频时长节点字段').includes(fieldKey('40', 'duration')));
  h.change('select', '时长分辨率字段范围', 'all'); h.change('input', '搜索时长分辨率字段', '90.custom_output');
  assert.ok(fieldOptionValues(h, 'RunningHub 视频时长节点字段').includes(fieldKey('90', 'custom_output')));
  assert.equal(draftRequest(h), original.requestTemplate);
  outputSection(h, 'width');
  assert.equal(h.required('select', 'RunningHub 像素宽度节点字段').props.value, fieldKey('', ''));
  assert.equal(h.required('select', 'RunningHub 像素高度节点字段').props.value, fieldKey('', ''));
  assert.equal(h.find('select', 'RunningHub 视频时长节点字段'), undefined);
  assert.equal(h.required('button', '保存工作流').props.disabled, true);
  assert.deepEqual(h.state.workflows, [original]); assert.equal(h.ensuredFields.length, 0); assert.equal(h.discoveryCalls.length, 0); assert.equal(h.patches.length, 0);
  h.dispose();
});

test('四项参数明确绑定和默认值编辑可保存复制导出重载，保留数值类型与分辨率大小写', () => {
  const original = outputWorkflow(); const before = library.readRunningHubVideoRequest(original.requestTemplate);
  const h = harness('manager', fixture([original]));
  bindOutput(h, 'duration');
  assert.deepEqual(library.readRunningHubVideoRequest(draftRequest(h)).nodeInfoList.map((node) => fieldKey(node.nodeId, node.fieldName)), [...before.nodeInfoList.map((node) => fieldKey(node.nodeId, node.fieldName)), fieldKey('40', 'duration')]);
  bindOutput(h, 'resolution'); bindOutput(h, 'width'); bindOutput(h, 'height');
  const edits: Record<OutputKey, string> = { duration: '10.5', resolution: '1080P', width: '1920', height: '1080' };
  for (const key of outputKeys) { outputSection(h, key); h.change('input', `${outputFields[key].label}默认值`, edits[key]); }
  h.click('保存工作流'); const saved = structuredClone(h.state.workflows[0]);
  assert.deepEqual(saved.mapping.parameters, Object.fromEntries(outputKeys.map((key) => [key, { nodeId: outputFields[key].nodeId, inputName: outputFields[key].inputName }])));
  assert.equal(outputValue(saved.requestTemplate, 'duration'), 10.5);
  assert.equal(outputValue(saved.requestTemplate, 'resolution'), '1080P');
  assert.equal(outputValue(saved.requestTemplate, 'width'), '1920');
  assert.equal(outputValue(saved.requestTemplate, 'height'), 1080);
  const savedRequest = library.readRunningHubVideoRequest(saved.requestTemplate);
  assert.deepEqual(savedRequest.nodeInfoList.slice(0, before.nodeInfoList.length), before.nodeInfoList, 'prompt, image, audio, seed, floating point constant and boolean stay untouched');
  assert.deepEqual({ ...savedRequest, nodeInfoList: [] }, { ...before, nodeInfoList: [] }, 'outer run options remain unchanged');
  assert.equal(h.state.activeWorkflowId, null); assert.equal(h.state.enabled, false);
  h.click('复制'); h.change('input', 'RunningHub 工作流名称', '独立时长副本');
  outputSection(h, 'duration'); h.change('input', 'RunningHub 视频时长默认值', '12'); h.click('保存工作流');
  assert.equal(h.state.workflows.length, 2); assert.deepEqual(h.state.workflows[0], saved);
  assert.equal(outputValue(h.state.workflows[1].requestTemplate, 'duration'), 12);
  const backup = library.exportRunningHubVideoWorkflow(saved); assert.doesNotMatch(backup, /isolated-connection-key/u);
  h.click('导入 cURL / JSON'); h.change('textarea', 'RunningHub 导入文本', backup); h.click('导入为新工作流');
  const restored = h.state.workflows[2]; assert.ok(restored); assert.notEqual(restored.id, saved.id);
  assert.deepEqual(restored.mapping, saved.mapping); assert.equal(restored.requestTemplate, saved.requestTemplate);
  const reloaded = harness('manager', { ...h.state, activeWorkflowId: saved.id });
  for (const key of outputKeys) {
    outputSection(reloaded, key); const field = outputFields[key];
    assert.equal(reloaded.required('select', `${field.label}节点字段`).props.value, fieldKey(field.nodeId, field.inputName));
    assert.equal(reloaded.required('input', `${field.label}默认值`).props.value, edits[key]);
  }
  assert.equal(reloaded.discoveryCalls.length, 0); reloaded.dispose(); h.dispose();
});

test('四项任务覆盖仅改显式字段，修改工作流默认值不污染已编译任务快照', () => {
  const original = readyOutputWorkflow(); const config = fixture([original]); config.activeWorkflowId = original.id;
  const params = { duration: 8.5, resolution: '4K', width: 3840, height: '2160' };
  const api = library.compileRunningHubVideoApi(config, original.id, params); const frozen = structuredClone(api);
  const expected = library.readRunningHubVideoRequest(original.requestTemplate);
  for (const key of outputKeys) {
    const field = outputFields[key]; const row = expected.nodeInfoList.find((node) => node.nodeId === field.nodeId && node.fieldName === field.inputName)!;
    row.fieldValue = typeof field.value === 'number' ? Number(params[key]) : String(params[key]);
  }
  const request = library.bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: '原视频全文\n对白保持原句', parameters: params }, ['original-reference.png']);
  assert.deepEqual(request, expected);
  assert.deepEqual(config.workflows[0], original); assert.deepEqual(api, frozen);
  const h = harness('manager', config); outputSection(h, 'duration'); h.change('input', 'RunningHub 视频时长默认值', '20'); h.click('保存工作流');
  assert.equal(outputValue(h.state.workflows[0].requestTemplate, 'duration'), 20);
  const oldDefaults = library.bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: '原视频全文\n对白保持原句', parameters: {} }, ['original-reference.png']);
  assert.deepEqual(oldDefaults, library.readRunningHubVideoRequest(original.requestTemplate), 'omitted overrides use the task snapshot original defaults, not newer editor defaults or previous task overrides');
  assert.deepEqual(api, frozen); h.dispose();
});

test('清空时长分辨率映射只解除用途，不删除原请求默认值或其它映射', () => {
  const original = readyOutputWorkflow(); const h = harness('manager', fixture([original]));
  outputSection(h, 'duration'); h.change('select', 'RunningHub 视频时长节点字段', fieldKey('', ''));
  h.click('保存工作流'); const saved = h.state.workflows[0];
  assert.equal(saved.mapping.parameters?.duration, undefined); assert.deepEqual(saved.mapping.parameters?.resolution, original.mapping.parameters?.resolution);
  assert.equal(saved.requestTemplate, original.requestTemplate); assert.deepEqual(saved.mapping.prompt, original.mapping.prompt); assert.deepEqual(saved.mapping.images, original.mapping.images);
  for (const key of ['resolution', 'width', 'height'] as const) { outputSection(h, key); h.change('select', `${outputFields[key].label}节点字段`, fieldKey('', '')); }
  h.click('保存工作流'); assert.equal(Object.keys(h.state.workflows[0].mapping.parameters || {}).length, 0);
  assert.equal(h.state.workflows[0].requestTemplate, original.requestTemplate); h.dispose();
});

test('时长分辨率旧绑定在搜索下保留，旧参数别名不会被自动改名或抢占', () => {
  const original = outputWorkflow();
  original.mapping.parameters = { duration: { nodeId: '90', inputName: 'custom_output' }, clip_length: { nodeId: '40', inputName: 'duration' } };
  for (const node of original.nodeCatalog!.filter((row) => ['40', '90'].includes(row.nodeId))) original.requestTemplate = library.ensureRunningHubVideoRequestNode(original.requestTemplate, { ...node });
  const h = harness('manager', fixture([original])); outputSection(h, 'duration');
  h.change('input', '搜索时长分辨率字段', 'no-matching-candidate');
  assert.equal(h.required('select', 'RunningHub 视频时长节点字段').props.value, fieldKey('90', 'custom_output'));
  assert.ok(fieldOptionValues(h, 'RunningHub 视频时长节点字段').includes(fieldKey('90', 'custom_output')));
  h.change('input', '搜索时长分辨率字段', ''); h.change('select', '时长分辨率字段范围', 'all');
  const occupied = nodesOf(h.required('select', 'RunningHub 视频时长节点字段').props.children).find((node) => node.type === 'option' && node.props.value === fieldKey('40', 'duration'));
  assert.ok(occupied); assert.equal(occupied.props.disabled, true);
  h.change('select', 'RunningHub 视频时长节点字段', fieldKey('40', 'duration'));
  assert.ok(h.all().some((node) => node.props.role === 'alert'));
  assert.equal(h.required('select', 'RunningHub 视频时长节点字段').props.value, fieldKey('90', 'custom_output'));
  assert.equal(draftRequest(h), original.requestTemplate); assert.deepEqual(h.state.workflows[0].mapping.parameters, original.mapping.parameters);
  assert.equal(h.required('button', '保存工作流').props.disabled, true); h.dispose();
});

test('时长分辨率拒绝复用提示词、图片或其他参数，绕过禁用选项调用回调也不写入', () => {
  for (const conflict of [{ nodeId: '10', inputName: 'text' }, { nodeId: '20', inputName: 'image' }, { nodeId: '61', inputName: 'seed' }]) {
    const original = outputWorkflow(); original.mapping.parameters = { random_seed: { nodeId: '61', inputName: 'seed' } };
    const h = harness('manager', fixture([original])); outputSection(h, 'duration'); h.change('select', '时长分辨率字段范围', 'all');
    const value = fieldKey(conflict.nodeId, conflict.inputName);
    const occupied = nodesOf(h.required('select', 'RunningHub 视频时长节点字段').props.children).find((node) => node.type === 'option' && node.props.value === value);
    assert.ok(occupied, `advanced options include ${value}`); assert.equal(occupied.props.disabled, true, 'occupied choices are visible but cannot be selected');
    h.change('select', 'RunningHub 视频时长节点字段', value);
    assert.ok(h.all().some((node) => node.props.role === 'alert'));
    assert.equal(draftRequest(h), original.requestTemplate); assert.deepEqual(h.state.workflows, [original]);
    assert.equal(h.required('button', '保存工作流').props.disabled, true); assert.equal(h.ensuredFields.length, 0); h.dispose();
  }
});

test('时长分辨率遇到坏JSON、损坏行或旧映射字段缺失不白屏，不伪造默认值', () => {
  for (const requestTemplate of ['{', '{"nodeInfoList":[null,17,{}]}', '{"nodeInfoList":[]}']) {
    const original = outputWorkflow(); original.requestTemplate = requestTemplate; original.nodeCatalog = [];
    original.mapping.parameters = { duration: { nodeId: 'missing', inputName: 'duration' } };
    const h = harness('manager', fixture([original])); outputSection(h, 'duration');
    assert.equal(h.required('select', 'RunningHub 视频时长节点字段').props.value, fieldKey('missing', 'duration'));
    assert.match(textOf(h.required('select', 'RunningHub 视频时长节点字段').props.children), /不存在|缺失/u);
    assert.equal(h.required('button', '设为当前').props.disabled, true);
    outputSection(h, 'width'); assert.ok(h.required('select', 'RunningHub 像素宽度节点字段'));
    assert.equal(draftRequest(h), requestTemplate); assert.deepEqual(h.state.workflows, [original]); assert.equal(h.ensuredFields.length, 0); h.dispose();
  }
});

test('切换工作流清空时长分辨率筛选，显示各自绑定而不串写或创建脏编辑', () => {
  const first = outputWorkflow('输出甲'); const second = readyOutputWorkflow('输出乙');
  second.requestTemplate = library.updateRunningHubVideoNodeValue(second.requestTemplate, { nodeId: '40', inputName: 'duration' }, '25');
  const h = harness('manager', fixture([first, second])); outputSection(h, 'duration');
  h.change('select', '时长分辨率字段范围', 'all'); h.change('input', '搜索时长分辨率字段', '90.custom_output');
  h.click('编辑云端工作流 输出乙'); assert.equal(h.find('button', '放弃编辑并继续'), undefined);
  outputSection(h, 'duration');
  assert.equal(h.required('select', '时长分辨率字段范围').props.value, 'common');
  assert.equal(h.required('input', '搜索时长分辨率字段').props.value, '');
  assert.equal(h.required('select', 'RunningHub 视频时长节点字段').props.value, fieldKey('40', 'duration'));
  assert.equal(h.required('input', 'RunningHub 视频时长默认值').props.value, '25');
  h.click('编辑云端工作流 输出甲'); outputSection(h, 'duration');
  assert.equal(h.required('select', 'RunningHub 视频时长节点字段').props.value, fieldKey('', ''));
  assert.equal(h.required('button', '保存工作流').props.disabled, true);
  assert.deepEqual(h.state.workflows, [first, second]); assert.equal(h.ensuredFields.length, 0); assert.equal(h.patches.length, 0); h.dispose();
});

await testAsync('读取和导入输出参数目录仅补候选，不自动填时长分辨率或保存生成请求', async () => {
  const original = outputWorkflow(); const catalog = structuredClone(original.nodeCatalog!); original.nodeCatalog = [];
  const pending = deferred<DiscoveryResult>(); const h = harness('manager', fixture([original]), { discover: () => pending.promise });
  h.click('节点参数'); h.click('读取云端节点'); outputSection(h, 'duration');
  pending.resolve({ nodes: catalog, warnings: [] }); await settle(); h.render();
  assert.equal(h.required('select', 'RunningHub 视频时长节点字段').props.value, fieldKey('', ''));
  assert.equal(h.required('select', 'RunningHub 分辨率节点字段').props.value, fieldKey('', ''));
  assert.deepEqual(h.state.workflows, [original]); assert.equal(draftRequest(h), original.requestTemplate); assert.equal(h.ensuredFields.length, 0);
  h.click('保存工作流'); assert.equal(h.state.workflows[0].nodeCatalog?.length, catalog.length);
  assert.equal(h.state.workflows[0].mapping.parameters, undefined); assert.equal(h.state.workflows[0].requestTemplate, original.requestTemplate);
  h.dispose();
  const imported = harness('manager', fixture([original])); imported.click('节点参数'); importNodes(imported, JSON.stringify(catalog));
  outputSection(imported, 'width');
  assert.equal(imported.required('select', 'RunningHub 像素宽度节点字段').props.value, fieldKey('', ''));
  assert.equal(imported.required('select', 'RunningHub 像素高度节点字段').props.value, fieldKey('', ''));
  assert.equal(draftRequest(imported), original.requestTemplate); assert.equal(imported.ensuredFields.length, 0); assert.equal(imported.discoveryCalls.length, 0); imported.dispose();
});

test('六个真实图片槽全量只读列出，保留原顺序与兼容元数据，新槽保存后才生效', () => {
  const original = seed('六图片槽');
  const request = library.readRunningHubVideoRequest(original.requestTemplate);
  request.nodeInfoList = [request.nodeInfoList.find((node) => node.nodeId === '138')!,
    ...Array.from({ length: 6 }, (_, index) => ({ nodeId: String(20 + index), fieldName: 'image', fieldValue: `original-${index}.png` }))];
  original.requestTemplate = JSON.stringify(request);
  original.mapping.images = [{ nodeId: '21', inputName: 'image', role: 'first-frame' }, { nodeId: '20', inputName: 'image', role: 'character' }];
  const before = structuredClone(original);
  const h = harness('manager', fixture([original])); h.click('提示词与图片'); h.click('参考图片槽 6');
  assert.deepEqual(Array.from({ length: 6 }, (_, index) => textOf(h.required('code', `云端图片槽 ${index + 1} 节点字段`))), ['21.image', '20.image', '22.image', '23.image', '24.image', '25.image']);
  for (let index = 1; index <= 6; index += 1) assert.equal(h.find('select', `云端图片槽 ${index} 用途`), undefined, 'API settings no longer edits per-segment purpose');
  assert.equal(h.find('button', '添加云端图片槽'), undefined); assert.equal(h.find('button', '云端输入映射下一页'), undefined);
  assert.deepEqual(h.state.workflows, [before]); assert.deepEqual(original, before, 'draft synchronization never mutates its input');
  h.click('保存工作流');
  const saved = h.state.workflows[0]; assert.equal(saved.mapping.images.length, 6); assert.equal(saved.mapping.images[5].role, 'general');
  assert.equal(saved.requestTemplate, original.requestTemplate, 'existing request constants stay unchanged until actual submission');
  h.dispose();
  const reopened = harness('manager', fixture([saved])); reopened.click('提示词与图片'); reopened.click('参考图片槽 6');
  assert.equal(reopened.find('select', '云端图片槽 6 用途'), undefined); assert.equal(reopened.required('button', '保存工作流').props.disabled, true);
  reopened.click('完成'); assert.equal(reopened.closed, 1); reopened.dispose();
});

test('图片自动同步不抢占提示词或参数字段，空白占位退役但已有自定义映射保留', () => {
  const original = seed('不抢占');
  const request = library.readRunningHubVideoRequest(original.requestTemplate);
  request.nodeInfoList.push({ nodeId: '30', fieldName: 'image', fieldValue: '' }, { nodeId: '31', fieldName: 'image', fieldValue: '' }, { nodeId: 'custom', fieldName: 'special_input', fieldValue: '' });
  original.requestTemplate = JSON.stringify(request);
  original.mapping.images = [{ nodeId: '', inputName: '' }, { nodeId: 'custom', inputName: 'special_input', role: 'subject' }];
  original.mapping.prompt.push({ nodeId: '30', inputName: 'image' }); original.mapping.parameters = { special: { nodeId: '31', inputName: 'image' } };
  const h = harness('manager', fixture([original])); h.click('提示词与图片'); h.click('参考图片槽 2');
  assert.equal(textOf(h.required('code', '云端图片槽 1 节点字段')), 'custom.special_input');
  assert.equal(h.find('select', '云端图片槽 1 用途'), undefined, 'legacy roles remain stored but are not edited here');
  assert.equal(textOf(h.required('code', '云端图片槽 2 节点字段')), '137.image');
  h.click('保存工作流');
  assert.deepEqual(h.state.workflows[0].mapping.prompt, original.mapping.prompt); assert.deepEqual(h.state.workflows[0].mapping.parameters, original.mapping.parameters);
  assert.equal(h.state.workflows[0].mapping.images.some((binding) => ['30', '31'].includes(binding.nodeId)), false); h.dispose();
});

test('重复真实图片字段和损坏节点列表保持可检查，不白屏或半途改写草稿', () => {
  const seedWorkflow = seed('坏稿'); const request = library.readRunningHubVideoRequest(seedWorkflow.requestTemplate);
  const image = request.nodeInfoList.find((node) => node.fieldName === 'image')!;
  for (const requestTemplate of [JSON.stringify({ ...request, nodeInfoList: [...request.nodeInfoList, { ...image }] }),
    '{"nodeInfoList":[null,{"nodeId":"137","fieldName":"image"}]}', '{"nodeInfoList":[{"nodeId":"137","fieldName":"image","fieldValue":"old"}],"nodeInfoList":[]}']) {
    const original = { ...seedWorkflow, requestTemplate, mapping: { ...seedWorkflow.mapping, images: [{ nodeId: '137', inputName: 'image', role: 'first-frame' as const }] } };
    const before = structuredClone(original); const h = harness('manager', fixture([original]));
    h.click('请求 JSON'); assert.equal(h.required('textarea', 'RunningHub 请求 JSON 编辑稿').props.value, requestTemplate);
    h.click('提示词与图片'); h.click('参考图片槽 1'); assert.equal(h.find('select', '云端图片槽 1 用途'), undefined);
    assert.deepEqual(h.state.workflows, [before]); assert.deepEqual(original, before); h.dispose();
  }
});

test('失效旧图片映射有明确移除入口，高级自定义图片字段可主动补充', () => {
  const original = seed('旧图槽'); original.mapping.images.unshift({ nodeId: 'missing', inputName: 'lost_image', role: 'character' });
  const h = harness('manager', fixture([original])); h.click('提示词与图片'); h.click('参考图片槽 2');
  h.click('移除失效云端图片槽 1'); assert.equal(textOf(h.required('code', '云端图片槽 1 节点字段')), '137.image');
  assert.deepEqual(h.state.workflows, [original]);
  h.click('手动添加字段'); h.change('input', '手动节点 ID', '88'); h.change('input', '手动节点字段名', 'special_identity_input');
  h.change('select', '手动节点字段类型', 'image'); h.change('input', '手动节点默认值', ''); h.click('添加字段');
  assert.equal(textOf(h.required('code', '云端图片槽 2 节点字段')), '88.special_identity_input');
  assert.equal(h.find('select', '云端图片槽 2 用途'), undefined); h.click('保存工作流');
  assert.deepEqual(h.state.workflows[0].mapping.images, [{ nodeId: '137', inputName: 'image', role: 'general' }, { nodeId: '88', inputName: 'special_identity_input', role: 'general' }]);
  h.dispose();
});

const megapixelKey = fieldKey('252', 'megapixels');
const megapixelLabels = { '0.2': '608 × 352', '0.3': '736 × 416', '0.4': '864 × 480', '0.5': '960 × 544', '0.6': '1056 × 608', '0.7': '1152 × 640', '0.8': '1216 × 672', '0.9': '1280 × 736', '1.0': '1376 × 768' };
const megapixelWorkflow = (name = 'MP 工作流', value = '0.5'): RunningHubVideoWorkflow => ({
  ...outputWorkflow(name),
  nodeCatalog: [{ nodeId: '252', fieldName: 'megapixels', fieldValue: value, description: '输出像素总量',
    control: { kind: 'number', unit: 'MP', min: 0.1, max: 2, step: 0.01 } },
  { nodeId: '252', fieldName: 'aspect_ratio', fieldValue: '16:9 (Widescreen)' }],
});
const megapixelValue = (workflow: RunningHubVideoWorkflow) => library.readRunningHubVideoRequest(workflow.requestTemplate)
  .nodeInfoList.find((node) => node.nodeId === '252' && node.fieldName === 'megapixels')?.fieldValue;

test('MP 候选明确绑定后使用云端数值控件，查看与绑定不自动安装范围预设或改变 0.5', () => {
  const original = megapixelWorkflow(); const h = harness('manager', fixture([original]));
  outputSection(h, 'resolution');
  assert.ok(fieldOptionValues(h, 'RunningHub 分辨率节点字段').includes(megapixelKey));
  assert.equal(h.state.workflows[0].fieldControls, undefined);
  h.change('select', 'RunningHub 分辨率节点字段', megapixelKey);
  const input = h.required('input', 'RunningHub 分辨率默认值');
  assert.equal(input.props.type, 'number'); assert.equal(input.props.value, '0.5');
  assert.equal(input.props.min, 0.1); assert.equal(input.props.max, 2); assert.equal(input.props.step, 0.01);
  assert.match(h.text(), /像素（MP）/u);
  h.click('保存工作流');
  assert.equal(megapixelValue(h.state.workflows[0]), '0.5');
  assert.equal(h.state.workflows[0].fieldControls, undefined, 'binding adopts cloud metadata without installing a preset');
  assert.deepEqual(library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate).nodeInfoList.filter((node) => node.nodeId !== '252'),
    library.readRunningHubVideoRequest(original.requestTemplate).nodeInfoList);
  assert.equal(h.discoveryCalls.length, 0); h.dispose();
});

test('0.2–1.0 MP 预设按 0.1 递增并只保存当前工作流的选项，默认值仍为 0.5', () => {
  const original = megapixelWorkflow(); const other = megapixelWorkflow('另一个 MP 工作流');
  const h = harness('manager', fixture([original, other])); outputSection(h, 'resolution');
  h.change('select', 'RunningHub 分辨率节点字段', megapixelKey); h.click('保存工作流');
  const boundTemplate = h.state.workflows[0].requestTemplate;
  outputSection(h, 'resolution'); h.click('使用 0.2–1.0 MP 选项');
  const expected = ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'];
  assert.deepEqual(optionValues(h, 'RunningHub 分辨率默认值'), expected);
  assert.equal(h.required('select', 'RunningHub 分辨率默认值').props.value, '0.5');
  assert.equal(h.find('input', 'RunningHub 分辨率自定义默认值'), undefined);
  assert.equal(h.required('select', 'RunningHub 分辨率输入方式').props.disabled, true);
  assert.equal(h.required('textarea', 'RunningHub 分辨率可选值').props.readOnly, true);
  assert.equal(h.required('input', 'RunningHub 分辨率步长').props.readOnly, true);
  h.change('textarea', 'RunningHub 分辨率可选值', '0.2, 0.98, 1.0');
  h.change('input', 'RunningHub 分辨率步长', '0.01');
  h.required('select', 'RunningHub 分辨率输入方式').props.onChange({ target: { value: 'number' } }); h.render();
  assert.deepEqual(optionValues(h, 'RunningHub 分辨率默认值'), expected, 'the fixed preset ignores forged edits to its steps, choices, and control kind');
  assert.equal(h.required('input', 'RunningHub 分辨率步长').props.value, '0.1');
  assert.equal(h.state.workflows[0].fieldControls, undefined, 'choosing a preset remains an unsaved edit');
  h.click('保存工作流');
  assert.deepEqual(h.state.workflows[0].fieldControls?.[megapixelKey], { kind: 'select', unit: 'MP', options: expected, min: 0.2, max: 1, step: 0.1,
    optionLabels: megapixelLabels, optionLabelAspectRatio: '16:9' });
  assert.equal(h.state.workflows[0].requestTemplate, boundTemplate);
  assert.deepEqual(h.state.workflows[1], other);
  outputSection(h, 'resolution'); h.change('select', 'RunningHub 分辨率默认值', '0.6'); h.click('保存工作流');
  assert.equal(megapixelValue(h.state.workflows[0]), '0.6');
  assert.deepEqual(library.readRunningHubVideoRequest(h.state.workflows[0].requestTemplate).nodeInfoList.filter((node) => node.nodeId !== '252'),
    library.readRunningHubVideoRequest(original.requestTemplate).nodeInfoList);
  assert.equal(h.discoveryCalls.length, 0); h.dispose();
});

test('已有 0.98 在 MP 固定档位中只展示且不改写，不能通过选项回调新填任意小数', () => {
  const original = megapixelWorkflow('旧自定义值', '0.98'); const h = harness('manager', fixture([original]));
  outputSection(h, 'resolution'); h.change('select', 'RunningHub 分辨率节点字段', megapixelKey);
  h.click('使用 0.2–1.0 MP 选项');
  const select = h.required('select', 'RunningHub 分辨率默认值');
  assert.equal(select.props.value, '0.98');
  assert.ok(nodesOf(select.props.children).find((node) => node.type === 'option' && node.props.value === '0.98')?.props.disabled);
  assert.ok(!optionValues(h, 'RunningHub 分辨率默认值').includes('__custom__'));
  h.click('保存工作流'); assert.equal(megapixelValue(h.state.workflows[0]), '0.98', 'installing UI options never rewrites an existing node value');
  outputSection(h, 'resolution'); h.change('select', 'RunningHub 分辨率默认值', '0.37');
  assert.equal(h.required('select', 'RunningHub 分辨率默认值').props.value, '0.98');
  assert.equal(h.required('button', '保存工作流').props.disabled, true);
  h.change('select', 'RunningHub 分辨率默认值', '1.0'); h.click('保存工作流');
  assert.equal(megapixelValue(h.state.workflows[0]), '1.0');
  h.dispose();
});

test('工作流选项可编辑保存并独立复制，恢复云端定义只恢复控件不恢复或修改节点值', () => {
  const original = megapixelWorkflow(); const h = harness('manager', fixture([original]));
  outputSection(h, 'resolution'); h.change('select', 'RunningHub 分辨率节点字段', megapixelKey);
  h.change('select', 'RunningHub 分辨率输入方式', 'select');
  assert.equal(h.required('textarea', 'RunningHub 分辨率可选值').props.readOnly, false, 'other workflow controls remain editable');
  h.change('textarea', 'RunningHub 分辨率可选值', '0.2, 0.4, 0.6, 1.0');
  h.change('input', 'RunningHub 分辨率最小值', '0.2');
  h.change('input', 'RunningHub 分辨率最大值', '1.0');
  h.change('input', 'RunningHub 分辨率步长', '0.1');
  h.click('保存工作流'); const configured = structuredClone(h.state.workflows[0]);
  assert.deepEqual(configured.fieldControls?.[megapixelKey]?.options, ['0.2', '0.4', '0.6', '1.0']);
  assert.equal(megapixelValue(configured), '0.5', 'removing an option never changes the existing node default');
  h.click('复制'); h.change('input', 'RunningHub 工作流名称', 'MP 控件副本'); h.click('保存工作流');
  assert.deepEqual(h.state.workflows[1].fieldControls, configured.fieldControls);
  outputSection(h, 'resolution'); h.click('恢复云端定义');
  const restored = h.required('input', 'RunningHub 分辨率默认值');
  assert.equal(restored.props.type, 'number'); assert.equal(restored.props.min, 0.1); assert.equal(restored.props.max, 2); assert.equal(restored.props.step, 0.01);
  assert.equal(restored.props.value, '0.5'); h.click('保存工作流');
  assert.deepEqual(Object.keys(h.state.workflows[1].fieldControls || {}), []);
  assert.equal(megapixelValue(h.state.workflows[1]), '0.5');
  assert.deepEqual(h.state.workflows[0], configured, 'restoring a copied control never changes its original workflow');
  h.click('编辑云端工作流 MP 工作流'); outputSection(h, 'resolution');
  assert.equal(h.required('select', 'RunningHub 分辨率默认值').props.value, '0.5');
  assert.equal(h.required('button', '保存工作流').props.disabled, true);
  assert.equal(h.discoveryCalls.length, 0); h.dispose();
});

test('普通分辨率云端枚举仍使用档位原值，未设置范围的 MP 输入不被全局硬限', () => {
  const original = outputWorkflow('普通档位');
  original.nodeCatalog = original.nodeCatalog!.map((node) => node.fieldName === 'resolution'
    ? { ...node, control: { kind: 'select' as const, options: ['720P', '1080P', '2K'] } } : node);
  const h = harness('manager', fixture([original])); bindOutput(h, 'resolution');
  assert.ok(optionValues(h, 'RunningHub 分辨率默认值').includes('1080P'));
  assert.equal(h.find('button', '使用 0.2–1.0 MP 选项'), undefined);
  h.change('select', 'RunningHub 分辨率默认值', '1080P'); h.click('保存工作流');
  assert.equal(outputValue(h.state.workflows[0].requestTemplate, 'resolution'), '1080P');
  outputSection(h, 'resolution'); h.change('select', 'RunningHub 分辨率默认值', '__custom__');
  h.change('input', 'RunningHub 分辨率自定义默认值', '2048X1152'); h.click('保存工作流');
  assert.equal(outputValue(h.state.workflows[0].requestTemplate, 'resolution'), '2048X1152', 'ordinary resolution fields keep their existing custom-value capability'); h.dispose();
  const unbounded = megapixelWorkflow('未指定范围'); delete unbounded.nodeCatalog![0].control;
  const mp = harness('manager', fixture([unbounded])); outputSection(mp, 'resolution');
  mp.change('select', 'RunningHub 分辨率节点字段', megapixelKey);
  const input = mp.required('input', 'RunningHub 分辨率默认值');
  assert.equal(input.props.type, 'number'); assert.equal(input.props.min, undefined); assert.equal(input.props.max, undefined); assert.equal(input.props.step, 'any');
  assert.equal(mp.state.workflows[0].fieldControls, undefined); mp.dispose();
});

test('16:9 的 MP 选项显示节点像素尺寸但只保存原始MP值，切换其他比例不沿用像素标签', () => {
  const h = harness('manager', fixture([megapixelWorkflow()])); outputSection(h, 'resolution');
  h.change('select', 'RunningHub 分辨率节点字段', megapixelKey); h.click('使用 0.2–1.0 MP 选项');
  const optionTexts = () => nodesOf(h.required('select', 'RunningHub 分辨率默认值').props.children)
    .filter((node) => node.type === 'option').map((node) => textOf(node));
  assert.deepEqual(optionTexts(), Object.entries(megapixelLabels).map(([value, label]) => `${value} MP（${label}）`));
  assert.match(h.text(), /当前工作流 16:9 分辨率节点尺寸；二采可能改变最终视频尺寸/u);
  h.change('select', 'RunningHub 分辨率默认值', '1.0'); h.click('保存工作流');
  assert.equal(megapixelValue(h.state.workflows[0]), '1.0');
  assert.ok(!h.state.workflows[0].requestTemplate.includes('1376'), 'pixel labels stay outside the cloud request');
  const changeAspect = (value: string) => {
    h.click('节点参数'); h.change('select', '云端参数字段范围', 'all');
    h.change('input', '搜索云端节点字段', '252.aspect_ratio');
    h.change('input', '云端字段 252.aspect_ratio 默认值', value); outputSection(h, 'resolution');
  };
  changeAspect('1:1 (Square)');
  assert.ok(optionTexts().every((value) => !value.includes('×')), 'another ratio cannot reuse 16:9 pixel labels');
  assert.doesNotMatch(h.text(), /二采可能改变最终视频尺寸/u);
  h.change('input', 'RunningHub 分辨率步长', '0.01'); h.click('保存工作流');
  assert.equal(h.state.workflows[0].fieldControls?.[megapixelKey].step, 0.1);
  assert.deepEqual(h.state.workflows[0].fieldControls?.[megapixelKey].optionLabels, megapixelLabels, 'changing ratio while labels are hidden preserves their saved ratio-specific metadata');
  changeAspect('16:9');
  assert.ok(optionTexts().includes('0.5 MP（960 × 544）'));
  h.click('保存工作流'); assert.equal(megapixelValue(h.state.workflows[0]), '1.0');
  assert.equal(h.discoveryCalls.length, 0); h.dispose();
});

test('未声明画面比例的MP工作流不猜测像素尺寸，预设仍保留九档和原默认值', () => {
  const original = megapixelWorkflow(); original.nodeCatalog = original.nodeCatalog!.filter((node) => node.fieldName !== 'aspect_ratio');
  const h = harness('manager', fixture([original])); outputSection(h, 'resolution');
  h.change('select', 'RunningHub 分辨率节点字段', megapixelKey); h.click('使用 0.2–1.0 MP 选项');
  const options = nodesOf(h.required('select', 'RunningHub 分辨率默认值').props.children).filter((node) => node.type === 'option');
  assert.equal(options.length, 9); assert.ok(options.every((node) => !textOf(node).includes('×')));
  h.click('保存工作流'); assert.equal(megapixelValue(h.state.workflows[0]), '0.5'); h.dispose();
});

test('旧宽高误绑MP只形成待保存的像素修正稿，主页面单字段并保留九档与节点原值', () => {
  for (const legacyKey of ['width', 'height'] as const) {
    const original = megapixelWorkflow(`旧${legacyKey}绑定`);
    original.requestTemplate = library.ensureRunningHubVideoRequestNode(original.requestTemplate, { nodeId: '252', fieldName: 'megapixels', fieldValue: '0.5' });
    original.mapping.parameters = { [legacyKey]: { nodeId: '252', inputName: 'megapixels' } };
    original.fieldControls = { [megapixelKey]: { kind: 'select', unit: 'MP', options: Object.keys(megapixelLabels), min: 0.2, max: 1, step: 0.1,
      optionLabels: megapixelLabels, optionLabelAspectRatio: '16:9' } };
    const h = harness('manager', fixture([original])); outputSection(h, 'resolution');
    assert.deepEqual(h.state.workflows[0], original, 'opening the editor never saves the correction');
    assert.equal(h.patches.length, 0);
    assert.match(h.text(), /像素（MP）/u); assert.doesNotMatch(h.text(), /像素宽度（MP）|像素高度（MP）/u);
    assert.equal(h.required('select', 'RunningHub 分辨率节点字段').props.value, megapixelKey);
    assert.equal(h.required('select', 'RunningHub 分辨率默认值').props.value, '0.5');
    assert.equal(h.find('select', 'RunningHub 像素宽度节点字段'), undefined);
    assert.equal(h.find('select', 'RunningHub 像素高度节点字段'), undefined);
    assert.equal(h.required('button', '保存工作流').props.disabled, false);
    assert.deepEqual(optionValues(h, 'RunningHub 分辨率默认值'), Object.keys(megapixelLabels));
    h.click('保存工作流');
    assert.deepEqual(h.state.workflows[0].mapping.parameters, { resolution: { nodeId: '252', inputName: 'megapixels' } });
    assert.equal(h.state.workflows[0].requestTemplate, original.requestTemplate);
    assert.deepEqual(h.state.workflows[0].fieldControls, original.fieldControls);
    outputSection(h, 'width'); h.change('select', '时长分辨率字段范围', 'all');
    assert.ok(!fieldOptionValues(h, 'RunningHub 像素宽度节点字段').includes(megapixelKey));
    assert.ok(!fieldOptionValues(h, 'RunningHub 像素高度节点字段').includes(megapixelKey));
    h.change('select', 'RunningHub 像素宽度节点字段', megapixelKey);
    assert.equal(h.required('select', 'RunningHub 像素宽度节点字段').props.value, fieldKey('', ''), 'a forged legacy width selection cannot reintroduce the incorrect purpose');
    outputSection(h, 'resolution');
    assert.equal(h.required('select', 'RunningHub 分辨率默认值').props.value, '0.5');
    assert.equal(h.discoveryCalls.length, 0); h.dispose();
  }
});

test('真正的像素宽高在高级页独立绑定，切回常用页不会改写已有宽高或生成空高度主控件', () => {
  const original = outputWorkflow('真实宽高'); const h = harness('manager', fixture([original]));
  bindOutput(h, 'width'); bindOutput(h, 'height'); h.click('保存工作流');
  const saved = structuredClone(h.state.workflows[0]);
  outputSection(h, 'resolution');
  assert.equal(h.find('select', 'RunningHub 像素宽度节点字段'), undefined);
  assert.equal(h.find('select', 'RunningHub 像素高度节点字段'), undefined);
  outputSection(h, 'width');
  assert.equal(h.required('select', 'RunningHub 像素宽度节点字段').props.value, fieldKey('42', 'width'));
  assert.equal(h.required('select', 'RunningHub 像素高度节点字段').props.value, fieldKey('42', 'height'));
  assert.equal(h.required('input', 'RunningHub 像素宽度默认值').props.value, '1280');
  assert.equal(h.required('input', 'RunningHub 像素高度默认值').props.value, '720');
  assert.deepEqual(h.state.workflows[0], saved); assert.equal(h.required('button', '保存工作流').props.disabled, true); h.dispose();
});

test('节点参数手写宽高用途时MP仍统一使用resolution，其他工作流与默认值保持原样', () => {
  const original = megapixelWorkflow('手写像素用途'); const other = outputWorkflow('另一工作流');
  const h = harness('manager', fixture([other, original])); h.click('编辑云端工作流 手写像素用途');
  h.click('节点参数'); h.change('select', '云端参数字段范围', 'all'); h.change('input', '搜索云端节点字段', '252.megapixels');
  h.change('input', '云端字段 252.megapixels 参数名', 'width');
  assert.equal(h.required('input', '云端字段 252.megapixels 参数名').props.value, 'resolution');
  h.change('input', '云端字段 252.megapixels 参数名', 'height');
  assert.equal(h.required('input', '云端字段 252.megapixels 参数名').props.value, 'resolution');
  outputSection(h, 'resolution'); assert.match(h.text(), /像素（MP）/u);
  assert.equal(h.required('input', 'RunningHub 分辨率默认值').props.value, '0.5');
  h.click('保存工作流');
  assert.deepEqual(h.state.workflows[1].mapping.parameters, { resolution: { nodeId: '252', inputName: 'megapixels' } });
  assert.equal(megapixelValue(h.state.workflows[1]), '0.5'); assert.deepEqual(h.state.workflows[0], other);
  assert.equal(h.discoveryCalls.length, 0); h.dispose();
});

test('已有分辨率绑定冲突时保留旧MP映射供解除，不暗中覆盖其他用途或保存原稿', () => {
  const original = megapixelWorkflow('保留冲突草稿');
  original.requestTemplate = library.ensureRunningHubVideoRequestNode(original.requestTemplate, { nodeId: '252', fieldName: 'megapixels', fieldValue: '0.5' });
  original.requestTemplate = library.ensureRunningHubVideoRequestNode(original.requestTemplate, { nodeId: '41', fieldName: 'resolution', fieldValue: '720P' });
  original.mapping.parameters = { resolution: { nodeId: '41', inputName: 'resolution' }, width: { nodeId: '252', inputName: 'megapixels' } };
  const h = harness('manager', fixture([original])); outputSection(h, 'width');
  const legacySelect = h.required('select', 'RunningHub 像素宽度节点字段');
  assert.equal(legacySelect.props.value, megapixelKey);
  assert.equal(nodesOf(legacySelect.props.children).find((node) => node.type === 'option' && node.props.value === megapixelKey)?.props.disabled, true);
  assert.match(h.text(), /旧绑定，请改用像素（MP）/u);
  assert.deepEqual(h.state.workflows[0], original); assert.equal(h.patches.length, 0);
  h.change('select', 'RunningHub 像素宽度节点字段', fieldKey('', '')); h.click('保存工作流');
  assert.deepEqual(h.state.workflows[0].mapping.parameters, { resolution: { nodeId: '41', inputName: 'resolution' } });
  assert.equal(h.state.workflows[0].requestTemplate, original.requestTemplate); h.dispose();
});

console.log(`RunningHub video settings: ${groups} interaction groups passed.`);
