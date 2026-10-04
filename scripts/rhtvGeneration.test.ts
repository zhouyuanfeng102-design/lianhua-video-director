import assert from 'node:assert/strict';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState } from '../src/storage';
import { defaultRhTvApi, RHTV_ORIGIN } from '../src/rhtvBridge';
import type { VideoGenerationDesktop, VideoGenerationDraft } from '../src/videoGenerationTypes';
import type { VideoGenerationTask } from '../src/types';
import { createHash } from 'node:crypto';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const until = async (condition: () => boolean) => { for (let i = 0; i < 200; i++) { if (condition()) return; await tick(); } assert.fail('rhTV mock did not settle'); };
const draft: VideoGenerationDraft = { backend: 'api', name: 'rhTV test', prompt: 'A plain text prompt', references: [], parameters: {} };
const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
function fixture(loseAcknowledgement = false) {
  let state = createInitialState();
  state.settings.videoTaskApi = { ...defaultRhTvApi, rhtvMode: 'text' };
  state.settings.videoExecutionMode = 'concurrent'; state.settings.videoExecutionConcurrency = 100;
  const checkpoints = new Map<string, VideoGenerationTask>();
  const accepted = new Map<string, { id: string; client_id: string; status: string; message: string; result_url?: string }>();
  const bodies: ReturnType<typeof JSON.parse>[] = [];
  const images: string[] = [];
  let posts = 0;
  let downloads = 0;
  const desktop: VideoGenerationDesktop = {
    videoRequest: async () => { throw new Error('rhTV must not use generic network transport'); },
    rhtvRequest: async (input) => {
      if (input.url.endsWith('/v1/assets')) {
        const data = input.multipart!.files[0].dataUrl; images.push(data);
        return response({ upload_id: `${createHash('sha256').update(Buffer.from(data.split(',')[1], 'base64')).digest('hex')}_png` });
      }
      if (input.url.endsWith('/cancel')) {
        const id = input.url.split('/').at(-2); const job = [...accepted.values()].find((entry) => entry.id === id)!;
        job.status = 'cancelled'; return response({ ...job, cancellation_confirmed: true });
      }
      if (input.method === 'POST') {
        posts++; const body = JSON.parse(input.body!);
        bodies.push(body);
        assert.equal(body.cost_policy, 'free_only'); assert.ok(body.client_id);
        const job = { id: `bridge-${posts}`, client_id: body.client_id, status: 'waiting_review', message: '原任务等待网页核对' };
        accepted.set(body.client_id, job);
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('response lost'); }
        return response(job);
      }
      const key = input.url.split('/').at(-1)!;
      return response(input.url.includes('/by-client/') ? accepted.get(key) : [...accepted.values()].find((entry) => entry.id === key));
    },
    cancelVideoRequest: async () => true, watchVideoProgress: async () => {}, unwatchVideoProgress: async () => true, onVideoProgress: () => () => {},
    setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => '',
    downloadGeneratedMedia: async () => { throw new Error('unexpected download'); },
    rhtvDownload: async ({ url }) => {
      assert.ok(url.startsWith(`${RHTV_ORIGIN}/v1/videos/`)); downloads++;
      return { fileName: 'original-result.mp4', mediaType: 'video', relativePath: 'video/original-result.mp4', checksum: 'mock-result-checksum', sizeBytes: 128, managed: true, missing: false, url: 'lianhua-asset://local/video/original-result.mp4' };
    },
    readManagedImageDataUrl: async () => { throw new Error('no image expected'); },
    saveVideoTaskCheckpoint: async (task) => { checkpoints.set(task.id, structuredClone(task)); return { persisted: true }; },
    getVideoTaskCheckpoint: async (id) => checkpoints.get(id) || null,
  };
  const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, onRuntime: () => {}, desktop, pollIntervalMs: 10, persistState: async () => {} });
  const task = (id: string) => state.project.generationTasks.find((entry) => entry.id === id) as VideoGenerationTask;
  return { engine, task, posts: () => posts, downloads: () => downloads, accepted, bodies, images, state: () => state };
}
{
  const f = fixture();
  try {
    const a = await f.engine.start(draft); const b = await f.engine.start({ ...draft, name: 'second' });
    assert.equal(f.posts(), 1, 'global concurrency cannot multiply rhTV account capacity');
    assert.equal(f.task(a).remoteTaskId, 'bridge-1'); assert.equal(f.task(b).remoteTaskId, undefined);
    assert.match(f.task(b).videoJob!.message!, /最多同时生成 1 个/);
    await f.engine.cancel(a);
    await until(() => f.posts() === 2);
    assert.equal(f.task(a).videoJob!.cancellationConfirmed, true);
    assert.equal(f.task(b).videoJob!.snapshot.connection.api!.endpoint, `${RHTV_ORIGIN}/v1/videos`);
  } finally { f.engine.dispose(); }
}
{
  const f = fixture(true);
  try {
    const id = await f.engine.start(draft);
    assert.equal(f.task(id).videoJob!.stage, 'submission-unknown');
    assert.equal(f.posts(), 1);
    await f.engine.resume(id);
    assert.equal(f.task(id).remoteTaskId, 'bridge-1'); assert.equal(f.posts(), 1, 'recovery is a lookup, never another POST');
  } finally { f.engine.dispose(); }
}
{
  const f = fixture();
  try {
    f.state().settings.videoTaskApi.rhtvMode = 'reference';
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=';
    f.state().project.assets = ['a', 'b'].map((id) => ({ id, name: id, type: 'reference', role: 'composition', dataUrl: png, tags: [], createdAt: 1, updatedAt: 1 }));
    const input: VideoGenerationDraft = { ...draft, prompt: '<Picture 4> Keep dialogue unchanged.', references: [
      { assetId: 'a', slotIndex: 0, role: 'character', characterIds: ['one', 'two'] },
      { assetId: 'b', slotIndex: 3, role: 'scene', characterIds: [] },
    ] };
    const id = await f.engine.start(input);
    assert.equal(f.posts(), 1); assert.deepEqual(f.images, [png, png]);
    assert.equal(f.bodies[0].prompt, input.prompt);
    assert.deepEqual(f.bodies[0].references.map((ref: { slot_index: number }) => ref.slot_index), [0, 3]);
    assert.deepEqual(f.bodies[0].references.map((ref: { character_ids: string[] }) => ref.character_ids), [['one','two'], []]);
    assert.ok(f.task(id).videoJob!.snapshot.images.every((image) => image.freezeState === 'frozen'));
  } finally { f.engine.dispose(); }
}
{
  const f = fixture();
  try {
    const id = await f.engine.start(draft);
    const job = [...f.accepted.values()][0]; job.status = 'succeeded'; job.result_url = `${RHTV_ORIGIN}/v1/videos/${job.id}/content`;
    await until(() => Boolean(f.task(id).resultAssetId));
    assert.equal(f.downloads(), 1); assert.equal(f.posts(), 1);
    const asset = f.state().project.assets.find((item) => item.id === f.task(id).resultAssetId)!;
    assert.equal(asset.sourceVideoTaskId, id); assert.equal(asset.type, 'video');
    await f.engine.resume(id);
    assert.equal(f.downloads(), 1, 'completed original result is not downloaded into duplicate assets');
  } finally { f.engine.dispose(); }
}
console.log('rhTV generation: dedicated transport, reference bytes/bindings, serial queue, cancel, recovery and result import passed');
