import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRhTvService, ORIGIN } = require('../electron/rhtvBridge/service.cjs');
const { createRhTvManager } = require('../electron/rhtvBridge/manager.cjs');
const { createVideoWorkbench } = require('../electron/videoWorkbench.cjs');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=';
const request = (client = 'client-one') => ({ protocol_version: 1, client_id: client, model_key: 'minimax-h3-rh-enhanced', mode: 'text', prompt: 'An original prompt',
  cost_policy: 'free_only', parameters: { duration: 5, resolution: '768p', aspect_ratio: '16:9' }, references: [] });
function fixture(t, overrides = {}, validateResult) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhtv-test-'));
  const actions = [];
  const browser = { state: () => 'test browser', prepare: async (job, files) => { actions.push({ job, files }); return { message: 'prepared without submitting' }; }, show: async (id) => actions.push(id), close: async () => {}, closeJob: async () => {}, ...overrides };
  const service = createRhTvService({ root, browser, validateResult });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, root, actions, browser };
}
test('acceptance is local-only, idempotent and durable across restart', async (t) => {
  const { service, root, actions, browser } = fixture(t);
  const one = await service.dispatch('POST', '/v1/videos', request());
  assert.equal(one.status, 'waiting_review'); assert.equal(one.handed_off, false); assert.equal(actions.length, 0);
  assert.equal((await service.dispatch('POST', '/v1/videos', request())).id, one.id);
  await assert.rejects(service.dispatch('POST', '/v1/videos', { ...request(), prompt: 'different' }), /不同输入/);
  const restored = createRhTvService({ root, browser });
  assert.equal((await restored.dispatch('GET', '/v1/videos/by-client/client-one')).id, one.id);
  await restored.close();
  await assert.rejects(service.dispatch('GET', '/v1/videos/by-client/missing'), /不会自动重新提交/);
});
test('original image bytes, sparse slots and explicit group identities survive material export', async (t) => {
  const { service } = fixture(t);
  const uploaded = await service.dispatch('POST', '/v1/assets', { data_url: png });
  const input = { ...request(), mode: 'reference', references: [
    { upload_id: uploaded.upload_id, asset_id: 'a', slot_index: 0, role: 'character', character_ids: ['one','two'] },
    { upload_id: uploaded.upload_id, asset_id: 'b', slot_index: 3, role: 'scene', character_ids: [] },
  ] };
  const job = await service.dispatch('POST', '/v1/videos', input);
  assert.deepEqual(job.references.map((ref) => ref.slot_index), [0, 3]);
  const manifestFile = service.materials(job.id);
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  assert.deepEqual(manifest.references[0].character_ids, ['one','two']);
  assert.deepEqual(manifest.references[1].character_ids, []);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(manifestFile), manifest.references[1].file_name)), Buffer.from(png.split(',')[1], 'base64'));
  await assert.rejects(service.dispatch('POST', '/v1/assets', { data_url: png.replace('image/png','image/jpeg') }), /MIME/);
  await assert.rejects(service.dispatch('POST', '/v1/videos', { ...input, client_id: 'bad', references: [input.references[0], input.references[0]] }), /绑定清单/);
});
test('handoff reserves capacity; neither stop nor errors imply upstream cancellation', async (t) => {
  const { service, actions } = fixture(t);
  const a = await service.dispatch('POST', '/v1/videos', request('a'));
  const b = await service.dispatch('POST', '/v1/videos', request('b'));
  await service.prepare(a.id);
  assert.equal(actions.length, 1);
  assert.equal(service.cancel(a.id).cancellation_confirmed, false);
  await assert.rejects(service.prepare(b.id), /尚未确认结束/);
  await service.prepare(a.id);
  assert.equal(typeof actions[1], 'string', 'reopening cannot upload or create another draft');
  await service.confirmNotSubmitted(a.id);
  assert.equal((await service.dispatch('GET', `/v1/videos/${a.id}`)).cancellation_confirmed, true);
  await service.prepare(b.id);
});

test('desktop asset channel accepts files above 20 MB without the HTTP JSON envelope limit', async (t) => {
  const { service, root, actions } = fixture(t);
  const bytes = Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.alloc(23 * 1024 * 1024, 65)]);
  const data_url = `data:image/png;base64,${bytes.toString('base64')}`;
  const asset = await service.dispatch('POST', '/v1/assets', { data_url });
  assert.equal(asset.size_bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(path.join(root, 'assets', asset.upload_id)), bytes);
  assert.equal((await service.dispatch('POST', '/v1/assets', { data_url })).upload_id, asset.upload_id);
  const job = await service.dispatch('POST', '/v1/videos', { ...request(), mode: 'reference', references: [
    { upload_id: asset.upload_id, asset_id: 'large-original', slot_index: 4, role: 'character', character_ids: ['one', 'two'] },
  ] });
  await service.prepare(job.id);
  assert.deepEqual(fs.readFileSync(actions[0].files[0]), bytes);
  assert.deepEqual(actions[0].job.request.references[0].character_ids, ['one', 'two']);
  await assert.rejects(service.dispatch('POST', '/v1/assets', JSON.stringify({ data_url })), /传输缓冲上限（不是网站图片限制）/);
});
test('crash during webpage preparation retains the persisted exposure boundary', async (t) => {
  const { service, root, browser } = fixture(t, { prepare: async () => { throw new Error('disconnected'); } });
  const a = await service.dispatch('POST', '/v1/videos', request());
  const failed = await service.prepare(a.id);
  assert.equal(failed.status, 'submission_unknown'); assert.equal(failed.handed_off, true);
  const restored = createRhTvService({ root, browser });
  assert.equal(restored.cancel(a.id).cancellation_confirmed, false);
  await restored.close();
});
test('cancellation before webpage exposure is definitive; input and cost policy are validated', async (t) => {
  const { service } = fixture(t);
  const job = await service.dispatch('POST', '/v1/videos', request());
  assert.equal(service.cancel(job.id).cancellation_confirmed, true);
  await assert.rejects(service.prepare(job.id), /已结束/);
  for (const invalid of [{ cost_policy: 'paid' }, { mode: 'first_last' }, { parameters: { duration: 16, resolution: '768p', aspect_ratio: '16:9' } }]) {
    await assert.rejects(service.dispatch('POST', '/v1/videos', { ...request('invalid'), ...invalid }));
  }
  await assert.rejects(service.dispatch('POST', '/v1/videos', { ...request('traversal'), references: [{ asset_id: 'a', slot_index: 0, role: 'scene', upload_id: '../secret' }] }), /标识/);
});
test('loopback API requires token, exact host, no web Origin and has no generating endpoint', async (t) => {
  const { service } = fixture(t);
  await service.start();
  const { endpoint, token } = service.credentials();
  assert.ok(endpoint.startsWith('http://127.0.0.1:'));
  assert.equal((await fetch(`${endpoint}/v1/health`)).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${endpoint}/v1/health`, { headers })).status, 200);
  assert.equal((await fetch(`${endpoint}/v1/health`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 401);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.get(`${endpoint}/v1/health`, { headers: { ...headers, Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(wrongHost, 401);
  assert.equal((await fetch(`${endpoint}/v1/videos/generate`, { method: 'POST', headers, body: '{}' })).status, 404);
  const caps = await (await fetch(`${endpoint}/v1/capabilities`, { headers })).json();
  assert.equal(caps.automatic_submission, false);
});
test('worker RPC starts/stops cleanly and rejects arbitrary network routes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhtv-worker-'));
  const manager = createRhTvManager({ root, projectRoot: path.resolve('.'), resourcesPath: '' });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal((await manager.call('status')).running, false);
  assert.equal((await manager.call('start')).running, true);
  await assert.rejects(manager.call('request', { url: 'https://example.com/', method: 'GET' }), /受管/);
  const accepted = await manager.call('request', { url: `${ORIGIN}/v1/videos`, method: 'POST', body: JSON.stringify(request()) });
  assert.equal(accepted.status, 200);
  const id = JSON.parse(accepted.body).id;
  await manager.close();
  await assert.rejects(manager.call('request', { url: `${ORIGIN}/v1/health` }), /已停止/);
  await manager.call('start');
  const recovered = await manager.call('request', { url: `${ORIGIN}/v1/videos/by-client/client-one`, method: 'GET' });
  assert.equal(JSON.parse(recovered.body).id, id);
});

test('real worker multipart uploads above 20 MB preserve original bytes over restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhtv-large-worker-'));
  const manager = createRhTvManager({ root, projectRoot: path.resolve('.'), resourcesPath: '' });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = Buffer.concat([Buffer.from(png.split(',')[1], 'base64'), Buffer.alloc(23 * 1024 * 1024, 66)]);
  const uploaded = await manager.call('request', { url: `${ORIGIN}/v1/assets`, method: 'POST',
    multipart: { files: [{ fieldName: 'file', fileName: 'large.png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }] } });
  assert.equal(uploaded.status, 200, uploaded.body);
  const asset = JSON.parse(uploaded.body);
  const input = { ...request('large-worker'), mode: 'reference', references: [
    { upload_id: asset.upload_id, asset_id: 'large-original', slot_index: 3, role: 'character', character_ids: ['one'] },
  ] };
  const accepted = await manager.call('request', { url: `${ORIGIN}/v1/videos`, method: 'POST', body: JSON.stringify(input) });
  assert.equal(accepted.status, 200);
  await manager.close(); await manager.call('start');
  const recovered = await manager.call('request', { url: `${ORIGIN}/v1/videos/by-client/large-worker`, method: 'GET' });
  assert.equal(JSON.parse(recovered.body).id, JSON.parse(accepted.body).id);
  assert.deepEqual(JSON.parse(recovered.body).references[0].character_ids, ['one']);
  assert.deepEqual(fs.readFileSync(path.join(root, 'assets', asset.upload_id)), bytes);
});

test('concurrent service starts return the same ready loopback endpoint', async (t) => {
  const { service } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => service.start()));
  assert.ok(results.every((value) => value.running && value.endpoint === results[0].endpoint));
  await service.close();
  await assert.rejects(service.start(), /关闭/);
});

test('only one worker can own a browser profile and task journal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhtv-lock-'));
  const options = { root, projectRoot: path.resolve('.'), resourcesPath: '' };
  const one = createRhTvManager(options); const two = createRhTvManager(options);
  t.after(async () => { await one.close(); await two.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await one.call('start');
  await assert.rejects(two.call('start'), /另一实例|锁定/);
  await two.close(); await one.close();
  assert.equal((await two.call('start')).running, true, 'stopping releases the OS lock');
});

test('pending result import cannot race cancellation or revive a finished task', async (t) => {
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const { service, root } = fixture(t, {}, async () => wait);
  const job = await service.dispatch('POST', '/v1/videos', request());
  await service.prepare(job.id);
  const file = path.join(root, 'result.mp4'); fs.writeFileSync(file, 'mock video validation is injected');
  const importing = service.importResult(job.id, file);
  assert.throws(() => service.cancel(job.id), /处理中/);
  await assert.rejects(service.confirmNotSubmitted(job.id), /处理中/);
  await assert.rejects(service.importResult(job.id, file), /处理中/);
  release();
  assert.equal((await importing).status, 'succeeded');
  const result = await service.resultFile(job.id);
  fs.appendFileSync(result, 'corruption');
  await assert.rejects(service.resultFile(job.id), /损坏/);
  await assert.rejects(service.confirmNotSubmitted(job.id), /不可解除/);
});

test('corrupt journal blocks startup rather than silently forgetting a task', async (t) => {
  const { service, root, browser } = fixture(t);
  const job = await service.dispatch('POST', '/v1/videos', request());
  fs.writeFileSync(path.join(root, 'jobs', `${job.id}.json`), '{');
  assert.throws(() => createRhTvService({ root, browser }));
});

test('human-confirmed webpage failure is distinct from cancelling a never-submitted job', async (t) => {
  const { service } = fixture(t);
  const a = await service.dispatch('POST', '/v1/videos', request('a'));
  const b = await service.dispatch('POST', '/v1/videos', request('b'));
  await assert.rejects(service.confirmEnded(a.id), /已交接/);
  await service.prepare(a.id); const ended = await service.confirmEnded(a.id);
  assert.equal(ended.status, 'failed'); assert.equal(ended.terminal_confirmed, true); assert.equal(ended.cancellation_confirmed, false);
  await service.prepare(b.id);
});

test('real local video validation rejects disguised files and serves only the verified original', async (t) => {
  const { service, root } = fixture(t, {}, (source) => media.probe(source));
  const media = createVideoWorkbench({ assetRoot: path.join(root, 'results'), tempRoot: path.join(root, 'media-temp'), projectRoot: path.resolve('.'), resourcesPath: '' });
  t.after(() => media.close());
  const tools = path.resolve('build', 'media-tools', `${process.platform}-${process.arch}`);
  const ffmpeg = path.join(tools, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  assert.ok(fs.existsSync(ffmpeg), 'bundled media tools are required for the rhTV integration test');
  const job = await service.dispatch('POST', '/v1/videos', request()); await service.prepare(job.id);
  const file = path.join(root, 'source.mp4'); fs.writeFileSync(file, '<html>not a video</html>');
  await assert.rejects(service.importResult(job.id, file));
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'waiting_review');
  assert.equal(fs.existsSync(path.join(root, 'results', 'video', `${job.id}.mp4`)), false);
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=10:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file], { windowsHide: true });
  await service.importResult(job.id, file);
  await service.start(); const { endpoint, token } = service.credentials();
  const response = await fetch(`${endpoint}/v1/videos/${job.id}/content`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(file));
});
