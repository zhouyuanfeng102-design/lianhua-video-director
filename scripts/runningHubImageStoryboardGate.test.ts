import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { importRunningHubImageWorkflow } from '../src/runningHubImage';
import { createStoryboardImageBatchLifecycle } from '../src/storyboardImages';
import { generateDirectStoryboardImages, type DirectStoryboardImageGenerationContext } from '../src/storyboardImageToImageGeneration';
import type { AppState, ImageApiConfig, Storyboard } from '../src/types';

// Fail-fast tests for the billable text/model boundary. Every transport and
// media helper is a rejecting mock, so a late gate cannot hide an extra call.
const cloudConfig = (): ImageApiConfig => {
  const imported = importRunningHubImageWorkflow(JSON.stringify({
    endpoint: 'https://www.runninghub.ai/openapi/v2/run/ai-app/2070152175753453569',
    nodeInfoList: [
      { nodeId: '95', fieldName: 'width', fieldValue: 1920, description: 'width' },
      { nodeId: '96', fieldName: 'height', fieldValue: 1280, description: 'height' },
      { nodeId: '115', fieldName: 'prompt', fieldValue: 'synthetic business input' },
      { nodeId: 'image-a', fieldName: 'image', fieldValue: '' },
    ],
  }));
  imported.workflow.mapping.images = [{ nodeId: 'image-a', inputName: 'image', role: 'general' }];
  return { enabled: true, backend: 'runninghub', baseUrl: 'https://www.runninghub.ai', apiKey: 'SYNTHETIC_KEY', model: 'Krea2',
    runningHubWorkflows: [imported.workflow], activeRunningHubWorkflowId: imported.workflow.id };
};
const board = (): Storyboard => ({
  id: 'synthetic-board', chapterId: 'synthetic-chapter', sceneId: '', sourceStoryContent: '旅人沿河岸前行。',
  workflow: 'drama', inputMode: 'reference', durationSec: 15, durationPreset: '15s', shotMode: 'auto', pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'fixture', ruleSetId: 'fixture', converterPresetId: 'fixture',
  globalLock: '', finalPrompt: '【0s-15s】主体：旅人；动作：沿河岸前行；镜头：固定中景',
  shots: [{ id: 'synthetic-shot', index: 1, startSec: 0, endSec: 15, purpose: '前行', subject: '旅人', action: '前行',
    camera: '中景', transition: 'cut', lighting: '自然光', sound: '无', result: '继续前行', prompt: '前行', locked: false, referenceAssetIds: [] }],
  imageToImage: { referenceAssetIds: ['synthetic-reference'], selectedShotIds: ['synthetic-shot'], referenceAssetIdsByShotId: {} },
  createdAt: 1, updatedAt: 1,
});
const checks: Array<{ label: string; mutate: (config: ImageApiConfig) => void; reason: RegExp }> = [
  { label: 'missing image API key', mutate: (config) => { config.apiKey = ''; }, reason: /密钥/u },
  { label: 'deleted active workflow', mutate: (config) => { config.activeRunningHubWorkflowId = 'deleted'; }, reason: /输入槽|工作流/u },
  { label: 'missing business prompt mapping', mutate: (config) => { config.runningHubWorkflows![0].mapping.prompt = []; }, reason: /提示词/u },
  { label: 'selected references exceed declared image capacity', mutate: (config) => { config.runningHubWorkflows![0].mapping.images = []; }, reason: /输入槽.*不会忽略/u },
];
for (const check of checks) {
  const api = cloudConfig(); check.mutate(api);
  const initial = createInitialState();
  const project = { ...initial.project, id: 'synthetic-project', storyboards: [board()], generationTasks: [], assets: [] };
  let state: AppState = { ...initial, project, projects: [project], activeProjectId: project.id,
    settings: { ...initial.settings, imageApi: api, imageApiProfiles: [], activeImageApiProfileId: null,
      textApi: { ...initial.settings.textApi, enabled: true, baseUrl: 'https://text.invalid', model: 'synthetic-text', apiKey: 'SYNTHETIC_TEXT_KEY' } } };
  const before = structuredClone(state.project);
  let downstreamCalls = 0;
  const forbidden = async (): Promise<never> => { downstreamCalls += 1; throw new Error('A transport/media helper must not run before configuration validation'); };
  const notices: string[] = [];
  const context: DirectStoryboardImageGenerationContext = {
    getState: () => state, update: (updater) => { state = updater(state); }, updateBackground: (updater) => { state = updater(state); },
    lifecycle: createStoryboardImageBatchLifecycle(), loader: { readManagedImageDataUrl: forbidden },
    storeImage: forbidden, generateImage: forbidden, convertPrompt: forbidden, requestText: forbidden, planFrames: forbidden,
    notify: (message) => notices.push(message), reportError: () => undefined,
  };
  await generateDirectStoryboardImages(context, project.id, 'synthetic-board', { mode: 'storyboard-shots', count: 2 });
  assert.equal(downstreamCalls, 0, `${check.label} stops before planning, conversion, reference loading or generation`);
  assert.ok(notices.some((message) => check.reason.test(message)), `${check.label} provides the configuration reason`);
  assert.deepEqual(state.project, before, 'a rejected preflight creates no tasks and preserves existing data');
  console.log(`PASS ${check.label} rejects before all billable work`);
}
console.log(`RunningHub storyboard preflight: ${checks.length} targeted offline checks passed.`);
