import assert from 'node:assert/strict';
import {
  bindRunningHubVideoOutput, runningHubVideoOutputCandidates, runningHubVideoOutputConflict,
  runningHubVideoOutputFields, runningHubVideoOutputControl, setRunningHubVideoFieldControl, type RunningHubVideoOutputKey,
  isRunningHubVideoMegapixelsBinding, runningHubVideoOutputDraft,
} from '../src/runningHubVideoOutput';
import {
  bindRunningHubVideoRequest, compileRunningHubVideoApi, createRunningHubVideoWorkflow,
  readRunningHubVideoRequest, updateRunningHubVideoNodeValue, exportRunningHubVideoWorkflow, importRunningHubVideoWorkflow, normalizeRunningHubVideoConfig, saveRunningHubVideoWorkflow,
  ensureRunningHubVideoRequestNode,
} from '../src/runningHubVideo';
import { listRunningHubVideoNodes } from '../src/runningHubVideoNodes';
import type {
  RunningHubVideoConfig, RunningHubVideoInputBinding, RunningHubVideoNodeCatalogEntry,
  RunningHubVideoNodeInfo, RunningHubVideoWorkflow,
} from '../src/runningHubVideoTypes';

let groups = 0;
const failures: string[] = [];
const check = (name: string, run: () => void) => {
  try { run(); groups += 1; console.log(`PASS ${name}`); }
  catch (cause) { failures.push(name); console.error(`FAIL ${name}`, cause); }
};
const field = (fieldName: string, fieldValue: unknown = '', description?: string, nodeId = '1'): RunningHubVideoNodeInfo => ({ nodeId, fieldName, fieldValue, ...(description === undefined ? {} : { description }) });
const binding = (node: RunningHubVideoNodeInfo): RunningHubVideoInputBinding => ({ nodeId: node.nodeId, inputName: node.fieldName });
const ids = (nodes: RunningHubVideoNodeInfo[]) => nodes.map((node) => `${node.nodeId}.${node.fieldName}`);
const fixture = (): RunningHubVideoWorkflow => ({
  ...createRunningHubVideoWorkflow('输出参数纯函数测试'), remoteId: '2093983063180054529', runKind: 'workflow',
  requestTemplate: '{\n  "addMetadata": true, "nodeInfoList": [\n    {"nodeId":"prompt","fieldName":"text","fieldValue":"original prompt"},\n    {"nodeId":"keep","fieldName":"opaque","fieldValue":"Keep {{duration}} / {{resolution}} / {{width}} / {{height}} literally"},\n    {"nodeId":"frames","fieldName":"num_frames","fieldValue":121},\n    {"nodeId":"fps","fieldName":"fps","fieldValue":24},\n    {"nodeId":"seed","fieldName":"value","fieldValue":"9223372036854775807"}\n  ], "instanceType": "default", "usePersonalQueue": false, "retainSeconds": 60,\n  "extra": {"precise": "0.6000000000000001", "link": ["upstream", 0]}\n}',
  mapping: { prompt: [{ nodeId: 'prompt', inputName: 'text' }], images: [] },
  nodeCatalog: [
    { nodeId: 'time', fieldName: 'duration', fieldValue: 6, description: '视频时长（秒）' },
    { nodeId: 'size', fieldName: 'resolution', fieldValue: '720P' },
    { nodeId: 'pixels', fieldName: 'width', fieldValue: '1280' },
    { nodeId: 'pixels', fieldName: 'height', fieldValue: 720 },
    { nodeId: 'other', fieldName: 'lora_name', fieldValue: 'Keep.safetensors' },
  ],
});
const mapped = (): RunningHubVideoWorkflow => {
  let workflow = fixture();
  for (const key of ['duration', 'resolution', 'width', 'height'] as const) {
    const node = workflow.nodeCatalog!.find((entry) => entry.fieldName === key)!;
    workflow = bindRunningHubVideoOutput(workflow, key, { nodeId: node.nodeId, inputName: node.fieldName });
  }
  return workflow;
};
const config = (workflow: RunningHubVideoWorkflow): RunningHubVideoConfig => ({ enabled: false, baseUrl: 'https://www.runninghub.ai', apiKey: 'isolated-test-key', workflows: [workflow], activeWorkflowId: workflow.id });

check('four output definitions distinguish seconds, resolution tokens and independent pixel dimensions', () => {
  assert.deepEqual(runningHubVideoOutputFields.map((entry) => entry.key), ['duration', 'resolution', 'width', 'height']);
  assert.equal(new Set(runningHubVideoOutputFields.map((entry) => entry.label)).size, 4);
  assert.match(runningHubVideoOutputFields.find((entry) => entry.key === 'duration')!.hint, /秒.*不是帧数.*保留/u);
  assert.match(runningHubVideoOutputFields.find((entry) => entry.key === 'resolution')!.hint, /720P.*1080P/u);
  assert.match(runningHubVideoOutputFields.find((entry) => entry.key === 'width')!.hint, /不自动计算宽高比/u);
});

check('common field aliases normalize case and separators without guessing unknown identifiers', () => {
  const cases: Record<RunningHubVideoOutputKey, string[]> = {
    duration: ['duration', 'Duration_Sec', 'durationSeconds', 'video-duration', 'seconds', '时长', '视频时长', '秒数'],
    resolution: ['resolution', 'VideoResolution', 'output_resolution', '分辨率', '清晰度', 'megapixels', 'mega_pixels', 'megaPixel', '百万像素'],
    width: ['width', 'imageWidth', 'video_width', 'output-width', 'targetWidth', 'frame_width', '像素宽度', '画面宽度'],
    height: ['height', 'imageHeight', 'video_height', 'output-height', 'targetHeight', 'frame_height', '像素高度', '画面高度'],
  };
  for (const [key, names] of Object.entries(cases) as Array<[RunningHubVideoOutputKey, string[]]>) {
    for (const name of names) assert.equal(runningHubVideoOutputCandidates([field(name)], key).length, 1, `${key}: ${name}`);
    assert.deepEqual(runningHubVideoOutputCandidates([field('custom_internal_field', `${key}=10`)], key), []);
  }
});

check('seconds suggestions exclude frame counts, frame rates, milliseconds, retention and timeout controls', () => {
  for (const name of ['frames', 'num_frames', 'frameCount', 'frame_rate', 'fps', 'length', 'duration_ms', 'retainSeconds', 'timeoutSeconds']) {
    assert.deepEqual(runningHubVideoOutputCandidates([field(name, 120)], 'duration'), [], name);
  }
  for (const [name, description] of [
    ['value', 'Duration in frames'], ['value', '视频时长（帧数）'], ['value', 'Duration in milliseconds'], ['value', '视频时长（毫秒）'],
    ['duration', 'Duration in milliseconds'], ['duration', '视频时长（帧数）'], ['value', '实例保留秒数'], ['value', 'Timeout seconds'],
  ]) {
    const node = field(name, 120, description);
    assert.deepEqual(runningHubVideoOutputCandidates([node], 'duration'), [], description);
    assert.deepEqual(ids(runningHubVideoOutputCandidates([node], 'duration', { showAll: true })), [`1.${name}`], 'advanced view keeps real fields available without assuming their units');
  }
});

check('generic inputs use node titles as display hints, never infer meaning from their values', () => {
  for (const [key, description] of [['duration', '视频时长（秒）'], ['resolution', 'Output Resolution'], ['width', '像素宽度'], ['height', 'Video Height']] as const) {
    for (const name of ['value', 'int', 'integer', 'float', 'number', 'string', 'input', '数值', '值']) {
      assert.equal(runningHubVideoOutputCandidates([field(name, '', description)], key).length, 1, `${key}: ${name}`);
    }
    assert.deepEqual(runningHubVideoOutputCandidates([field('value', description)], key), []);
    assert.deepEqual(runningHubVideoOutputCandidates([field('custom_value', '10', description)], key), []);
  }
  assert.deepEqual(runningHubVideoOutputCandidates([field('width', 1920), field('height', 1080)], 'resolution'), [], 'dimensions are not silently converted into a named quality tier');
});

check('advanced choices accept only text/numeric candidates; an existing malformed binding remains inspectable', () => {
  for (const value of [true, false, null, undefined, ['4', 0], { value: 10 }]) {
    const node = { ...field('duration'), fieldValue: value };
    assert.deepEqual(runningHubVideoOutputCandidates([node], 'duration', { showAll: true }), []);
    assert.equal(runningHubVideoOutputCandidates([node], 'duration', { binding: binding(node), search: 'unmatched' }).length, 1);
  }
  for (const value of ['', '10.5', '1080P', 720, 10.5]) assert.equal(runningHubVideoOutputCandidates([field('custom', value)], 'resolution', { showAll: true }).length, 1);
});

check('search uses field identity and metadata while preserving the selected unknown binding', () => {
  const nodes = [field('duration', 6, 'Seconds input', '11'), field('value', 'do-not-search-this-default', 'legacy', '12'), field('resolution', '720P', '档位', '13')];
  assert.deepEqual(ids(runningHubVideoOutputCandidates(nodes, 'duration', { search: ' seconds ' })), ['11.duration']);
  assert.deepEqual(ids(runningHubVideoOutputCandidates(nodes, 'resolution', { showAll: true, search: '13.resolution' })), ['13.resolution']);
  assert.deepEqual(runningHubVideoOutputCandidates(nodes, 'duration', { showAll: true, search: 'do-not-search-this-default' }), []);
  assert.deepEqual(ids(runningHubVideoOutputCandidates(nodes, 'duration', { binding: binding(nodes[1]), search: 'unmatched' })), ['12.value']);
  assert.deepEqual(runningHubVideoOutputCandidates([], 'duration', { binding: { nodeId: 'missing', inputName: 'value' } }), [], 'missing fields are not invented');
});

check('catalog descriptions enrich display only; saved request values and metadata remain authoritative and immutable', () => {
  const catalog: RunningHubVideoNodeCatalogEntry[] = [{ nodeId: '1', fieldName: 'value', fieldValue: 'cloud default', description: '视频时长（秒）' }];
  const nodes = [field('value', 'request default')]; const before = JSON.stringify({ nodes, catalog });
  nodes.forEach(Object.freeze); catalog.forEach(Object.freeze); Object.freeze(nodes); Object.freeze(catalog);
  const choices = runningHubVideoOutputCandidates(nodes, 'duration', { catalog });
  assert.equal(choices[0].fieldValue, 'request default'); assert.equal(choices[0].description, '视频时长（秒）'); assert.notEqual(choices[0], nodes[0]);
  choices[0].description = 'changed copy'; assert.equal(JSON.stringify({ nodes, catalog }), before);
  const authoritative = runningHubVideoOutputCandidates([field('value', 'saved', 'Video width')], 'duration', { catalog });
  assert.deepEqual(authoritative, [], 'an explicit request description is not overwritten by stale catalog metadata');
});

check('binding adds only the explicitly selected real node and preserves unrelated raw request bytes', () => {
  const original = fixture(); original.requestTemplate = original.requestTemplate.replace('"precise": "0.6000000000000001"', '"precise": 9223372036854775807');
  const before = JSON.stringify(original);
  const selected = bindRunningHubVideoOutput(original, 'duration', { nodeId: 'time', inputName: 'duration' });
  assert.equal(JSON.stringify(original), before); assert.notEqual(selected, original); assert.notEqual(selected.mapping, original.mapping);
  const inserted = selected.requestTemplate.indexOf(',\n    {"nodeId":"time"');
  const tail = selected.requestTemplate.indexOf('\n  ]', inserted);
  assert.ok(inserted >= 0 && tail > inserted);
  assert.equal(selected.requestTemplate.slice(0, inserted) + selected.requestTemplate.slice(tail + 3), original.requestTemplate, 'all bytes outside the one inserted node stay unchanged');
  assert.ok(selected.requestTemplate.includes('9223372036854775807'));
  const request = readRunningHubVideoRequest(selected.requestTemplate);
  assert.equal(request.nodeInfoList.length, readRunningHubVideoRequest(original.requestTemplate).nodeInfoList.length + 1);
  assert.equal(request.nodeInfoList.at(-1)?.fieldValue, 6);
  assert.deepEqual(selected.mapping.parameters, { duration: { nodeId: 'time', inputName: 'duration' } });
  assert.deepEqual(selected.nodeCatalog, original.nodeCatalog);
});

check('defaults retain string/number types, case and precision; rebinding an existing field does not rewrite request text', () => {
  const original = mapped(); const before = original.requestTemplate;
  const again = bindRunningHubVideoOutput(original, 'resolution', { nodeId: 'size', inputName: 'resolution' });
  assert.equal(again.requestTemplate, before);
  const request = readRunningHubVideoRequest(again.requestTemplate);
  assert.equal(request.nodeInfoList.find((node) => node.nodeId === 'size')?.fieldValue, '720P');
  assert.equal(request.nodeInfoList.find((node) => node.nodeId === 'pixels' && node.fieldName === 'width')?.fieldValue, '1280');
  assert.equal(request.nodeInfoList.find((node) => node.nodeId === 'pixels' && node.fieldName === 'height')?.fieldValue, 720);
  const changed = updateRunningHubVideoNodeValue(again.requestTemplate, { nodeId: 'size', inputName: 'resolution' }, '1080p');
  assert.equal(readRunningHubVideoRequest(changed).nodeInfoList.find((node) => node.nodeId === 'size')?.fieldValue, '1080p');
  assert.equal(original.requestTemplate, before);
  assert.equal(bindRunningHubVideoOutput({ ...original, requestTemplate: changed }, 'resolution', { nodeId: 'size', inputName: 'resolution' }).requestTemplate, changed, 'request default wins over stale 720P in catalog');
});

check('conflicts protect prompt/image/parameter ownership and legacy aliases; unbinding keeps nodes and other mappings', () => {
  const original = mapped(); original.mapping.images.push({ nodeId: 'image', inputName: 'image', role: 'first-frame' });
  original.mapping.parameters!.time = { nodeId: 'old-time', inputName: 'value' };
  const cases: Array<[RunningHubVideoInputBinding, RegExp]> = [
    [{ nodeId: 'prompt', inputName: 'text' }, /提示词/u], [{ nodeId: 'image', inputName: 'image' }, /参考图片/u],
    [{ nodeId: 'size', inputName: 'resolution' }, /参数 resolution/u], [{ nodeId: 'old-time', inputName: 'value' }, /参数 time/u],
  ];
  const before = JSON.stringify(original);
  for (const [target, message] of cases) {
    assert.match(runningHubVideoOutputConflict(original, 'duration', target), message);
    assert.throws(() => bindRunningHubVideoOutput(original, 'duration', target), /不会覆盖或重命名/u);
  }
  assert.equal(runningHubVideoOutputConflict(original, 'duration', { nodeId: 'time', inputName: 'duration' }), '');
  const cleared = bindRunningHubVideoOutput(original, 'duration');
  assert.equal(cleared.mapping.parameters?.duration, undefined); assert.deepEqual(cleared.mapping.parameters?.time, original.mapping.parameters?.time);
  assert.equal(cleared.requestTemplate, original.requestTemplate); assert.equal(JSON.stringify(original), before);
  const blank = bindRunningHubVideoOutput(original, 'duration', { nodeId: '', inputName: '' }); assert.deepEqual(blank, cleared);
});

check('missing, malformed, duplicate and nonscalar targets fail without mutations; long and compound IDs match exactly', () => {
  const original = fixture(); const before = JSON.stringify(original);
  assert.throws(() => bindRunningHubVideoOutput(original, 'duration', { nodeId: 'missing', inputName: 'duration' }), /真实/u);
  assert.throws(() => bindRunningHubVideoOutput({ ...original, requestTemplate: '{' }, 'duration', { nodeId: 'time', inputName: 'duration' }), /JSON/u);
  for (const fieldValue of [false, null, ['upstream', 0], { value: 7 }]) {
    const invalid = { ...original, requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: 'invalid', fieldName: 'duration', fieldValue }] }) };
    assert.throws(() => bindRunningHubVideoOutput(invalid, 'duration', { nodeId: 'invalid', inputName: 'duration' }), /真实|布尔/u);
  }
  const duplicate = { ...original, requestTemplate: '{"nodeInfoList":[{"nodeId":"a","fieldName":"duration","fieldValue":6},{"nodeId":"a","fieldName":"duration","fieldValue":7}]}' };
  assert.throws(() => bindRunningHubVideoOutput(duplicate, 'duration', { nodeId: 'a', inputName: 'duration' }), /重复/u);
  let exact = { ...original, nodeCatalog: [...original.nodeCatalog!, { nodeId: '2093983063180054529', fieldName: 'duration', fieldValue: 6 }, { nodeId: 'a.b', fieldName: 'c', fieldValue: 'first' }, { nodeId: 'a', fieldName: 'b.c', fieldValue: 'second' }] };
  exact = bindRunningHubVideoOutput(exact, 'duration', { nodeId: '2093983063180054529', inputName: 'duration' }) as typeof exact;
  exact = bindRunningHubVideoOutput(exact, 'resolution', { nodeId: 'a.b', inputName: 'c' }) as typeof exact;
  exact = bindRunningHubVideoOutput(exact, 'width', { nodeId: 'a', inputName: 'b.c' }) as typeof exact;
  assert.equal(exact.mapping.parameters?.duration.nodeId, '2093983063180054529');
  assert.equal(readRunningHubVideoRequest(exact.requestTemplate).nodeInfoList.find((node) => node.nodeId === 'a.b')?.fieldValue, 'first');
  assert.equal(readRunningHubVideoRequest(exact.requestTemplate).nodeInfoList.find((node) => node.nodeId === 'a')?.fieldValue, 'second');
  assert.equal(JSON.stringify(original), before);
});

check('explicit task values touch only mapped outputs, no seconds-to-frames conversion or opaque token replacement', () => {
  const original = mapped(); const before = JSON.stringify(original); const params = { duration: 10.5, resolution: '1080P', width: 1920, height: 1080 };
  const api = compileRunningHubVideoApi(config(original), original.id, params);
  const result = bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: 'original prompt', parameters: params }, []) as ReturnType<typeof readRunningHubVideoRequest>;
  const expected = readRunningHubVideoRequest(original.requestTemplate);
  for (const [key, value] of Object.entries(params)) {
    const target = original.mapping.parameters![key]; const node = expected.nodeInfoList.find((row) => row.nodeId === target.nodeId && row.fieldName === target.inputName)!;
    node.fieldValue = typeof node.fieldValue === 'number' ? Number(value) : String(value);
  }
  assert.deepEqual(result, expected); assert.equal(result.retainSeconds, 60);
  assert.equal(result.nodeInfoList.find((node) => node.nodeId === 'frames')?.fieldValue, 121); assert.equal(result.nodeInfoList.find((node) => node.nodeId === 'fps')?.fieldValue, 24);
  assert.match(String(result.nodeInfoList.find((node) => node.nodeId === 'keep')?.fieldValue), /\{\{duration\}\}.*\{\{resolution\}\}.*\{\{width\}\}.*\{\{height\}\}/u);
  const defaults = bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: 'original prompt', parameters: {} }, []);
  assert.deepEqual(defaults, readRunningHubVideoRequest(original.requestTemplate));
  assert.equal(JSON.stringify(original), before); assert.equal(listRunningHubVideoNodes(original.requestTemplate, original.nodeCatalog).length, 10);
});

check('MP defaults expose decimal controls without guessing a range or changing the request', () => {
  let workflow = fixture();
  workflow.nodeCatalog!.push({ nodeId: 'mp-node', fieldName: 'megapixels', fieldValue: '0.5' });
  workflow = bindRunningHubVideoOutput(workflow, 'resolution', { nodeId: 'mp-node', inputName: 'megapixels' });
  const before = workflow.requestTemplate;
  assert.deepEqual(runningHubVideoOutputControl(workflow, 'resolution'), { control: { kind: 'number', unit: 'MP' }, defaultValue: '0.5' });
  const api = compileRunningHubVideoApi(config(workflow));
  assert.deepEqual(api.runningHubParameterControls?.resolution, { kind: 'number', unit: 'MP' });
  assert.equal(workflow.requestTemplate, before);
  assert.doesNotMatch(api.requestTemplate!, /runningHubParameterControls|"control"/u);
  assert.equal(runningHubVideoOutputControl(workflow, 'width'), undefined);
});

check('explicit field controls override cloud metadata, round-trip, and restore without altering defaults', () => {
  let workflow = fixture();
  workflow.nodeCatalog!.push({ nodeId: 'mp-node', fieldName: 'megapixels', fieldValue: '0.5', control: { kind: 'number', min: 0.1, max: 2, step: 0.1 } });
  const target = { nodeId: 'mp-node', inputName: 'megapixels' };
  workflow = bindRunningHubVideoOutput(workflow, 'resolution', target);
  const before = JSON.stringify(workflow);
  const override = { kind: 'select' as const, unit: 'MP' as const, options: ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'], min: 0.2, max: 1, step: 0.1 };
  const controlled = setRunningHubVideoFieldControl(workflow, target, override);
  assert.deepEqual(runningHubVideoOutputControl(controlled, 'resolution'), { control: override, defaultValue: '0.5' });
  assert.equal(controlled.requestTemplate, workflow.requestTemplate); assert.equal(JSON.stringify(workflow), before);
  const saved = saveRunningHubVideoWorkflow(config(controlled), controlled).workflows[0];
  const normalized = normalizeRunningHubVideoConfig(config(saved)).workflows[0];
  const restored = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(normalized)).workflow;
  assert.deepEqual(restored.fieldControls, controlled.fieldControls);
  assert.deepEqual(runningHubVideoOutputControl(restored, 'resolution'), { control: override, defaultValue: '0.5' });
  const reverted = setRunningHubVideoFieldControl(restored, target, undefined);
  assert.deepEqual(runningHubVideoOutputControl(reverted, 'resolution')?.control, { kind: 'number', min: 0.1, max: 2, step: 0.1, unit: 'MP' });
  assert.equal(reverted.requestTemplate, workflow.requestTemplate);
  const api = compileRunningHubVideoApi(config(controlled));
  assert.deepEqual(api.runningHubParameterControls?.resolution, override);
  for (const resolution of ['0.2', '0.5', '1.0', '0.98']) {
    const request = bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: 'keep', parameters: { resolution } }, []);
    assert.equal((request as ReturnType<typeof readRunningHubVideoRequest>).nodeInfoList.find((node) => node.nodeId === 'mp-node')?.fieldValue, resolution,
      'display choices preserve exact wire strings; historical 0.98 remains replayable, never rounded');
  }
});

check('pixel option labels follow the same node ratio and final task overrides without changing wire values', () => {
  const target = { nodeId: 'mp-node', inputName: 'megapixels' };
  const aspectTarget = { nodeId: 'mp-node', inputName: 'aspect_ratio' };
  let workflow = fixture();
  workflow.nodeCatalog!.push({ nodeId: target.nodeId, fieldName: target.inputName, fieldValue: '0.5' },
    { nodeId: aspectTarget.nodeId, fieldName: aspectTarget.inputName, fieldValue: '16:9 (Widescreen)' },
    { nodeId: 'unrelated-node', fieldName: 'aspect_ratio', fieldValue: '9:16 (Portrait Widescreen)' });
  workflow = bindRunningHubVideoOutput(workflow, 'resolution', target);
  workflow.requestTemplate = ensureRunningHubVideoRequestNode(workflow.requestTemplate,
    { nodeId: aspectTarget.nodeId, fieldName: aspectTarget.inputName, fieldValue: '16:9 (Widescreen)' });
  workflow.mapping.parameters = { ...workflow.mapping.parameters, aspect: aspectTarget };
  const options = ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0'];
  const optionLabels = { '0.2': '608 × 352', '0.3': '736 × 416', '0.4': '864 × 480', '0.5': '960 × 544', '0.6': '1056 × 608', '0.7': '1152 × 640', '0.8': '1216 × 672', '0.9': '1280 × 736', '1.0': '1376 × 768' };
  workflow = setRunningHubVideoFieldControl(workflow, target, { kind: 'select', unit: 'MP', options, min: 0.2, max: 1, step: 0.1, optionLabels, optionLabelAspectRatio: '16:9' });
  const persistent = JSON.stringify(workflow.fieldControls);
  assert.deepEqual(runningHubVideoOutputControl(workflow, 'resolution')?.control.optionLabels, optionLabels);
  const portrait = { ...workflow, requestTemplate: updateRunningHubVideoNodeValue(workflow.requestTemplate, aspectTarget, '9:16 (Portrait Widescreen)') };
  assert.equal(runningHubVideoOutputControl(portrait, 'resolution')?.control.optionLabels, undefined);
  assert.equal(JSON.stringify(portrait.fieldControls), persistent, 'changing ratio hides labels without deleting saved labels');
  const landscape = { ...portrait, requestTemplate: updateRunningHubVideoNodeValue(portrait.requestTemplate, aspectTarget, '16:9') };
  assert.deepEqual(runningHubVideoOutputControl(landscape, 'resolution')?.control.optionLabels, optionLabels);
  const restored = importRunningHubVideoWorkflow(exportRunningHubVideoWorkflow(portrait)).workflow;
  assert.equal(JSON.stringify(restored.fieldControls), persistent); assert.equal(runningHubVideoOutputControl(restored, 'resolution')?.control.optionLabels, undefined);
  const withoutAspect = { ...workflow, nodeCatalog: workflow.nodeCatalog!.filter((node) => node.fieldName !== 'aspect_ratio'), requestTemplate: JSON.stringify({ ...readRunningHubVideoRequest(workflow.requestTemplate), nodeInfoList: readRunningHubVideoRequest(workflow.requestTemplate).nodeInfoList.filter((node) => node.fieldName !== 'aspect_ratio') }) };
  assert.equal(runningHubVideoOutputControl(withoutAspect, 'resolution')?.control.optionLabels, undefined, 'missing ratio does not assume a label context');
  const wideApi = compileRunningHubVideoApi(config(portrait), portrait.id, { aspect: '16:9 (Widescreen)', resolution: '1.0' });
  assert.deepEqual(wideApi.runningHubParameterControls?.resolution.optionLabels, optionLabels, 'task ratio override governs snapshot labels');
  const tallApi = compileRunningHubVideoApi(config(workflow), workflow.id, { aspect: '9:16 (Portrait Widescreen)' });
  assert.equal(tallApi.runningHubParameterControls?.resolution.optionLabels, undefined);
  assert.doesNotMatch(wideApi.requestTemplate!, /optionLabels|optionLabelAspectRatio|1376|608/u);
  assert.equal(readRunningHubVideoRequest(wideApi.requestTemplate!).nodeInfoList.find((node) => node.fieldName === 'megapixels')?.fieldValue, '1.0');
  assert.equal(JSON.stringify(workflow.fieldControls), persistent);
});

const misplacedMp = (key: 'width' | 'height' = 'width'): RunningHubVideoWorkflow => {
  const workflow = fixture();
  const target = { nodeId: 'mp', inputName: 'mega_pixels' };
  workflow.requestTemplate = ensureRunningHubVideoRequestNode(workflow.requestTemplate, { nodeId: target.nodeId, fieldName: target.inputName, fieldValue: '0.5' });
  workflow.mapping.parameters = { [key]: target, seed: { nodeId: 'seed', inputName: 'value' } };
  workflow.fieldControls = { '["mp","mega_pixels"]': { kind: 'select', unit: 'MP', options: ['0.2', '0.5', '1.0'], min: 0.2, max: 1, step: 0.1,
    optionLabels: { '0.5': '960 × 544' }, optionLabelAspectRatio: '16:9' } };
  return workflow;
};

check('MP correction is an immutable editor draft and preserves exact request, metadata and other mappings', () => {
  for (const key of ['width', 'height'] as const) {
    const workflow = misplacedMp(key); const before = JSON.stringify(workflow);
    const result = runningHubVideoOutputDraft(workflow);
    assert.equal(result.movedFrom, key); assert.equal(result.issue, '');
    assert.notEqual(result.workflow, workflow); assert.notEqual(result.workflow.mapping, workflow.mapping);
    assert.deepEqual(result.workflow.mapping.parameters?.resolution, workflow.mapping.parameters?.[key]);
    assert.equal(result.workflow.mapping.parameters?.[key], undefined);
    assert.deepEqual(result.workflow.mapping.parameters?.seed, workflow.mapping.parameters?.seed);
    assert.equal(result.workflow.requestTemplate, workflow.requestTemplate);
    assert.equal(result.workflow.nodeCatalog, workflow.nodeCatalog); assert.equal(result.workflow.fieldControls, workflow.fieldControls);
    assert.equal(JSON.stringify(workflow), before);
    assert.equal(runningHubVideoOutputDraft(result.workflow).workflow, result.workflow, 'correction is idempotent');
    const saved = saveRunningHubVideoWorkflow(config(workflow), result.workflow).workflows[0];
    assert.deepEqual(saved.mapping.parameters, result.workflow.mapping.parameters);
    assert.equal(saved.requestTemplate, workflow.requestTemplate);
    assert.deepEqual(normalizeRunningHubVideoConfig(config(workflow)).workflows[0].mapping.parameters, workflow.mapping.parameters,
      'normalizing live settings must not migrate old parameter keys');
  }
});

check('old width MP snapshots replay their original key and corrected drafts produce the same wire values', () => {
  const workflow = misplacedMp(); const original = JSON.stringify(workflow);
  const frozenApi = compileRunningHubVideoApi(config(workflow)); const frozen = JSON.stringify(frozenApi);
  const corrected = runningHubVideoOutputDraft(workflow).workflow;
  const correctedApi = compileRunningHubVideoApi(config(corrected));
  assert.equal(frozenApi.runningHubMappedFields?.find((entry) => entry.parameter === 'width')?.fieldName, 'mega_pixels');
  assert.equal(frozenApi.runningHubParameterControls?.width.unit, 'MP');
  for (const value of ['0.2', '0.5', '1.0', '0.98']) {
    const oldBody = bindRunningHubVideoRequest(frozenApi.requestTemplate!, frozenApi.runningHubMappedFields!, { prompt: 'same', parameters: { width: value } }, []);
    const newBody = bindRunningHubVideoRequest(correctedApi.requestTemplate!, correctedApi.runningHubMappedFields!, { prompt: 'same', parameters: { resolution: value } }, []);
    assert.deepEqual(newBody, oldBody);
    assert.equal((oldBody as ReturnType<typeof readRunningHubVideoRequest>).nodeInfoList.find((node) => node.nodeId === 'mp')?.fieldValue, value);
  }
  assert.throws(() => compileRunningHubVideoApi(config(corrected), corrected.id, { width: '0.5' }), /width.*尚未绑定/u,
    'a stale live draft is never silently discarded or guessed after an explicit mapping save');
  assert.equal(JSON.stringify(frozenApi), frozen); assert.equal(JSON.stringify(workflow), original);
});

check('MP correction leaves resolution conflicts, multiple MP inputs and duplicate purposes untouched', () => {
  const base = misplacedMp();
  const second = { nodeId: 'mp2', inputName: 'megapixels' };
  const withSecond = { ...base, requestTemplate: ensureRunningHubVideoRequestNode(base.requestTemplate, { nodeId: second.nodeId, fieldName: second.inputName, fieldValue: '0.7' }) };
  const cases: RunningHubVideoWorkflow[] = [
    { ...base, mapping: { ...base.mapping, parameters: { ...base.mapping.parameters, resolution: { nodeId: 'size', inputName: 'resolution' } } } },
    { ...base, mapping: { ...base.mapping, parameters: { ...base.mapping.parameters, resolution: base.mapping.parameters!.width } } },
    { ...withSecond, mapping: { ...withSecond.mapping, parameters: { ...withSecond.mapping.parameters, height: second } } },
    { ...base, mapping: { ...base.mapping, parameters: { ...base.mapping.parameters, height: base.mapping.parameters!.width } } },
    { ...base, mapping: { ...base.mapping, parameters: { ...base.mapping.parameters, pixels: base.mapping.parameters!.width } } },
    { ...base, mapping: { ...base.mapping, prompt: [...base.mapping.prompt, base.mapping.parameters!.width] } },
  ];
  for (const workflow of cases) {
    const before = JSON.stringify(workflow); const result = runningHubVideoOutputDraft(workflow);
    assert.equal(result.workflow, workflow); assert.equal(result.movedFrom, undefined); assert.ok(result.issue);
    assert.equal(JSON.stringify(workflow), before);
  }
});

check('MP cannot be selected or rebound as width or height, including all-field and current-binding views', () => {
  const workflow = misplacedMp(); const target = workflow.mapping.parameters!.width;
  const mp = field(target.inputName, '0.5', undefined, target.nodeId);
  for (const key of ['width', 'height'] as const) {
    for (const options of [{}, { showAll: true }, { showAll: true, binding: target }]) {
      assert.deepEqual(runningHubVideoOutputCandidates([mp], key, options), []);
    }
    assert.throws(() => bindRunningHubVideoOutput({ ...workflow, mapping: { ...workflow.mapping, parameters: {} } }, key, target), /MP.*不能作为/u);
    const pixels = field(key, 1280);
    assert.deepEqual(runningHubVideoOutputCandidates([pixels], key), [pixels]);
  }
  assert.deepEqual(runningHubVideoOutputCandidates([mp], 'resolution'), [mp]);
  assert.equal(bindRunningHubVideoOutput(workflow, 'width').mapping.parameters?.width, undefined, 'legacy bindings can still be cleared');
});

check('explicit MP metadata corrects generic fields but decimal pixel values alone remain real dimensions', () => {
  const generic = field('value', '0.5', undefined, 'generic'); const target = binding(generic);
  let workflow = fixture();
  workflow.requestTemplate = ensureRunningHubVideoRequestNode(workflow.requestTemplate, generic);
  workflow.mapping.parameters = { width: target };
  assert.equal(isRunningHubVideoMegapixelsBinding(workflow, target), false);
  assert.equal(runningHubVideoOutputDraft(workflow).workflow, workflow);
  for (const useCatalog of [false, true]) {
    const control = { kind: 'number' as const, unit: 'MP' as const };
    const controlled = useCatalog ? { ...workflow, nodeCatalog: [...workflow.nodeCatalog!, { ...generic, control } as RunningHubVideoNodeCatalogEntry] }
      : setRunningHubVideoFieldControl(workflow, target, control);
    assert.equal(isRunningHubVideoMegapixelsBinding(controlled, target), true);
    assert.equal(runningHubVideoOutputDraft(controlled).movedFrom, 'width');
    for (const key of ['width', 'height'] as const) {
      assert.deepEqual(runningHubVideoOutputCandidates([generic], key, { showAll: true, catalog: controlled.nodeCatalog, fieldControls: controlled.fieldControls }), []);
      assert.throws(() => bindRunningHubVideoOutput(controlled, key, target), /MP|已绑定/u);
    }
  }
  const pixels = mapped(); const result = runningHubVideoOutputDraft(pixels);
  assert.equal(result.workflow, pixels); assert.equal(result.issue, '');
});

assert.equal(failures.length, 0, `RunningHub output failures: ${failures.join('; ')}`);
console.log(`RunningHub output parameters: ${groups} groups passed; no network requests or generation tasks.`);
