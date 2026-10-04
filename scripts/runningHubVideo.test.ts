import assert from 'node:assert/strict';
import {
  bindRunningHubVideoRequest, coerceRunningHubVideoNodeValue, compileRunningHubVideoApi,
  copyRunningHubVideoWorkflow, createRunningHubTutorialVideoWorkflow, createRunningHubVideoWorkflow,
  defaultRunningHubVideoConfig, deleteRunningHubVideoWorkflow, exportRunningHubVideoWorkflow,
  importRunningHubVideoWorkflow, isRunningHubVideoWorkflowReady, normalizeRunningHubVideoConfig,
  readRunningHubVideoRequest, resolveConfiguredVideoApi, saveRunningHubVideoWorkflow,
  setActiveRunningHubVideoWorkflow, updateRunningHubVideoNodeValue, updateRunningHubVideoRequestField,
  validateRunningHubVideoWorkflow,
} from '../src/runningHubVideo';
import type { AppSettings, VideoTaskApiConfig } from '../src/types';
import type { RunningHubVideoConfig, RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';

let groups = 0;
const check = (name: string, fn: () => void) => { fn(); groups += 1; console.log(`PASS ${name}`); };
const nodes = [
  { nodeId: '137', fieldName: 'image', fieldValue: 'old-image.png', description: null },
  { nodeId: '138', fieldName: 'value', fieldValue: '原始完整剧情', description: null },
  { nodeId: '132', fieldName: 'value', fieldValue: '12', description: null },
  { nodeId: '115', fieldName: 'aspect_ratio', fieldData: '["COMBO", {"options":["16:9 (Widescreen)"]}]', fieldValue: '16:9 (Widescreen)', description: null },
  { nodeId: '115', fieldName: 'megapixels', fieldValue: '0.6000000000000001', description: null },
  { nodeId: '164', fieldName: 'audio', fieldValue: 'None', description: null },
  { nodeId: 'step', fieldName: 'value', fieldValue: 28 },
  { nodeId: 'bool', fieldName: 'value', fieldValue: false },
  { nodeId: 'opaque', fieldName: 'value', fieldValue: '{{prompt}} must stay {{duration}} and {{image_1}}' },
];
const body = JSON.stringify({ nodeInfoList: nodes, instanceType: 'default', usePersonalQueue: 'false', extra: { preserve: ['line', 0], text: 'Keep {{prompt}}' } }, null, 2);
const ready = (): RunningHubVideoWorkflow => ({
  ...createRunningHubVideoWorkflow('测试云端工作流'), remoteId: '2084261333662810113',
  requestTemplate: body.replace('"usePersonalQueue": "false"', '"usePersonalQueue": false'),
  outputNodeId: '999', mapping: { prompt: [{ nodeId: '138', inputName: 'value' }], images: [{ nodeId: '137', inputName: 'image', role: 'first-frame' }], parameters: { duration: { nodeId: '132', inputName: 'value' }, steps: { nodeId: 'step', inputName: 'value' }, enabled: { nodeId: 'bool', inputName: 'value' } } },
});
const configFor = (workflow: RunningHubVideoWorkflow): RunningHubVideoConfig => ({ ...structuredClone(defaultRunningHubVideoConfig), enabled: true, apiKey: 'test-key-never-export', activeWorkflowId: workflow.id, workflows: [workflow] });
const valueAt = (request: ReturnType<typeof readRunningHubVideoRequest>, nodeId: string, fieldName = 'value'): unknown => request.nodeInfoList.find((item) => item.nodeId === nodeId && item.fieldName === fieldName)?.fieldValue;

check('default / empty drafts are isolated and do not authorize a task', () => {
  const first = createRunningHubVideoWorkflow(); const second = createRunningHubVideoWorkflow();
  assert.notEqual(first.id, second.id); assert.equal(first.remoteId, '');
  assert.equal(isRunningHubVideoWorkflowReady(first), false);
  assert.equal(defaultRunningHubVideoConfig.enabled, false);
  assert.equal(readRunningHubVideoRequest(first.requestTemplate).retainSeconds, undefined);
  const normalized = normalizeRunningHubVideoConfig(undefined); normalized.workflows.push(first);
  assert.equal(defaultRunningHubVideoConfig.workflows.length, 0);
  assert.equal(normalizeRunningHubVideoConfig({ enabled: 'true' }).enabled, false);
});

check('pure JSON imports are inactive unmapped drafts; technical values remain exact', () => {
  const imported = importRunningHubVideoWorkflow(body, '请求 A');
  assert.equal(imported.workflow.name, '请求 A'); assert.deepEqual(imported.workflow.mapping, { prompt: [], images: [] });
  assert.equal(imported.workflow.remoteId, ''); assert.equal(isRunningHubVideoWorkflowReady(imported.workflow), false);
  const parsed = readRunningHubVideoRequest(imported.workflow.requestTemplate);
  assert.equal(parsed.usePersonalQueue, false); assert.equal(parsed.retainSeconds, undefined);
  assert.deepEqual(parsed.nodeInfoList, nodes); assert.deepEqual(parsed.extra, { preserve: ['line', 0], text: 'Keep {{prompt}}' });
  assert.ok(imported.warnings.some((item) => item.includes('没有自动猜测')));
  assert.ok(imported.warnings.some((item) => item.includes('云端 ID')));
  const array = importRunningHubVideoWorkflow(JSON.stringify(nodes));
  assert.deepEqual(readRunningHubVideoRequest(array.workflow.requestTemplate).nodeInfoList, nodes);
  assert.equal(readRunningHubVideoRequest(array.workflow.requestTemplate).instanceType, undefined);
});

check('cURL is parsed only, preserving long IDs and stripping authentication', () => {
  const text = `curl --location --request POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/2084261333662810113' \\\n--header 'Authorization: Bearer fixture-secret' \\\n--header 'Content-Type: application/json' \\\n--data-raw '${body}'`;
  const imported = importRunningHubVideoWorkflow(text);
  assert.equal(imported.workflow.remoteId, '2084261333662810113'); assert.equal(imported.workflow.runKind, 'ai-app');
  assert.equal(imported.baseUrl, 'https://www.runninghub.ai');
  assert.ok(imported.warnings.some((item) => item.includes('认证头')));
  assert.ok(!JSON.stringify(imported).includes('fixture-secret'));
  const workflowCurl = importRunningHubVideoWorkflow(text.replace('/ai-app/', '/workflow/'));
  assert.equal(workflowCurl.workflow.runKind, 'workflow');
  const fenced = importRunningHubVideoWorkflow(`请求示例\n\n\`\`\`curl\n${text}\n\`\`\``);
  assert.equal(fenced.workflow.remoteId, imported.workflow.remoteId);
  assert.throws(() => importRunningHubVideoWorkflow(`${text}; echo unwanted`), /不会执行/u);
  assert.throws(() => importRunningHubVideoWorkflow(`curl -X POST 'https://www.runninghub.ai/openapi/v2/query' -d '${body}'`), /提交示例/u);
  assert.throws(() => importRunningHubVideoWorkflow("curl -X POST 'https://www.runninghub.ai/openapi/v2/run/ai-app/123' --data-binary '@C:/secret.json'"), /不会读取/u);
  assert.throws(() => importRunningHubVideoWorkflow(text + " 'https://other.test/'"), /一条/u);
  assert.throws(() => importRunningHubVideoWorkflow(text.replace('POST', 'DELETE')), /POST/u);
});

check('import and export scrub embedded credential values including duplicates', () => {
  const withSecret = body.replace('"extra": {', '"apiKey": "body-secret", "headers": {"Authorization":"Bearer nested-secret"}, "extra": {');
  const imported = importRunningHubVideoWorkflow(withSecret);
  assert.ok(!imported.workflow.requestTemplate.includes('body-secret')); assert.ok(!imported.workflow.requestTemplate.includes('nested-secret'));
  assert.ok(imported.warnings.some((item) => item.includes('剥离')));
  const duplicate = importRunningHubVideoWorkflow(withSecret.replace('"apiKey": "body-secret"', '"apiKey": "body-secret", "apiKey": ""'));
  assert.ok(!duplicate.workflow.requestTemplate.includes('body-secret'));
  const nodeSecret = importRunningHubVideoWorkflow(JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'api_key', fieldValue: 'node-secret' }] }));
  assert.ok(!nodeSecret.workflow.requestTemplate.includes('node-secret'));
  const raw = { ...ready(), requestTemplate: withSecret };
  const exported = exportRunningHubVideoWorkflow({ ...raw, apiKey: 'extra-secret' } as RunningHubVideoWorkflow);
  assert.ok(!exported.includes('body-secret')); assert.ok(!exported.includes('extra-secret'));
  assert.throws(() => saveRunningHubVideoWorkflow(configFor(raw), raw), /内嵌密钥/u);
  assert.ok(validateRunningHubVideoWorkflow(raw).some((item) => item.includes('内嵌凭据')));
});

check('64-bit identifier tokens stay exact; unsafe arithmetic values never silently round', () => {
  const numericIds = '{"workflowId":2084261333662810113,"nodeInfoList":[{"nodeId":2084261333662810113,"fieldName":"value","fieldValue":"seed 9223372036854775807"}]}';
  const imported = importRunningHubVideoWorkflow(numericIds);
  assert.equal(imported.workflow.remoteId, '2084261333662810113'); assert.equal(imported.workflow.runKind, 'workflow');
  assert.equal(readRunningHubVideoRequest(imported.workflow.requestTemplate).nodeInfoList[0].nodeId, '2084261333662810113');
  assert.ok(imported.workflow.requestTemplate.includes('"workflowId":"2084261333662810113"'), 'known ID values are text, preserving exact source digits');
  assert.ok(!imported.warnings.some((item) => item.includes('安全范围')));
  const unsafe = { ...ready(), requestTemplate: ready().requestTemplate.replace('"fieldValue": 28', '"fieldValue": 9223372036854775807') };
  assert.ok(validateRunningHubVideoWorkflow(unsafe).some((item) => item.includes('安全范围')));
  assert.throws(() => compileRunningHubVideoApi(configFor(unsafe)), /安全范围/u);
  assert.ok(unsafe.requestTemplate.includes('9223372036854775807'));
});

check('workflow copies and saves never overwrite another workflow or auto-activate drafts', () => {
  const workflow = ready(); const original = structuredClone(workflow); const config = configFor(workflow); const before = structuredClone(config);
  const copy = copyRunningHubVideoWorkflow(workflow, '副本'); copy.mapping.images[0].role = 'last-frame';
  assert.notEqual(copy.id, workflow.id); assert.deepEqual(workflow, original);
  const added = saveRunningHubVideoWorkflow(config, copy); assert.equal(added.workflows.length, 2); assert.equal(added.activeWorkflowId, workflow.id);
  assert.deepEqual(config, before); assert.equal(added.apiKey, config.apiKey);
  const renamed = saveRunningHubVideoWorkflow(added, { ...copy, name: '副本改名' });
  assert.equal(renamed.workflows.length, 2); assert.equal(renamed.workflows[0].name, workflow.name); assert.equal(renamed.workflows[1].name, '副本改名');
  const active = setActiveRunningHubVideoWorkflow(renamed, copy.id); assert.equal(active.activeWorkflowId, copy.id);
  assert.equal(setActiveRunningHubVideoWorkflow({ ...active, enabled: false }, copy.id).enabled, false);
  assert.throws(() => setActiveRunningHubVideoWorkflow(renamed, 'missing'), /不存在/u);
  const draft = createRunningHubVideoWorkflow(); const withDraft = saveRunningHubVideoWorkflow(active, draft);
  assert.throws(() => setActiveRunningHubVideoWorkflow(withDraft, draft.id), /请填写/u);
  assert.throws(() => saveRunningHubVideoWorkflow(active, { ...copy, remoteId: '' }), /当前正在使用/u);
  const afterDelete = deleteRunningHubVideoWorkflow(withDraft, copy.id); assert.equal(afterDelete.activeWorkflowId, workflow.id);
  const afterLast = deleteRunningHubVideoWorkflow(afterDelete, workflow.id); assert.equal(afterLast.activeWorkflowId, null); assert.equal(afterLast.enabled, false); assert.equal(afterLast.workflows[0].id, draft.id);
});

check('readiness validates exact typed field mappings, not guessed node names', () => {
  const workflow = ready(); assert.deepEqual(validateRunningHubVideoWorkflow(workflow), []);
  const missing = { ...workflow, mapping: { prompt: [{ nodeId: 'wrong', inputName: 'value' }], images: [] } };
  assert.ok(validateRunningHubVideoWorkflow(missing).some((item) => item.includes('找不到')));
  const collision = { ...workflow, mapping: { prompt: [{ nodeId: '138', inputName: 'value' }], images: [{ nodeId: '138', inputName: 'value' }] } };
  assert.ok(validateRunningHubVideoWorkflow(collision).some((item) => item.includes('同一个')));
  const numberPrompt = { ...workflow, mapping: { prompt: [{ nodeId: 'step', inputName: 'value' }], images: [] } };
  assert.ok(validateRunningHubVideoWorkflow(numberPrompt).some((item) => item.includes('文本字段')));
  const duplicate = { ...workflow, requestTemplate: JSON.stringify({ nodeInfoList: [...nodes, nodes[1]] }) };
  assert.ok(validateRunningHubVideoWorkflow(duplicate).some((item) => item.includes('重复')));
  const rawDuplicate = { ...workflow, requestTemplate: workflow.requestTemplate.replace('"instanceType": "default"', '"instanceType": "default", "instanceType": "plus"') };
  assert.ok(validateRunningHubVideoWorkflow(rawDuplicate).some((item) => item.includes('重复')));
  assert.throws(() => readRunningHubVideoRequest('{"1":{"class_type":"LoadImage","inputs":{}}}'), /不是本地 ComfyUI/u);
});

check('single-field editors preserve original raw JSON and existing parameter types', () => {
  const template = ready().requestTemplate.replace('"fieldValue": 28', '"fieldValue": 9223372036854775807');
  const changed = updateRunningHubVideoRequestField(template, 'usePersonalQueue', true);
  assert.equal(changed, template.replace('"usePersonalQueue": false', '"usePersonalQueue": true'));
  const add = updateRunningHubVideoRequestField(changed, 'retainSeconds', 30); assert.equal(readRunningHubVideoRequest(add).retainSeconds, 30); assert.ok(add.includes('9223372036854775807'));
  const remove = updateRunningHubVideoRequestField(add, 'retainSeconds', undefined); assert.equal(readRunningHubVideoRequest(remove).retainSeconds, undefined); assert.ok(remove.includes('9223372036854775807'));
  const removeFirst = updateRunningHubVideoRequestField('{"retainSeconds":30,"nodeInfoList":[],"extra":5}', 'retainSeconds', undefined); assert.deepEqual(JSON.parse(removeFirst), { nodeInfoList: [], extra: 5 });
  const removeMiddle = updateRunningHubVideoRequestField('{"nodeInfoList":[],"retainSeconds":30,"extra":5}', 'retainSeconds', undefined); assert.deepEqual(JSON.parse(removeMiddle), { nodeInfoList: [], extra: 5 });
  assert.throws(() => updateRunningHubVideoRequestField(template, 'usePersonalQueue', 'false'), /布尔/u);
  assert.throws(() => updateRunningHubVideoRequestField(template, 'retainSeconds', 9), /10–180/u);
  assert.throws(() => updateRunningHubVideoRequestField(template, 'retainSeconds', 181), /10–180/u);
  assert.throws(() => updateRunningHubVideoRequestField(template, 'nodeInfoList', []), /快捷编辑/u);
  const duration = updateRunningHubVideoNodeValue(template, { nodeId: '132', inputName: 'value' }, '15');
  assert.equal(valueAt(readRunningHubVideoRequest(duration), '132'), '15'); assert.ok(duration.includes('9223372036854775807'));
  assert.equal(valueAt(readRunningHubVideoRequest(updateRunningHubVideoNodeValue(ready().requestTemplate, { nodeId: 'step', inputName: 'value' }, '32')), 'step'), 32);
  assert.equal(valueAt(readRunningHubVideoRequest(updateRunningHubVideoNodeValue(ready().requestTemplate, { nodeId: 'bool', inputName: 'value' }, 'true')), 'bool'), true);
  assert.throws(() => coerceRunningHubVideoNodeValue(['12', 0], 'text', '连线'), /不覆盖/u);
  assert.throws(() => coerceRunningHubVideoNodeValue(false, 'yes', '布尔'), /true \/ false/u);
  assert.throws(() => coerceRunningHubVideoNodeValue(1, '9223372036854775807', '种子'), /安全整数/u);
  assert.throws(() => coerceRunningHubVideoNodeValue('1', Number('9223372036854775807'), '文本种子'), /安全整数/u);
});

check('compiled cloud protocol keeps independent identity and exact explicit mappings', () => {
  const workflow = ready(); const config = configFor(workflow); const before = structuredClone(config);
  const api = compileRunningHubVideoApi(config, workflow.id, { duration: 15, steps: '30', enabled: 'true' });
  assert.equal(api.endpoint, 'https://www.runninghub.ai/openapi/v2/run/ai-app/2084261333662810113');
  assert.equal(api.runningHubAppId, workflow.remoteId); assert.deepEqual(api.runningHubOutputNodeIds, ['999']);
  assert.deepEqual(api.runningHubImageRoles, ['first-frame']); assert.equal(api.imageUploadUrlPath, 'data.fileName');
  assert.equal(api.imageUploadEndpoint, 'https://www.runninghub.ai/openapi/v2/media/upload/binary');
  assert.equal(api.statusEndpointTemplate, 'https://www.runninghub.ai/openapi/v2/query');
  assert.equal(api.apiKey, 'test-key-never-export'); assert.ok(!api.requestTemplate?.includes(api.apiKey));
  const compiled = readRunningHubVideoRequest(api.requestTemplate!);
  assert.equal(valueAt(compiled, '132'), '15'); assert.equal(valueAt(compiled, 'step'), 30); assert.equal(valueAt(compiled, 'bool'), true);
  assert.equal(valueAt(compiled, '138'), '{{prompt}}'); assert.equal(valueAt(compiled, '137', 'image'), '{{image_1}}');
  assert.equal(valueAt(compiled, 'opaque'), nodes[8].fieldValue); assert.equal(valueAt(compiled, '164', 'audio'), 'None');
  assert.equal(api.runningHubMappedFields?.find((item) => item.parameter === 'duration')?.originalValue, '12');
  assert.deepEqual(config, before);
  const workflowApi = compileRunningHubVideoApi(configFor({ ...workflow, runKind: 'workflow' }));
  assert.match(workflowApi.endpoint, /\/run\/workflow\/2084261333662810113$/u);
  assert.throws(() => compileRunningHubVideoApi(config, 'deleted'), /不会改用/u);
  assert.throws(() => compileRunningHubVideoApi({ ...config, activeWorkflowId: null }), /先选择/u);
  assert.throws(() => compileRunningHubVideoApi({ ...config, baseUrl: 'https://key:secret@www.runninghub.ai' }), /无内嵌凭据/u);
  assert.throws(() => compileRunningHubVideoApi({ ...config, baseUrl: 'https://www.runninghub.ai?apiKey=secret' }), /无内嵌凭据/u);
  assert.throws(() => compileRunningHubVideoApi(config, workflow.id, { seed: 42 }), /尚未绑定/u);
});

check('submit binder touches only mapped fields and respects fresh explicit task parameters', () => {
  const workflow = ready(); const api = compileRunningHubVideoApi(configFor(workflow), workflow.id, { duration: 15 });
  const bound = bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: '完整 AI 提示词\n不要改对白', parameters: { duration: 20, steps: 32, enabled: true } }, ['openapi/image.png']);
  const request = bound as ReturnType<typeof readRunningHubVideoRequest>;
  assert.equal(valueAt(request, '138'), '完整 AI 提示词\n不要改对白'); assert.equal(valueAt(request, '137', 'image'), 'openapi/image.png');
  assert.equal(valueAt(request, '132'), '20'); assert.equal(valueAt(request, 'step'), 32); assert.equal(valueAt(request, 'bool'), true);
  assert.equal(valueAt(request, 'opaque'), nodes[8].fieldValue); assert.deepEqual(request.extra, { preserve: ['line', 0], text: 'Keep {{prompt}}' });
  const resetDefaults = bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: '再次生成', parameters: {} }, ['openapi/image2.png']) as ReturnType<typeof readRunningHubVideoRequest>;
  assert.equal(valueAt(resetDefaults, '132'), '12', 'omitting an override uses workflow original default, not an old snapshot override');
  assert.equal(valueAt(resetDefaults, 'step'), 28); assert.equal(valueAt(resetDefaults, 'bool'), false);
  const noImages = bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: 'test', parameters: {} }, []) as ReturnType<typeof readRunningHubVideoRequest>;
  assert.equal(noImages.nodeInfoList.find((node) => node.nodeId === '137')?.fieldValue, '', 'unused image slots explicitly clear instead of inheriting cloud defaults');
  assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: 'test', parameters: {} }, ['one.png', 'two.png']), /数量/u);
  assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, [...api.runningHubMappedFields!, api.runningHubMappedFields![0]], { prompt: 'test', parameters: {} }, ['one.png']), /重复绑定/u);
  assert.throws(() => bindRunningHubVideoRequest(api.requestTemplate!, api.runningHubMappedFields!, { prompt: 'test', parameters: { unknown: 1 } }, ['one.png']), /尚未绑定/u);
});

check('backup roundtrip retains custom mappings/options while import assigns a fresh identity', () => {
  const workflow = ready(); workflow.requestTemplate = updateRunningHubVideoRequestField(workflow.requestTemplate, 'retainSeconds', 35);
  const exported = exportRunningHubVideoWorkflow(workflow); assert.ok(!exported.includes(configFor(workflow).apiKey));
  const imported = importRunningHubVideoWorkflow(exported).workflow;
  assert.notEqual(imported.id, workflow.id); assert.equal(imported.name, workflow.name); assert.equal(imported.remoteId, workflow.remoteId);
  assert.deepEqual(imported.mapping, workflow.mapping); assert.equal(imported.outputNodeId, workflow.outputNodeId);
  assert.equal(imported.requestTemplate, workflow.requestTemplate); assert.equal(isRunningHubVideoWorkflowReady(imported), true);
  const numericBackup = exported.replace('"remoteId": "2084261333662810113"', '"remoteId": 2084261333662810113');
  assert.equal(importRunningHubVideoWorkflow(numericBackup).workflow.remoteId, '2084261333662810113');
  assert.throws(() => importRunningHubVideoWorkflow(exported.replace('"version": 1', '"version": 99')), /备份版本/u);
});

check('normalization preserves separate copies and credential field without activating unknown selection', () => {
  const workflow = ready(); const raw = { ...configFor(workflow), workflows: [workflow, structuredClone(workflow)], activeWorkflowId: 'unknown' };
  const normalized = normalizeRunningHubVideoConfig(raw);
  assert.equal(normalized.workflows.length, 2); assert.notEqual(normalized.workflows[0].id, normalized.workflows[1].id);
  assert.equal(normalized.activeWorkflowId, null); assert.equal(normalized.apiKey, raw.apiKey);
  assert.deepEqual(normalized.workflows[0].mapping, workflow.mapping);
  normalized.workflows[0].mapping.prompt[0].nodeId = 'different'; assert.equal(workflow.mapping.prompt[0].nodeId, '138');
});

check('tutorial preset contains only technical defaults and never enables extra retention fees', () => {
  const preset = createRunningHubTutorialVideoWorkflow(); assert.equal(isRunningHubVideoWorkflowReady(preset), true);
  assert.equal(preset.remoteId, '2084261333662810113');
  const request = readRunningHubVideoRequest(preset.requestTemplate);
  assert.equal(request.usePersonalQueue, false); assert.equal(request.retainSeconds, undefined);
  assert.equal(valueAt(request, '138'), '{{prompt}}'); assert.equal(valueAt(request, '137', 'image'), '{{image_1}}');
  assert.ok(!preset.requestTemplate.includes('核心强制约束')); assert.ok(!preset.requestTemplate.includes('c16107b'));
  assert.equal(valueAt(request, '115', 'megapixels'), '0.6000000000000001');
});

check('connection resolution never falls back from a missing cloud or ordinary API selection', () => {
  const workflow = ready(); const ordinary = { enabled: false, endpoint: 'https://ordinary.test/run', apiKey: 'ordinary-key' } as VideoTaskApiConfig;
  const profile = { ...ordinary, id: 'profile-a', name: '普通连接', createdAt: 1, updatedAt: 1 };
  const settings = { runningHubVideo: configFor(workflow), videoTaskApi: ordinary, videoApiProfiles: [profile] } as AppSettings;
  assert.equal(resolveConfiguredVideoApi(settings, { runningHubWorkflowId: workflow.id, parameters: {} }).provider, 'runninghub');
  assert.equal(resolveConfiguredVideoApi(settings, { apiProfileId: profile.id, parameters: {} }).endpoint, ordinary.endpoint);
  assert.deepEqual(resolveConfiguredVideoApi(settings, { parameters: {} }), ordinary);
  assert.throws(() => resolveConfiguredVideoApi(settings, { runningHubWorkflowId: '__runninghub_unselected__', parameters: {} }), /不存在/u);
  assert.throws(() => resolveConfiguredVideoApi(settings, { apiProfileId: 'missing', parameters: {} }), /不存在/u);
  assert.throws(() => resolveConfiguredVideoApi({ ...settings, runningHubVideo: undefined }, { runningHubWorkflowId: workflow.id, parameters: {} }), /不存在/u);
});

console.log(`RunningHub video library regression passed (${groups} groups).`);
