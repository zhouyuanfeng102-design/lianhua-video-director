import assert from 'node:assert/strict';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, VideoGenerationTask } from '../src/types';
import type { ComfyVideoWorkflowPreset, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

// All pixels, storage and transport are synthetic. No real HTTP or model call
// is reachable, and this check makes no assertions about hashes/fingerprints.
globalThis.fetch = async () => { throw new Error('Unexpected real network in ComfyUI selection transport fixture'); };
const baseUrl = 'https://comfy-selection.fixture.invalid';
const pixels = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNI8AAAAASUVORK5CYII=';
const expression = 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17';
const workflow: ComfyVideoWorkflowPreset = {
  id: 'h3-selection-transport', name: 'H3 synthetic selection transport', createdAt: 1, updatedAt: 1,
  workflowJson: JSON.stringify({
    text: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'original prompt' } },
    imageA: { class_type: 'LoadImage', inputs: { image: 'author-a.png' } },
    imageB: { class_type: 'LoadImage', inputs: { image: 'None' } },
    imageC: { class_type: 'LoadImage', inputs: { image: 'author-c.png' } },
    '259': { class_type: 'PrimitiveFloat', inputs: { value: 12 } },
    '250': { class_type: 'ComfyMathExpression', inputs: { expression, 'values.a': ['259', 0] } },
    '265': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {
      prompt: ['text', 0], length: ['250', 1],
      'ref_images.ref_image_0': ['imageA', 0],
      'ref_images.ref_image_1': ['imageB', 0],
      'ref_images.ref_image_2': ['imageC', 0],
    } },
    output: { class_type: 'VHS_VideoCombine', inputs: { images: ['265', 1], frame_rate: 24, format: 'video/h264-mp4' } },
  }),
  mapping: {
    prompt: [{ nodeId: 'text', inputName: 'value' }],
    images: ['imageA', 'imageB', 'imageC'].map((nodeId) => ({ nodeId, inputName: 'image' })),
    parameters: {}, outputNodeId: 'output',
  },
};
const draft: VideoGenerationDraft = {
  name: 'H3 local transport fixture', backend: 'comfyui', workflowId: workflow.id,
  origin: 'custom', promptMode: 'raw', prompt: 'Keep this custom prompt exactly.',
  references: [{ assetId: 'selected-image', role: 'general', slotIndex: 1 }],
  parameters: { duration: 8 },
};
type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const harness = () => {
  const holder = {
    state: createInitialState(), posts: [] as Request[], uploads: [] as Request[],
    journal: new Map<string, VideoGenerationTask>(), files: new Map<string, string>(), frozenWrites: 0,
  };
  holder.state.settings.comfyuiVideo = {
    enabled: true, baseUrl, apiKey: '', workflows: [structuredClone(workflow)], activeWorkflowId: workflow.id,
  };
  holder.state.project.assets = [{
    id: 'selected-image', name: 'Synthetic selected image', type: 'reference', role: 'composition',
    dataUrl: pixels, fileName: 'selected.png', tags: [], createdAt: 1, updatedAt: 1,
  }];
  holder.state.projects = [holder.state.project];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      assert.ok(request.url.startsWith(`${baseUrl}/`), 'transport uses only the frozen synthetic endpoint');
      if (request.url.endsWith('/upload/image')) {
        holder.uploads.push(request);
        assert.equal(request.multipart?.files.length, 1);
        assert.equal(request.multipart.files[0].dataUrl, pixels);
        return response({ name: 'selected-upload.png', subfolder: 'fixture' });
      }
      if (request.url.endsWith('/prompt')) {
        holder.posts.push(request);
        // Exercise the complete request path, then terminate locally without
        // creating a remote task, polling, downloading or generating media.
        return response({ node_errors: { fixture: { errors: [{ message: 'Synthetic terminal fixture response' }] } } });
      }
      throw new Error(`Unexpected mocked ComfyUI endpoint ${request.url}`);
    },
    cancelVideoRequest: async () => true,
    watchVideoProgress: async () => {},
    unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }),
    getVideoTaskCredential: async () => null,
    saveVideoTaskCheckpoint: async (task) => { holder.journal.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(holder.journal.get(taskId) || null),
    deleteVideoTaskCheckpoint: async (taskId) => holder.journal.delete(taskId),
    storeGeneratedImage: async ({ dataUrl, fileName }) => {
      holder.frozenWrites += 1;
      holder.files.set('image/selected.png', dataUrl);
      return {
        relativePath: 'image/selected.png', checksum: 'synthetic-storage-receipt', fileName: fileName || 'selected.png',
        mediaType: 'image', sizeBytes: 68, managed: true, missing: false, url: 'lianhua-asset://local/image/selected.png',
      };
    },
    readManagedImageDataUrl: async ({ relativePath }) => {
      const dataUrl = holder.files.get(relativePath);
      assert.ok(dataUrl, 'submission reads the synthetic frozen image');
      return { dataUrl };
    },
    downloadGeneratedMedia: async () => { throw new Error('The synthetic rejection has no generated media'); },
  };
  const options = {
    getState: () => holder.state,
    setState: (updater: (state: AppState) => AppState) => { holder.state = updater(holder.state); },
    desktop, onRuntime: () => {}, persistState: async () => {}, pollIntervalMs: 60_000,
  };
  return { holder, options, engine: new VideoGenerationEngine(options) };
};
const submittedGraph = (request: Request) => JSON.parse(request.body || '{}').prompt as Record<string, { inputs: Record<string, unknown> }>;
const imageFields = (graph: ReturnType<typeof submittedGraph>) => Object.keys(graph['265'].inputs).filter((name) => name.startsWith('ref_images.'));

{
  const h = harness();
  const originalSettings = structuredClone(h.holder.state.settings.comfyuiVideo);
  try {
    const taskId = await h.engine.start(structuredClone(draft));
    const task = h.holder.state.project.generationTasks.find((entry) => entry.id === taskId) as VideoGenerationTask;
    assert.equal(h.holder.posts.length, 1, 'one start produces one mocked generation POST');
    assert.equal(h.holder.uploads.length, 1, 'only the selected reference is uploaded');
    assert.ok(h.holder.frozenWrites > 0, 'the actual engine froze the image before upload');
    const graph = submittedGraph(h.holder.posts[0]);
    assert.deepEqual(imageFields(graph), ['ref_images.ref_image_1']);
    assert.deepEqual(graph['265'].inputs['ref_images.ref_image_1'], ['imageB', 0]);
    assert.equal(graph.imageB.inputs.image, 'fixture/selected-upload.png');
    assert.equal(graph['259'].inputs.value, 8, 'the inferred seconds input receives the task duration');
    assert.equal(graph['250'].inputs.expression, expression, 'the workflow keeps its own seconds-to-frames calculation');
    assert.deepEqual(graph['265'].inputs.length, ['250', 1], 'frame-count wiring remains intact');
    assert.equal(graph.text.inputs.value, draft.prompt, 'custom raw prompt remains unchanged');
    assert.equal(task.videoJob!.snapshot.connection.workflow!.mapping.h3ReferenceSelection, 'selected');
    assert.equal(task.videoJob!.snapshot.images[0].freezeState, 'frozen');
    assert.equal(task.status, 'failed', 'the synthetic response settles this fixture without remote generation');
    assert.deepEqual(h.holder.state.settings.comfyuiVideo, originalSettings, 'task creation leaves saved settings and mapping intact');
  } finally { h.engine.dispose(); }
}

{
  const h = harness();
  const legacy: VideoGenerationTask = {
    id: 'legacy-preparing-h3-selection', kind: 'video', storyboardId: '', targetId: workflow.name,
    status: 'failed', createdAt: 1, updatedAt: 1, requestBody: {},
    videoJob: {
      stage: 'preparing', trackingStopped: true,
      preparation: { version: 1, phase: 'preparing', uploadedImages: [] },
      snapshot: {
        projectId: h.holder.state.project.id, clientId: 'legacy-client',
        draft: structuredClone(draft),
        connection: {
          backend: 'comfyui', comfyui: { enabled: true, baseUrl }, workflow: structuredClone(workflow),
        },
        images: [{
          assetId: 'selected-image', role: 'general', slotIndex: 1, name: 'Synthetic legacy image',
          fileName: 'selected.png', dataUrl: pixels, freezeState: 'pending',
        }],
      },
    },
  };
  const originalLegacyWorkflow = structuredClone(legacy.videoJob!.snapshot.connection.workflow);
  h.holder.state.project.generationTasks = [structuredClone(legacy)];
  h.holder.state.projects = [h.holder.state.project];
  h.holder.journal.set(legacy.id, structuredClone(legacy));
  try {
    await h.engine.resume(legacy.id);
    assert.equal(h.holder.posts.length, 1, 'an explicitly resumed pre-POST legacy task submits once');
    assert.equal(h.holder.uploads.length, 1);
    const graph = submittedGraph(h.holder.posts[0]);
    assert.deepEqual(imageFields(graph), ['ref_images.ref_image_0', 'ref_images.ref_image_1', 'ref_images.ref_image_2'],
      'a legacy snapshot without a policy keeps its original connected reference defaults');
    assert.equal(graph.imageA.inputs.image, 'author-a.png');
    assert.equal(graph.imageC.inputs.image, 'author-c.png');
    assert.equal(graph.imageB.inputs.image, 'fixture/selected-upload.png');
    assert.equal(graph['259'].inputs.value, 8);
    assert.equal(graph['250'].inputs.expression, expression);
    const task = h.holder.state.project.generationTasks.find((entry) => entry.id === legacy.id) as VideoGenerationTask;
    assert.deepEqual(task.videoJob!.snapshot.connection.workflow, originalLegacyWorkflow,
      'legacy compatibility changes only the local request copy, not the original frozen workflow');
    assert.equal(task.status, 'failed');
  } finally { h.engine.dispose(); }
}

console.log('ComfyUI selected-image start/freeze/upload/POST and legacy queued-snapshot transport checks passed; zero real API calls.');
