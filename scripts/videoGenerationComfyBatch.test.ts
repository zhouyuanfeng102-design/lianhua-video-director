import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type {
  ComfyVideoWorkflowPreset,
  GeneratedMediaDownloadRequest,
  VideoBatchStartInput,
  VideoGenerationDesktop,
  VideoGenerationDraft,
} from '../src/videoGenerationTypes';

type DesktopRequest = Parameters<VideoGenerationDesktop['videoRequest']>[0];

const response = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
};

const workflow: ComfyVideoWorkflowPreset = {
  id: 'comfy-batch-workflow',
  name: '隔离 ComfyUI 批量工作流',
  workflowJson: JSON.stringify({
    '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'workflow prompt' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'workflow-first.png' } },
    '3': { class_type: 'LoadImage', inputs: { image: 'workflow-last.png' } },
    '9': { class_type: 'VHS_VideoCombine', inputs: { images: ['2', 0] } },
  }),
  mapping: {
    prompt: [{ nodeId: '1', inputName: 'value' }],
    images: [
      { nodeId: '2', inputName: 'image', role: 'first-frame' },
      { nodeId: '3', inputName: 'image', role: 'last-frame' },
    ],
    outputNodeId: '9',
  },
  createdAt: 1,
  updatedAt: 1,
};

const image = (id: string): ReferenceAsset => ({
  id,
  name: id,
  fileName: `${id}.png`,
  type: 'reference',
  role: 'composition',
  mediaType: 'image',
  dataUrl: `data:image/png;base64,${Buffer.from(id).toString('base64')}`,
  tags: ['isolated-comfy-batch-test'],
  createdAt: 1,
  updatedAt: 1,
});

const draft = (
  index: number,
  references: VideoGenerationDraft['references'],
): VideoGenerationDraft => ({
  name: `Comfy 批量 ${index}`,
  prompt: `comfy batch prompt ${index}`,
  backend: 'comfyui',
  workflowId: workflow.id,
  references,
  parameters: {},
  source: {
    storyboardId: `comfy-board-${index}`,
    sequencePlanId: 'comfy-plan',
    segmentId: `comfy-segment-${index}`,
    segmentIndex: index,
    language: 'zh',
    label: `Comfy 第 ${index} 段`,
  },
});

interface Harness {
  holder: { state: AppState };
  engine: VideoGenerationEngine;
  requests: DesktopRequest[];
  uploadedFileNames: string[];
  promptBodies: Array<Record<string, any>>;
}

const createHarness = (): Harness => {
  const initial = createInitialState();
  const project = {
    ...initial.project,
    id: 'isolated-comfy-batch-project',
    assets: [image('first-a'), image('last-a'), image('upload-fail'), image('first-c')],
    generationTasks: [],
  };
  const holder: { state: AppState } = {
    state: {
      ...initial,
      project,
      projects: [project],
      activeProjectId: project.id,
      settings: {
        ...initial.settings,
        // This suite isolates reference-slot/preparation behavior; remote
        // queue-cap safety is covered separately with held terminal statuses.
        videoExecutionMode: 'concurrent',
        videoExecutionConcurrency: 3,
        videoBackend: 'comfyui' as const,
        comfyuiVideo: {
          enabled: true,
          baseUrl: 'http://isolated-comfy.invalid:8188',
          apiKey: 'mock-only-key',
          promptPath: '/prompt',
          workflows: [workflow],
          activeWorkflowId: workflow.id,
        },
      },
    },
  };
  const requests: DesktopRequest[] = [];
  const uploadedFileNames: string[] = [];
  const promptBodies: Array<Record<string, any>> = [];
  const checkpoints = new Map<string, VideoGenerationTask>();
  const credentials = new Map<string, string>();
  let remoteIndex = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (payload) => {
      requests.push(payload);
      if (payload.url.endsWith('/upload/image')) {
        const file = payload.multipart?.files[0];
        assert.ok(file, 'ComfyUI upload uses multipart image bytes');
        uploadedFileNames.push(file.fileName);
        if (file.fileName.includes('upload-fail.png')) return response({ error: 'isolated upload failure' }, 500);
        return response({ name: `uploaded-${file.fileName}`, subfolder: 'batch-inputs' });
      }
      if (payload.url.endsWith('/prompt') && payload.method === 'POST') {
        const body = JSON.parse(payload.body || '{}') as Record<string, any>;
        promptBodies.push(body);
        remoteIndex += 1;
        return response({ prompt_id: `comfy-remote-${remoteIndex}` });
      }
      if (payload.url.includes('/history/')) return response({});
      if (payload.url.endsWith('/queue')) return response({ queue_pending: [], queue_running: [] });
      throw new Error(`unexpected mock request: ${payload.method || 'GET'} ${payload.url}`);
    },
    cancelVideoRequest: async () => true,
    watchVideoProgress: async () => {},
    unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => {
      if (apiKey) credentials.set(taskId, apiKey);
      else credentials.delete(taskId);
      return { persisted: true };
    },
    getVideoTaskCredential: async (taskId) => credentials.get(taskId) || null,
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => ({
      fileName: `${payload.fileName || 'mock-video'}.mp4`,
      relativePath: `video/${payload.fileName || 'mock-video'}.mp4`,
      checksum: `mock-${payload.requestId}`,
      sizeBytes: 1,
      mediaType: 'video',
      managed: true,
      missing: false,
      url: `lianhua-media://asset/${payload.requestId}.mp4`,
    }),
    readManagedImageDataUrl: async () => { throw new Error('this fixture uses isolated inline pixels'); },
    saveVideoTaskCheckpoint: async (task) => {
      checkpoints.set(task.id, structuredClone(task));
      return { persisted: true };
    },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(checkpoints.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => checkpoints.delete(taskId),
  };
  const engine = new VideoGenerationEngine({
    getState: () => holder.state,
    setState: (updater) => { holder.state = updater(holder.state); },
    persistState: async () => {},
    desktop,
    onRuntime: () => {},
    pollIntervalMs: 60_000,
  });
  return { holder, engine, requests, uploadedFileNames, promptBodies };
};

const inputFor = (projectId: string): VideoBatchStartInput => ({
  projectId,
  label: '隔离 ComfyUI 批量测试',
  concurrency: 1,
  items: [
    {
      itemKey: 'comfy-board-1:zh',
      draft: draft(1, [
        { assetId: 'first-a', role: 'first-frame' },
        { assetId: 'last-a', role: 'last-frame' },
      ]),
    },
    {
      itemKey: 'comfy-board-2:zh',
      draft: draft(2, [{ assetId: 'upload-fail', role: 'first-frame' }]),
    },
    {
      itemKey: 'comfy-board-3:zh',
      draft: draft(3, [{ assetId: 'first-c', role: 'first-frame' }]),
    },
  ],
});

// Physical workflow roles are informational. A segment may assign another
// purpose in its picker; the warning must not block upload or /prompt.
{
  const harness = createHarness();
  harness.holder.state.settings.comfyuiVideo!.workflows = [{ ...structuredClone(workflow),
    mapping: { ...workflow.mapping, images: [{ nodeId: '2', inputName: 'image', role: 'character' }, workflow.mapping.images[1]] },
  }];
  const invalid = inputFor(harness.holder.state.project.id);
  invalid.items = [invalid.items[0]];
  invalid.items[0].draft.references[0].role = 'character';
  invalid.items[0].draft.references[1].role = 'composition';
  const started = await harness.engine.startBatch(invalid);
  assert.equal(started.taskIds.length, 1);
  await waitFor(() => harness.promptBodies.length === 1, 'a role mismatch must still reach ComfyUI /prompt');
  assert.match(harness.promptBodies[0].prompt['2'].inputs.image, /first-a\.png$/u);
  assert.match(harness.promptBodies[0].prompt['3'].inputs.image, /last-a\.png$/u);
  harness.engine.dispose();
}

// Every row gets its own upload bytes and a freshly cloned workflow. A failed
// row stops before /prompt, while the next row still submits normally.
{
  const harness = createHarness();
  const started = await harness.engine.startBatch(inputFor(harness.holder.state.project.id));
  assert.equal(started.taskIds.length, 3);
  await waitFor(() => harness.promptBodies.length === 2, 'later ComfyUI row did not continue after an isolated upload failure');
  const tasks = () => harness.holder.state.project.generationTasks as VideoGenerationTask[];
  await waitFor(() => tasks().some((task) => task.segmentIndex === 2 && task.status === 'failed'), 'failed upload row was not retained');

  assert.equal(harness.uploadedFileNames.length, 4, '2 + 1 failed + 1 later image are uploaded independently');
  assert.ok(harness.uploadedFileNames[0].includes('first-a.png'));
  assert.ok(harness.uploadedFileNames[1].includes('last-a.png'));
  assert.ok(harness.uploadedFileNames[2].includes('upload-fail.png'));
  assert.ok(harness.uploadedFileNames[3].includes('first-c.png'));

  const first = harness.promptBodies.find((body) => body.prompt?.['1']?.inputs?.value === 'comfy batch prompt 1');
  const third = harness.promptBodies.find((body) => body.prompt?.['1']?.inputs?.value === 'comfy batch prompt 3');
  assert.ok(first && third, 'only the first and third rows reach ComfyUI /prompt');
  assert.match(first.prompt['2'].inputs.image, /first-a\.png$/u);
  assert.match(first.prompt['3'].inputs.image, /last-a\.png$/u);
  assert.match(third.prompt['2'].inputs.image, /first-c\.png$/u);
  assert.equal(third.prompt['3'].inputs.image, 'workflow-last.png', 'the third row never inherits the first row last-frame binding');
  assert.equal(harness.promptBodies.some((body) => body.prompt?.['1']?.inputs?.value === 'comfy batch prompt 2'), false);
  assert.equal(tasks().find((task) => task.segmentIndex === 2)?.videoJob?.batchQueueState, 'done');
  await waitFor(() => Boolean(tasks().find((task) => task.segmentIndex === 3)?.remoteTaskId), 'later row was not acknowledged');
  harness.engine.dispose();
}

console.log('ComfyUI batch mock tests passed: atomic role preflight, per-row uploads, isolated slots and failure continuation');
