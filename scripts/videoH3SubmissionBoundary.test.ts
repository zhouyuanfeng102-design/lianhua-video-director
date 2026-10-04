import assert from 'node:assert/strict';
import { applyOfficialH3Prompt } from '../src/officialPrompt';
import { createInitialState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { AppState, Storyboard, VideoTaskApiConfig } from '../src/types';
import type { GeneratedMediaDownloadRequest, VideoGenerationDesktop, VideoGenerationDraft, VideoGenerationRuntime } from '../src/videoGenerationTypes';

const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });

const sourceBoard = (): Storyboard => ({
  id: 'h3-boundary-board', sceneId: 'h3-boundary-scene', workflow: 'drama', inputMode: 'text',
  durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo', stylePresetId: 'style',
  ruleSetId: 'rules', converterPresetId: 'converter', globalLock: '', shots: [{
    id: 'h3-boundary-shot', index: 1, startSec: 0, endSec: 5, purpose: '建立关系',
    subject: '林澜', action: '林澜抬头看向廊桥', camera: '中景固定', transition: '自然衔接',
    lighting: '清晨侧光', sound: '脚步声', result: '林澜停步', referenceAssetIds: [], prompt: '', locked: false,
  }],
  finalPrompt: '【0s-5s】主体：林澜；动作：林澜抬头看向廊桥；空间：廊桥入口；光影：清晨侧光；镜头：中景固定；台词：无；音效：脚步声。',
  createdAt: 1, updatedAt: 1,
});

const makeHarness = (model: string) => {
  const state = createInitialState();
  const board = applyOfficialH3Prompt(sourceBoard(), { assets: [], characters: [], locations: [], props: [], sceneContent: '林澜来到廊桥入口。' });
  state.project.scenes = [{
    id: board.sceneId, title: 'H3 边界测试', content: '林澜来到廊桥入口。', summary: '', characterIds: [], propIds: [], storyboardIds: [board.id],
    createdAt: 1, updatedAt: 1,
  }];
  state.project.storyboards = [board];
  const config: VideoTaskApiConfig = {
    enabled: true, endpoint: 'https://h3-boundary.example/generate', statusEndpointTemplate: 'https://h3-boundary.example/tasks/{id}',
    apiKey: 'h3-boundary-key', authHeader: 'Authorization', authScheme: 'Bearer', taskIdPath: 'id', statusPath: 'status',
    resultUrlPath: 'output.url', provider: 'generic', model,
  };
  state.settings.videoTaskApi = config;
  const requests: Array<{ method?: string; body?: string }> = [];
  const credentials = new Map<string, string>();
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (payload) => {
      requests.push(payload);
      return response({ id: 'h3-boundary-remote', status: 'queued' });
    },
    cancelVideoRequest: async () => true,
    watchVideoProgress: async () => {},
    unwatchVideoProgress: async () => true,
    onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { if (apiKey) credentials.set(taskId, apiKey); else credentials.delete(taskId); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => credentials.get(taskId) || null,
    downloadGeneratedMedia: async (payload: GeneratedMediaDownloadRequest) => ({
      fileName: `${payload.fileName || 'h3-boundary'}.mp4`, relativePath: `video/${payload.fileName || 'h3-boundary'}.mp4`,
      checksum: 'h3-boundary-checksum', sizeBytes: 1, mediaType: 'video' as const, managed: true, missing: false,
      url: 'lianhua-media://asset/h3-boundary.mp4',
    }),
    readManagedImageDataUrl: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
  };
  const options = {
    getState: () => state,
    setState: (updater: (current: AppState) => AppState) => { Object.assign(state, updater(state)); },
    desktop,
    onRuntime: (_taskId: string, _runtime: VideoGenerationRuntime) => {},
    pollIntervalMs: 5,
  };
  const engine = new VideoGenerationEngine(options);
  const draft = (prompt: string): VideoGenerationDraft => ({
    name: 'H3 边界测试', prompt, backend: 'api', references: [], parameters: {},
    source: { storyboardId: board.id, language: 'zh', promptVersion: board.updatedAt, label: 'H3 边界测试' },
  });
  return { state, board, engine, requests, draft };
};

// A current saved official body is the only H3 payload accepted at start().
{
  const h = makeHarness('minimax-h3');
  await h.engine.start(h.draft(h.board.officialPromptZh!));
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(JSON.parse(h.requests[0].body || '{}').prompt, h.board.officialPromptZh);
  h.engine.dispose();
}

// A current official English derivative remains a complete H3 body and is
// checked against its own saved source when the selected draft language is en.
{
  const h = makeHarness('minimax-h3');
  const english = h.board.officialPromptZh!;
  h.board.officialPromptEn = english;
  h.board.officialPromptEnSource = h.board.officialPromptZh;
  const draft = h.draft(english);
  draft.source = { storyboardId: h.board.id, language: 'en', promptVersion: h.board.updatedAt, label: 'H3 English boundary test' };
  await h.engine.start(draft);
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(JSON.parse(h.requests[0].body || '{}').prompt, english);
  h.engine.dispose();
}

// A manually edited H3 body is rejected before a video POST is issued.
{
  const h = makeHarness('minimax-h3');
  await assert.rejects(() => h.engine.start(h.draft('手工替换的 H3 正文')), /不是当前官方 H3 交付稿/u);
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 0);
  h.engine.dispose();
}

// An H3 retry/history with no current storyboard source is rejected too.
{
  const h = makeHarness('minimax-h3');
  const draft = h.draft(h.board.officialPromptZh!);
  draft.source = { storyboardId: 'deleted-storyboard', language: 'zh' };
  await assert.rejects(() => h.engine.start(draft), /已失效或尚未生成/u);
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 0);
  h.engine.dispose();
}

// Generic/non-H3 models retain the existing pass-through behavior.
{
  const h = makeHarness('generic-video-model');
  const manual = '普通模型的手写正文';
  await h.engine.start(h.draft(manual));
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(JSON.parse(h.requests[0].body || '{}').prompt, manual);
  h.engine.dispose();
}

console.log('H3 video submission boundary tests passed: current official body accepted, edited/history H3 blocked, non-H3 unchanged');
