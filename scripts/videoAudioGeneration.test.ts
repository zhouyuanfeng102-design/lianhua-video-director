import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInitialState, normalizeState } from '../src/storage';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { renderVideoAudioDraft } from '../src/videoAudioReferences';
import type { AppState, ReferenceAsset, VideoGenerationTask } from '../src/types';
import type { VideoAudioReference, VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { RunningHubVideoWorkflow } from '../src/runningHubVideoTypes';

// Synthetic bytes and mock transport only: these tests never perform network IO.
type Request = Parameters<VideoGenerationDesktop['videoRequest']>[0];
const bytes = (sample = 200) => {
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40); wav.writeInt16LE(sample, 44);
  return wav;
};
const data = (sample = 200) => `data:audio/wav;base64,${bytes(sample).toString('base64')}`;
const hash = (dataUrl: string) => createHash('sha256').update(Buffer.from(dataUrl.split(',')[1], 'base64')).digest('hex');
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const selectedCase = process.env.VIDEO_AUDIO_QA_CASE;
const run = (name: string) => !selectedCase || selectedCase === name;
const workflow: RunningHubVideoWorkflow = { id: 'audio-workflow', name: '合成三槽音频', runKind: 'ai-app', remoteId: '2092524412225826817',
  requestTemplate: JSON.stringify({ nodeInfoList: [{ nodeId: '1', fieldName: 'prompt', fieldValue: 'original' },
    ...['144', '160', '228'].map((nodeId) => ({ nodeId, fieldName: 'audio', fieldValue: 'None' }))] }),
  mapping: { prompt: [{ nodeId: '1', inputName: 'prompt' }], images: [], audios: ['144', '160', '228'].map((nodeId) => ({ nodeId, inputName: 'audio' })) }, createdAt: 1, updatedAt: 1 };
const asset = (id: string, sample: number): ReferenceAsset => ({ id, name: id, fileName: `${id}.wav`, type: 'audio', role: 'composition', mediaType: 'audio', mimeType: 'audio/wav',
  dataUrl: data(sample), tags: [], createdAt: 1, updatedAt: 1 });
const draft = (count = 2): VideoGenerationDraft => ({ name: '参考声线视频', backend: 'api', runningHubWorkflowId: workflow.id,
  prompt: 'A character speaks quietly in a cabin.', source: { language: 'en', promptFormat: 'ordinary' }, references: [], parameters: {}, audioSelectionMode: 'override',
  audioReferences: Array.from({ length: count }, (_, index): VideoAudioReference => ({ bindingId: JSON.stringify([['144', '160', '228'][index], 'audio']), assetId: `audio-${index}`, slotIndex: index,
    target: { kind: index === 0 ? 'voiceover' : 'ambience' }, retainMode: index === 0 ? 'weak_reference' : 'reference' })) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitFor = async (condition: () => boolean, reason: string) => { for (let i = 0; i < 400; i++) { if (condition()) return; await tick(); } assert.fail(reason); };
const fixture = () => {
  const holder = { state: createInitialState(), files: new Map<string, string>(), journal: new Map<string, VideoGenerationTask>(), credentials: new Map<string, string>(),
    requests: [] as Request[], uploads: [0, 0, 0], posts: 0, failSecond: true, losePost: false, badReceipt: false, failBoundary: false };
  holder.state.settings.runningHubVideo = { enabled: true, baseUrl: 'https://audio-mock.invalid', apiKey: 'synthetic-private-key', workflows: [structuredClone(workflow)], activeWorkflowId: workflow.id };
  holder.state.settings.videoExecutionMode = 'concurrent'; holder.state.settings.videoExecutionConcurrency = 3;
  holder.state.project.assets = [asset('audio-0', 200), asset('audio-1', 400), asset('audio-2', 600)]; holder.state.projects = [holder.state.project];
  const desktop: VideoGenerationDesktop = {
    videoRequest: async (request) => {
      holder.requests.push(structuredClone(request));
      assert.ok(request.url.startsWith('https://audio-mock.invalid/'), 'frozen tasks keep the original connection');
      if (request.url.endsWith('/media/upload/binary')) {
        const file = request.multipart!.files[0]; assert.equal(file.fieldName, 'file');
        const index = [data(200), data(400), data(600)].indexOf(file.dataUrl); assert.ok(index >= 0, 'audio upload preserves frozen bytes'); holder.uploads[index]++;
        if (index === 1 && holder.failSecond) throw new Error('synthetic second audio upload interrupted');
        return response({ code: 0, data: holder.badReceipt ? { download_url: 'https://cdn.invalid/temporary.wav' }
          : { fileName: `openapi/frozen-${index}.wav`, download_url: `https://cdn.invalid/temporary-${index}.wav` } });
      }
      if (request.url.includes('/run/')) {
        holder.posts++; if (holder.losePost) throw new Error('synthetic lost POST acknowledgement');
        const body = JSON.parse(request.body!);
        const inputs = body.nodeInfoList.filter((node: { fieldName: string }) => node.fieldName === 'audio');
        assert.equal(inputs[0].fieldValue, 'openapi/frozen-0.wav');
        assert.ok(inputs.every((node: { fieldValue: string }) => !node.fieldValue.startsWith('https:')), 'download URLs never enter Comfy nodes');
        return response({ taskId: `mock-video-${holder.posts}`, status: 'QUEUED', results: null });
      }
      assert.ok(request.url.endsWith('/query')); return response({ taskId: JSON.parse(request.body!).taskId, status: 'RUNNING', results: null });
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async ({ taskId, apiKey }) => { if (apiKey) holder.credentials.set(taskId, apiKey); return { persisted: true }; },
    getVideoTaskCredential: async (taskId) => holder.credentials.get(taskId) || null,
    downloadGeneratedMedia: async () => { throw new Error('running mock does not download video'); },
    readManagedImageDataUrl: async () => { throw new Error('audio-only fixture has no images'); },
    storeGeneratedAudio: async ({ dataUrl, fileName }) => {
      const checksum = hash(dataUrl), relativePath = `audio/${checksum}.wav`; holder.files.set(relativePath, dataUrl);
      return { fileName: fileName || 'frozen.wav', relativePath, checksum, mediaType: 'audio', mimeType: 'audio/wav', sizeBytes: 48, managed: true, missing: false, url: `lianhua-asset://local/${relativePath}` };
    },
    readManagedAudioDataUrl: async ({ relativePath, expectedChecksum }) => {
      const dataUrl = holder.files.get(relativePath); assert.ok(dataUrl, 'frozen audio survives removing asset entries');
      assert.equal(hash(dataUrl), expectedChecksum, 'modified frozen audio must stop before generation'); return { dataUrl };
    },
    saveVideoTaskCheckpoint: async (task) => {
      if (holder.failBoundary && task.videoJob?.preparation?.phase === 'post-started') throw new Error('synthetic disk write failed');
      holder.journal.set(task.id, structuredClone(task)); return { persisted: true };
    },
    getVideoTaskCheckpoint: async (taskId) => structuredClone(holder.journal.get(taskId) || null), deleteVideoTaskCheckpoint: async (taskId) => holder.journal.delete(taskId),
  };
  const options = { getState: () => holder.state, setState: (updater: (current: AppState) => AppState) => { holder.state = updater(holder.state); }, desktop, onRuntime: () => {}, persistState: async () => {}, pollIntervalMs: 60_000 };
  const fixture = { holder, desktop, engine: new VideoGenerationEngine(options), task: (id: string) => holder.state.project.generationTasks.find((task) => task.id === id)!,
    restart: () => { fixture.engine.dispose(); fixture.engine = new VideoGenerationEngine(options); } };
  return fixture;
};

// Each successful file receipt survives a real serialize/reload cycle. Changed project settings and deleted assets do not replace frozen input.
if (run('recovery')) {
  const f = fixture(); const id = await f.engine.start(draft()); f.engine.dispose();
  const original = structuredClone(f.task(id)); assert.equal(original.status, 'failed'); assert.equal(f.holder.posts, 0);
  assert.deepEqual(original.videoJob!.preparation!.uploadedAudios, ['openapi/frozen-0.wav']);
  assert.ok(original.videoJob!.snapshot.audios!.every((audio) => audio.freezeState === 'frozen' && audio.relativePath && !audio.dataUrl && !audio.url));
  f.holder.state = normalizeState(JSON.parse(JSON.stringify(f.holder.state)));
  assert.deepEqual(f.task(id).videoJob!.snapshot.audios, JSON.parse(JSON.stringify(original.videoJob!.snapshot.audios)), 'reload preserves exact audio metadata and bytes identity');
  assert.deepEqual(f.task(id).videoJob!.preparation!.uploadedAudios, ['openapi/frozen-0.wav']);
  f.holder.state.project.assets = []; f.holder.state.settings.runningHubVideo!.baseUrl = 'https://changed-mock.invalid'; f.holder.failSecond = false;
  f.restart(); await f.engine.resume(id);
  assert.deepEqual(f.holder.uploads, [1, 2, 0], 'only the attachment without a confirmed receipt is retried'); assert.equal(f.holder.posts, 1);
  assert.equal(f.task(id).videoJob!.preparation!.phase, 'acknowledged');
  const submitted = f.holder.requests.find((request) => request.url.includes('/run/'))!;
  const nodes = JSON.parse(submitted.body!).nodeInfoList;
  assert.equal(nodes.find((node: { nodeId: string }) => node.nodeId === '228').fieldValue, 'None', 'empty audio slots keep the template value');
  assert.equal(nodes.find((node: { nodeId: string }) => node.nodeId === '1').fieldValue, original.videoJob!.snapshot.draft.prompt);
  f.engine.dispose();
}

// A checksum mismatch on an already-uploaded audio still prevents the generation POST.
if (run('checksum')) {
  const f = fixture(); const id = await f.engine.start(draft()); f.engine.dispose();
  const frozen = f.task(id).videoJob!.snapshot.audios![0]; f.holder.files.set(frozen.relativePath!, data(999)); f.holder.failSecond = false;
  f.restart(); await f.engine.resume(id);
  assert.equal(f.holder.posts, 0); assert.deepEqual(f.holder.uploads, [1, 1, 0]); assert.match(f.task(id).error || '', /modified frozen audio/u); f.engine.dispose();
}

// No upload/generation can be silently authorized for an unsupported provider, missing asset, bad receipt or failed durable boundary.
if (run('unsupported')) {
  const f = fixture(); const input = draft(1); delete input.runningHubWorkflowId;
  f.holder.state.settings.videoTaskApi = { enabled: true, endpoint: 'https://generic-mock.invalid/generate', apiKey: '', provider: 'generic', taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url' };
  await assert.rejects(() => f.engine.start(input), /RunningHub|参考音频/u); assert.equal(f.holder.requests.length, 0); f.engine.dispose();
}
if (run('missing')) {
  const f = fixture(); f.holder.state.project.assets = [];
  await assert.rejects(() => f.engine.start(draft(1)), /音频|资产/u); assert.equal(f.holder.requests.length, 0); f.engine.dispose();
}
for (const failure of ['receipt', 'boundary'] as const) {
  if (!run(failure)) continue;
  const f = fixture(); f.holder.badReceipt = failure === 'receipt'; f.holder.failBoundary = failure === 'boundary';
  const id = await f.engine.start(draft(1)); assert.equal(f.holder.posts, 0); assert.equal(f.task(id).status, 'failed');
  assert.match(f.task(id).error || '', failure === 'receipt' ? /fileName/u : /disk write/u); f.engine.dispose();
}

// Lost POST acknowledgement cannot resend generation, even with stale project preparation state.
if (run('post')) {
  const f = fixture(); f.holder.losePost = true; const id = await f.engine.start(draft(1)); f.engine.dispose();
  assert.equal(f.holder.posts, 1); assert.equal(f.holder.journal.get(id)!.videoJob!.preparation!.phase, 'post-started');
  f.task(id).videoJob!.preparation!.phase = 'preparing'; f.task(id).videoJob!.stage = 'preparing';
  f.restart(); await assert.rejects(() => f.engine.resume(id), /不能安全恢复/u); assert.equal(f.holder.posts, 1); f.engine.dispose();
}

// Batch rows freeze independently, without mixing dense audio order or changing selected physical slots.
if (run('batch')) {
  const f = fixture(); f.holder.failSecond = false;
  const one = draft(1), two = draft(1); two.name = '第二段'; two.prompt = 'An outdoor narrator speaks calmly.';
  two.audioReferences![0] = { ...two.audioReferences![0], bindingId: '["228","audio"]', slotIndex: 2 };
  // Only this row uses slot 3; the mock inspects all uploads and the persisted sparse binding separately.
  const previousRequest = f.desktop.videoRequest;
  f.desktop.videoRequest = async (request) => {
    if (request.url.includes('/run/') && JSON.parse(request.body!).nodeInfoList.find((node: { nodeId: string }) => node.nodeId === '1').fieldValue.includes('outdoor')) {
      f.holder.requests.push(structuredClone(request)); f.holder.posts++;
      const nodes = JSON.parse(request.body!).nodeInfoList;
      assert.equal(nodes.find((node: { nodeId: string }) => node.nodeId === '144').fieldValue, 'None');
      assert.equal(nodes.find((node: { nodeId: string }) => node.nodeId === '228').fieldValue, 'openapi/frozen-0.wav');
      return response({ taskId: `mock-video-${f.holder.posts}`, status: 'QUEUED' });
    }
    return previousRequest(request);
  };
  const batch = await f.engine.startBatch({ projectId: f.holder.state.project.id, label: '合成两段音频', items: [{ itemKey: 'one', draft: one }, { itemKey: 'two', draft: two }] });
  await waitFor(() => f.holder.posts === 2, 'audio batch rows should each reach one mocked POST');
  assert.equal(f.task(batch.taskIds[0]).videoJob!.snapshot.audios![0].slotIndex, 0);
  assert.equal(f.task(batch.taskIds[1]).videoJob!.snapshot.audios![0].slotIndex, 2);
  assert.ok(batch.taskIds.every((id) => f.task(id).videoJob!.snapshot.audios![0].checksum === hash(data(200)))); f.engine.dispose();
}

// A previously rendered H3 draft can change image slots and enter batch/reuse without dropping or duplicating audio directions.
if (run('h3')) {
  const f = fixture(); f.holder.failSecond = false;
  const cloud = f.holder.state.settings.runningHubVideo!.workflows[0];
  const body = JSON.parse(cloud.requestTemplate);
  body.nodeInfoList.push(...['10', '11'].map((nodeId) => ({ nodeId, fieldName: 'image', fieldValue: 'None' })));
  cloud.requestTemplate = JSON.stringify(body); cloud.mapping.images = ['10', '11'].map((nodeId) => ({ nodeId, inputName: 'image', role: 'general' }));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  f.holder.state.project.assets.push({ id: 'image-a', name: '合成场景', fileName: 'scene.png', type: 'reference', role: 'general', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 });
  const authored = 'integrated_multimodal_description: A quiet cabin.\n[Shot 1] The cabin follows <Picture 8>.\noverall_soundscape: Quiet.';
  const imageBase = authored.replace('<Picture 8>', '<Picture 1>');
  const input = renderVideoAudioDraft(f.holder.state.project, { ...draft(1), prompt: imageBase,
    source: { language: 'en', promptFormat: 'h3' }, references: [{ assetId: 'image-a', role: 'general', slotIndex: 1 }],
    h3ReferenceBinding: { version: 1, projectId: f.holder.state.project.id, basePrompt: authored, renderedPrompt: imageBase,
      identities: { version: 1, characters: [] }, sourcePictures: [{ number: 8, assetId: 'image-a' }] } });
  const prompts: string[] = [], previous = f.desktop.videoRequest;
  f.desktop.videoRequest = async (request) => {
    if (request.multipart?.files[0]?.dataUrl.startsWith('data:image/')) {
      assert.equal(request.multipart.files[0].dataUrl, png); return response({ code: 0, data: { fileName: 'openapi/scene.png' } });
    }
    if (request.url.includes('/run/')) {
      f.holder.posts++; const nodes = JSON.parse(request.body!).nodeInfoList;
      const prompt = nodes.find((node: { nodeId: string }) => node.nodeId === '1').fieldValue as string; prompts.push(prompt);
      assert.ok(prompt.includes('<Picture 2>') && !prompt.includes('<Picture 8>'));
      assert.equal(prompt.match(/<Audio 1>/gu)?.length, 1, 'H3 rebinding retains exactly one audio instruction');
      assert.ok(prompt.split('\n')[0].includes('<Audio 1>'), 'H3 audio stays in the integrated line');
      assert.equal(nodes.find((node: { nodeId: string }) => node.nodeId === '11').fieldValue, 'openapi/scene.png');
      assert.equal(nodes.find((node: { nodeId: string }) => node.nodeId === '144').fieldValue, 'openapi/frozen-0.wav');
      return response({ taskId: `mock-h3-${f.holder.posts}`, status: 'QUEUED' });
    }
    return previous(request);
  };
  const batch = await f.engine.startBatch({ projectId: f.holder.state.project.id, label: 'H3音频重绑', items: [{ itemKey: 'h3', draft: input }] });
  await waitFor(() => f.task(batch.taskIds[0]).videoJob?.preparation?.phase === 'acknowledged', 'H3 row should complete mock preparation');
  const saved = structuredClone(f.task(batch.taskIds[0]).videoJob!.snapshot.draft);
  assert.equal(saved.h3ReferenceBinding!.basePrompt, authored);
  assert.equal(saved.audioReferenceBinding!.basePrompt, authored.replace('<Picture 8>', '<Picture 2>'));
  f.holder.state.project.assets = []; f.holder.state.project.voicePresets = { characters: {}, narrator: { assetId: 'different-unavailable-audio', retainMode: 'fully_copy' } };
  await f.engine.start({ ...saved, reuseTaskId: batch.taskIds[0] });
  assert.equal(prompts.length, 2); assert.equal(prompts[1], prompts[0], 'reuse keeps frozen audio instructions independent of changed project presets');
  f.engine.dispose();
}
console.log(`video audio generation focused mocks passed: ${selectedCase || 'durable per-file recovery, exact frozen bytes, sparse batch slots, provider gates and no repeated POST'}`);
