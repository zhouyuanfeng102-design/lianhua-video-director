import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../src/storage';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { renderVideoAudioDraft, prepareVideoAudioDraft, stripVideoAudioPromptBinding } from '../src/videoAudioReferences';
import { buildVideoApiBody } from '../src/videoGenerationApi';
import { VideoGenerationEngine } from '../src/videoGeneration';
import type { Storyboard, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';

const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', endpoint: 'https://synthetic.invalid/generate',
  statusEndpointTemplate: 'https://synthetic.invalid/task/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSfoAAAAASUVORK5CYII=';
const original = [
  '视频规格：时长30秒，画幅16:9，分辨率2K，立体声。',
  '参考素材与职责：本次未提供图片、视频或音频参考素材，全部人物、道具与场景均以文字设定为执行依据。庭院按“清晨开放的石砖庭院”建立空间。',
  '主体连续性：人物穿着灰色外套。',
  '一句话概述：人物穿过庭院。',
  '连续时间轴：0秒至30秒，人物穿过庭院，说：“本次未提供图片，这句话不能改。”',
  '全局约束：保留对白与脚步声。',
].join('\n');
const fixture = () => {
  const state = createInitialState(); state.project.assets = [{ id: 'image', name: '庭院', type: 'reference', role: 'scene',
    mediaType: 'image', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 }];
  state.projects = []; state.project.characters = []; state.project.generationTasks = [];
  state.project.storyboards = [{ id: 'board', shots: [], finalPrompt: original,
    seedance25Output: { targetId: 'seedance-2.5', promptZh: original, durationSec: 30, referenceManifest: [],
      sourceFingerprint: 'synthetic', warnings: [], generatedAt: 1 },
  } as unknown as Storyboard];
  state.settings.videoTaskApi = api;
  const draft: VideoGenerationDraft = { name: '本次素材与规格', backend: 'api', prompt: original,
    source: { promptFormat: 'seedance', language: 'zh', storyboardId: 'board' },
    references: [{ assetId: 'image', role: 'scene' }], parameters: { resolution: '720p', aspect_ratio: '9:16' } };
  const prepare = (input = draft) => prepareVideoH3ReferenceDraft(state.project, input, { backend: 'api', api });
  return { state, draft, prepare };
};

test('current images and output parameters replace stale declarations without altering the source or story', () => {
  const { state, draft, prepare } = fixture(); const before = JSON.stringify(state.project);
  const current = prepare().draft;
  assert.match(current.prompt, /分辨率720p/u); assert.match(current.prompt, /画幅9:16/u);
  const references = current.prompt.split('参考素材与职责：')[1].split('主体连续性：')[0];
  assert.doesNotMatch(references, /本次未提供|全部人物、道具与场景均以文字|原稿写作时/u);
  assert.ok(references.includes('庭院按“清晨开放的石砖庭院”建立空间。'));
  assert.equal(current.prompt.split('主体连续性：')[1], original.split('主体连续性：')[1]);
  const body = buildVideoApiBody(api, current, ['https://synthetic.invalid/image.png']);
  assert.equal(body.prompt, current.prompt); assert.equal(body.resolution, '720p'); assert.equal(body.aspect_ratio, '9:16');
  assert.deepEqual(body.images, ['https://synthetic.invalid/image.png']);
  assert.equal(prepare(current).draft.prompt, current.prompt, 'repeated preparation is idempotent');
  assert.equal(prepare({ ...current, references: [], parameters: {} }).draft.prompt, original, 'clearing inputs restores authored source');
  assert.equal(JSON.stringify(state.project), before); assert.equal(draft.prompt, original);
});

test('serialization leaves manual or unrecognized wording usable without new Seedance gates', () => {
  const { draft, prepare } = fixture();
  for (const prompt of [original, `${original}\n手工补充。`, original.replace('参考素材与职责：', '手工参考说明：')]) {
    const body = buildVideoApiBody(api, { ...draft, prompt }, ['image']);
    assert.equal(body.prompt, prompt);
    assert.deepEqual(body.images, ['image']);
  }
  assert.equal(buildVideoApiBody(api, { ...draft, references: [] }, []).prompt, original);
  assert.equal(buildVideoApiBody(api, prepare().draft, []).prompt, prepare().draft.prompt,
    'the prompt repair adds no separate Seedance image-count gate');
  const frozen = { ...draft, reuseTaskId: 'historical-snapshot' };
  assert.equal(buildVideoApiBody(api, frozen, ['image']).prompt, original, 'historical frozen prompts remain exact');
  assert.equal(buildVideoApiBody(api, { ...draft, source: { promptFormat: 'ordinary' } }, ['image']).prompt, original);
});

test('audio-only and combined selections clean the same claims and clearing audio restores the previous image draft', () => {
  const { state, draft, prepare } = fixture();
  const audio = { bindingId: 'synthetic-audio', assetId: 'voice', slotIndex: 0, target: { kind: 'voiceover' as const }, retainMode: 'reference' as const };
  for (const images of [false, true]) {
    const base = images ? prepare().draft : { ...draft, parameters: {}, references: [] };
    const input = { ...base, audioSelectionMode: 'override' as const, audioReferences: [audio] };
    const historical = { ...input, reuseTaskId: 'historical-audio-snapshot' };
    assert.strictEqual(renderVideoAudioDraft(state.project, historical), historical, 'frozen previews never adopt new cleanup rules');
    const current = renderVideoAudioDraft(state.project, input);
    assert.match(current.prompt, /@Audio 1/u);
    assert.ok(current.prompt.includes('庭院按“清晨开放的石砖庭院”建立空间。'));
    assert.equal(current.prompt.split('主体连续性：')[1], original.split('主体连续性：')[1]);
    assert.equal(renderVideoAudioDraft(state.project, current).prompt, current.prompt);
    assert.equal(stripVideoAudioPromptBinding(current.prompt, current.audioReferenceBinding), base.prompt);
    assert.equal(prepareVideoAudioDraft(state.project, { ...current, audioSelectionMode: 'none' }, undefined).prompt, base.prompt);
  }
});

test('normal, manual and unrecognized drafts each create one generation request with no added model call or retry', async () => {
  for (const kind of ['normal', 'manual', 'unrecognized'] as const) {
    const setup = fixture(); let state = setup.state;
    const input = kind === 'normal' ? setup.draft : { ...setup.draft,
      prompt: kind === 'manual' ? `${original}\n手工补充。` : original.replace('参考素材与职责：', '手工参考说明：') };
    const expected = prepareVideoH3ReferenceDraft(state.project, input, { backend: 'api', api }).draft;
    const requests: Parameters<VideoGenerationDesktop['videoRequest']>[0][] = [];
    const desktop = { videoRequest: async (payload: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
      requests.push(payload);
      assert.equal(payload.url, api.endpoint, 'no additional model or upload endpoint is used');
      assert.equal(payload.method, 'POST');
      return { status: 200, body: JSON.stringify({ id: `synthetic-${kind}`, status: 'queued' }) };
    }, setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
      saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined } as unknown as VideoGenerationDesktop;
    const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); },
      desktop, onRuntime: () => undefined, pollIntervalMs: 100000, persistState: async () => undefined });
    try {
      const taskId = await engine.start(input);
      assert.equal(requests.length, 1, `${kind}: one submit, no prompt-repair request or retry`);
      const body = JSON.parse(requests[0].body!);
      assert.equal(body.prompt, expected.prompt); assert.deepEqual(body.images, [png]);
      if (kind !== 'normal') assert.equal(body.prompt, input.prompt, 'manual/unrecognized source is not a content gate');
      const task = state.project.generationTasks.find((entry) => entry.id === taskId) as VideoGenerationTask;
      assert.ok(task?.remoteTaskId, `${kind}: engine.start submitted the task`);
      assert.equal(task.videoJob!.snapshot.draft.prompt, expected.prompt);
      const frozen = structuredClone(task.videoJob!.snapshot);
      state.project.storyboards[0].seedance25Output!.promptZh = '后来编辑的源稿';
      state.project.assets[0].name = '后来编辑的图片';
      assert.deepEqual(task.videoJob!.snapshot, frozen, 'existing task snapshots do not follow later edits');
      const historical = { ...structuredClone(frozen.draft), reuseTaskId: taskId };
      const restored = prepareVideoH3ReferenceDraft(state.project, historical, { backend: 'api', api }).draft;
      assert.deepEqual(restored, historical, 'historical previews preserve the frozen execution text');
    } finally { engine.dispose(); }
  }
});
