import assert from 'node:assert/strict';
import { buildVideoPromptExecutionContext } from '../src/videoPromptExecutionContext';
import { videoApiCapabilityScope } from '../src/videoApiCapabilities';
import { renderH3ReferenceExecution } from '../src/h3ReferenceExecution';
import { H3_PERFORMANCE_DELIVERY_RULE } from '../src/h3IdentityBindings';
import { H3_EXISTING_SOUND_SUMMARY_EN, H3_EXISTING_SOUND_SUMMARY_ZH } from '../src/h3DeliverySections';
import type { VideoTaskApiConfig, H3IdentityBindings } from '../src/types';

const config: VideoTaskApiConfig = {
  enabled: true, provider: 'generic', model: 'MiniMax-H3',
  baseUrl: 'https://secret-host.invalid/private?token=url-secret',
  endpoint: 'https://secret-host.invalid/v1/videos?key=endpoint-secret',
  statusEndpointTemplate: 'https://secret-host.invalid/status/{id}?key=status-secret',
  apiKey: 'private-api-secret', authHeader: 'Private-Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url',
};
let count = 0;
const test = (name: string, run: () => void) => { run(); console.log(`PASS ${++count} ${name}`); };

test('execution facts exclude credentials, addresses, arbitrary task values and private templates', () => {
  const api = { ...config, requestTemplate: '{"private":"template-secret"}' };
  const before = structuredClone(api);
  const context = buildVideoPromptExecutionContext({ backend: 'api', api,
    parameters: { seed: 'parameter-secret', private_url: 'https://parameter-secret.invalid' } });
  assert.equal(context.provider, 'generic');
  assert.equal(context.model, 'MiniMax-H3');
  assert.equal(context.modelSource, 'configured-model');
  assert.equal(context.generationMode, 'unknown');
  assert.equal(context.referenceInputs.images.source, 'unknown');
  assert.doesNotMatch(JSON.stringify(context), /secret|https?:|apiKey|endpoint|authHeader|requestTemplate|parameter/u);
  assert.deepEqual(api, before);
});

test('RunningHub names and image roles never fabricate Ref2VA or motion-video conditioning', () => {
  const context = buildVideoPromptExecutionContext({ backend: 'api', api: { ...config, provider: 'runninghub',
    model: 'H3 Ref2VA BF16 50 steps 动作参考', runningHubImageRoles: ['motion', 'character'],
    runningHubMappedFields: [
      { kind: 'image', nodeId: '1', fieldName: 'image', imageIndex: 0 },
      { kind: 'image', nodeId: '2', fieldName: 'image', imageIndex: 1 },
      { kind: 'audio', nodeId: '3', fieldName: 'audio', audioIndex: 0 },
    ] } });
  assert.equal(context.modelSource, 'workflow-label');
  assert.equal(context.generationMode, 'unknown');
  assert.equal(context.workflowInternals, 'unknown');
  assert.deepEqual(context.referenceInputs.images, { source: 'configured-mapping', maxCount: 2, roles: ['motion', 'character'] });
  assert.equal(context.referenceInputs.audios.maxCount, 1);
  assert.equal(context.referenceInputs.videos.source, 'unknown');
});

test('Comfy uses only explicit mappings and does not read graph nodes or inactive API settings', () => {
  const workflow = { id: 'private-id', name: 'H3 first-last workflow',
    workflowJson: '{"secret":"private-graph-secret","checkpoint":"inferred-model"}',
    mapping: { prompt: [{ nodeId: '8', inputName: 'text' }], images: [{ nodeId: '9', inputName: 'image', role: 'first-frame' as const }] } };
  const context = buildVideoPromptExecutionContext({ backend: 'comfyui', api: config, workflow });
  assert.equal(context.provider, 'comfyui');
  assert.equal(context.model, undefined);
  assert.equal(context.workflowLabel, workflow.name);
  assert.equal(context.generationMode, 'unknown');
  assert.equal(context.referenceInputs.images.maxCount, 1);
  assert.doesNotMatch(JSON.stringify(context), /secret|inferred-model|nodeId|private-id|https?:/u);
});

test('only explicit selected rhTV mode changes the known mode facts', () => {
  const api: VideoTaskApiConfig = { ...config, provider: 'rhtv_web', rhtvMode: 'reference' };
  const context = buildVideoPromptExecutionContext({ backend: 'api', api, parameters: { rhtv_mode: 'first_last' } });
  assert.equal(context.generationMode, 'first_last');
  assert.deepEqual(context.referenceInputs.images, { source: 'adapter-inputs', maxCount: 2, roles: ['first-frame', 'last-frame'] });
  assert.equal(api.rhtvMode, 'reference');
  assert.equal(buildVideoPromptExecutionContext({ backend: 'api' }).generationMode, 'unknown');
});

test('saved API image capacity stays scoped and does not imply motion-reference support', () => {
  const api: VideoTaskApiConfig = { ...config, parameterCapabilities: {
    scope: videoApiCapabilityScope(config), source: 'models', sourceUrl: 'https://capability-secret.invalid', fetchedAt: 1,
    models: { 'MiniMax-H3': { controls: {}, defaults: {}, imageReferences: { maxCount: 7, source: 'models' } } },
  } };
  const context = buildVideoPromptExecutionContext({ backend: 'api', api });
  assert.deepEqual(context.referenceInputs.images, { source: 'saved-api-capability', maxCount: 7 });
  assert.equal(context.referenceInputs.videos.source, 'unknown');
  assert.doesNotMatch(JSON.stringify(context), /secret|https?:/u);
  const stale = buildVideoPromptExecutionContext({ backend: 'api', api: { ...api, baseUrl: 'https://different.invalid' } });
  assert.equal(stale.referenceInputs.images.source, 'unknown');
});

test('real video inputs are reported only from mappings or explicit template placeholders', () => {
  const runningHub = buildVideoPromptExecutionContext({ backend: 'api', api: { ...config, provider: 'runninghub',
    runningHubMappedFields: [{ kind: 'video', nodeId: 'private-video-node', fieldName: 'video', videoIndex: 0 }] } });
  assert.deepEqual(runningHub.referenceInputs.videos, { source: 'configured-mapping', configuredSlotCount: 1 });
  assert.equal(runningHub.generationMode, 'unknown');
  const template = buildVideoPromptExecutionContext({ backend: 'api', api: { ...config,
    requestTemplate: '{"videos":"{{videos}}","url":"https://template-secret.invalid"}' } });
  assert.deepEqual(template.referenceInputs.videos, { source: 'request-template', configuredSlotCount: 1 });
  assert.equal(template.referenceInputs.videos.maxCount, undefined, 'a mapped array does not establish a model maximum');
  assert.doesNotMatch(JSON.stringify([runningHub, template]), /private-video-node|template-secret|https?:/u);
  const comfy = buildVideoPromptExecutionContext({ backend: 'comfyui', workflow: { id: 'a', name: 'A',
    mapping: { prompt: [], images: [], videos: [{ nodeId: '1', inputName: 'video' }] } } });
  assert.deepEqual(comfy.referenceInputs.videos, { source: 'configured-mapping', configuredSlotCount: 1 });
});

test('legacy reference rendering restores a scope summary while preserving local sounds and authored music', () => {
  const anchor = '甲是穿蓝衣的成年女性。';
  const identities: H3IdentityBindings = { version: 1, characters: [{ characterId: 'a', name: '甲', referenceAnchor: anchor }] };
  const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchor}甲迈一步，鞋底落地。<sound>一次短促脚步声。</sound>\nnon_diegetic_music:\n已确认轻柔弦乐，结尾淡出。`;
  for (const language of ['zh', 'en'] as const) {
    const result = renderH3ReferenceExecution({ prompt, identities, characterPictures: new Map([['a', [1]]]), language });
    assert.ok(result);
    assert.ok(result.prompt.includes(language === 'en' ? H3_EXISTING_SOUND_SUMMARY_EN : H3_EXISTING_SOUND_SUMMARY_ZH));
    assert.ok(result.prompt.includes('<sound>一次短促脚步声。</sound>'));
    assert.match(result.prompt, /non_diegetic_music:\n已确认轻柔弦乐，结尾淡出。/u);
    assert.doesNotMatch(result.prompt, /overall_soundscape:\s*N\/A/u);
  }
  const silent = prompt.replace('non_diegetic_music:', 'overall_soundscape:\nN/A\n\nnon_diegetic_music:');
  const preserved = renderH3ReferenceExecution({ prompt: silent, identities, characterPictures: new Map([['a', [1]]]) });
  assert.match(preserved!.prompt, /overall_soundscape:\nN\/A/u, 'reference-only updates preserve an existing explicit sound choice');
  assert.doesNotMatch(H3_PERFORMANCE_DELIVERY_RULE, /没有相应内容写N\/A/u);
  assert.match(H3_PERFORMANCE_DELIVERY_RULE, /只有明确全片完全静音时才写N\/A/u);
  assert.match(H3_PERFORMANCE_DELIVERY_RULE, /不.*覆盖历史音乐/u);
});

console.log(`video prompt execution context: ${count} groups passed`);
