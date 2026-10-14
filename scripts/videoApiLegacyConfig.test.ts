import assert from 'node:assert/strict';
import { hasObsoleteVideoFileMapping, repairLegacyVideoApiConfig, videoApiFileQueryEndpoint } from '../src/videoApiLegacyConfig';
import { createInitialState, normalizeState } from '../src/storage';
import { defaultMiniMaxVideoApi } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoDesktopRequest, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const contaminated: VideoTaskApiConfig = {
  ...createInitialState().settings.videoTaskApi, enabled: true, provider: 'generic', baseUrl: 'https://video.example.invalid',
  model: 'chosen-video-model', apiKey: 'frozen-synthetic-key', taskIdPath: 'task_id', fileIdPath: 'file_id',
  fileEndpointTemplate: defaultMiniMaxVideoApi.fileEndpointTemplate, fileUrlPath: 'file.download_url',
};
const clean = repairLegacyVideoApiConfig(contaminated);
assert.equal(hasObsoleteVideoFileMapping(contaminated), true);
assert.notEqual(clean, contaminated);
assert.equal(clean.fileEndpointTemplate, undefined);
assert.equal(clean.fileIdPath, undefined);
assert.equal(clean.fileUrlPath, undefined);
assert.equal(clean.apiKey, contaminated.apiKey);
assert.equal(clean.model, contaminated.model);
assert.equal(clean.taskIdPath, contaminated.taskIdPath, 'repair does not guess user response paths');
assert.equal(videoApiFileQueryEndpoint(contaminated), '');
assert.equal(repairLegacyVideoApiConfig(clean), clean, 'repair is idempotent');
for (const unaffected of [
  defaultMiniMaxVideoApi,
  { ...contaminated, baseUrl: 'https://api.minimaxi.com' },
  { ...contaminated, requestTemplate: '{"custom":"{{prompt}}"}' },
  { ...contaminated, endpoint: 'https://video.example.invalid/custom-submit' },
  { ...contaminated, fileEndpointTemplate: 'https://custom-files.example.invalid/files/{id}' },
  { ...contaminated, fileUrlPath: 'custom.url' },
  { ...contaminated, baseUrl: undefined },
]) {
  assert.equal(repairLegacyVideoApiConfig(unaffected), unaffected, 'other providers and custom mappings remain unchanged');
  assert.equal(videoApiFileQueryEndpoint(unaffected), unaffected.fileEndpointTemplate || '');
}
const saved = createInitialState();
saved.settings.videoTaskApi = contaminated;
saved.settings.videoApiProfiles = [{ ...contaminated, id: 'saved-connection', name: '已保存连接', createdAt: 1, updatedAt: 2 }];
const restored = normalizeState(saved);
assert.equal(restored.settings.videoTaskApi.fileEndpointTemplate, undefined);
assert.equal(restored.settings.videoApiProfiles![0].fileEndpointTemplate, undefined);
assert.equal(restored.settings.videoApiProfiles![0].id, 'saved-connection');
assert.equal(restored.settings.videoApiProfiles![0].updatedAt, 2);
assert.equal(saved.settings.videoTaskApi.fileEndpointTemplate, defaultMiniMaxVideoApi.fileEndpointTemplate, 'incoming state is not mutated');

// A frozen affected task must continue querying its own service, never the
// former provider, even if its former response contained a file-only result.
let state: AppState = createInitialState();
state.settings.videoTaskApi = contaminated;
const vault = new Map<string, string>();
const requests: VideoDesktopRequest[] = [];
let queries = 0;
let restoredRun = false;
const desktop = {
  setVideoTaskCredential: async ({ taskId, apiKey }: { taskId: string; apiKey: string }) => { vault.set(taskId, apiKey); return { persisted: true }; },
  getVideoTaskCredential: async (taskId: string) => vault.get(taskId) || null,
  videoRequest: async (payload: VideoDesktopRequest) => {
    requests.push(payload);
    assert.equal(new URL(payload.url).origin, 'https://video.example.invalid', 'never send the frozen key to the previous service');
    assert.equal(payload.headers?.Authorization, 'Bearer frozen-synthetic-key');
    if (payload.method === 'POST') {
      assert.equal(restoredRun, false, 'resuming cannot create a new task');
      return { status: 200, body: JSON.stringify({ id: 'original-remote-task', status: 'queued' }) };
    }
    assert.equal(payload.url, 'https://video.example.invalid/v1/videos/original-remote-task');
    queries += 1;
    return { status: 200, body: JSON.stringify(queries === 1
      ? { status: 'completed', file_id: 'former-file-result' }
      : { id: 'original-remote-task', status: 'completed' }) };
  },
  downloadGeneratedMedia: async (payload: { url: string; headers?: Record<string, string> }) => {
    assert.equal(payload.url, 'https://video.example.invalid/v1/videos/original-remote-task/content');
    assert.equal(payload.headers?.Authorization, 'Bearer frozen-synthetic-key');
    return { fileName: 'original.mp4', relativePath: 'video/original.mp4', checksum: 'original-checksum', sizeBytes: 12,
      mediaType: 'video', managed: true, missing: false, url: 'lianhua-media://original.mp4' };
  },
} as unknown as VideoGenerationDesktop;
const options = { getState: () => state, setState: (update: (value: AppState) => AppState) => { state = update(state); }, desktop, onRuntime: () => undefined };
const draft: VideoGenerationDraft = { backend: 'api', name: '历史任务', prompt: '原来的提示词', references: [], parameters: {} };
const engine = new VideoGenerationEngine({ ...options, pollIntervalMs: 60_000 });
const taskId = await engine.start(draft);
engine.dispose();
const job = () => state.project.generationTasks.find((item) => item.id === taskId) as VideoGenerationTask;
const frozen = JSON.stringify(job().videoJob!.snapshot.connection);
job().response = { status: 'completed', file_id: 'former-file-result' };
state.settings.videoTaskApi = { ...clean, apiKey: 'different-current-key' };
restoredRun = true;
const resumed = new VideoGenerationEngine({ ...options, pollIntervalMs: 5 });
resumed.reconcile();
try {
  for (let index = 0; index < 200 && !job().resultAssetId; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(job().resultAssetId, 'original task result is saved');
  assert.equal(queries, 2, 'file-only response waits for the original task download result');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(JSON.stringify(job().videoJob!.snapshot.connection), frozen, 'historical connection snapshot and credential scope stay unchanged');
} finally { resumed.dispose(); }
console.log('video API legacy mapping: precise settings repair, preserved custom/history and no former-provider query passed');
