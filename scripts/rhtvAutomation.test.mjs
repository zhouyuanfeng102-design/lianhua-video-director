import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { model, request, canvasBody } from './rhtvFixtures.mjs';
const require = createRequire(import.meta.url);
const { createRhTvService } = require('../electron/rhtvBridge/service.cjs');
const { freeQuote, taskResult, validateSubmission, collectModels, sessionIdentity } = require('../electron/rhtvBridge/contracts.cjs');
const upstream = { task_id: 'task-one', canvas_id: 'canvas-one', node_id: 'video-one', account: 'test-account' };

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhtv-automation-'));
  const events = [];
  const browser = { state: () => 'mock Edge', close: async () => {}, pause: () => {}, closeJob: async () => {},
    prepare: async (job) => { events.push(['prepare', job.id]); },
    submit: async (job, callbacks) => {
      events.push(['submit', job.id]);
      await callbacks.onBoundary({ upstream: { ...upstream, task_id: undefined }, quote: { total: 0, checked_at: Date.now(), currency: 'USD' } });
      const journal = JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${job.id}.json`)));
      assert.equal(journal.submission_started, true); assert.equal(journal.status, 'submitting');
      await callbacks.onSubmitted(upstream);
    },
    poll: async (job) => { events.push(['poll', job.upstream.task_id]); return { status: 'succeeded', url: 'https://cdn.runninghub.ai/result.mp4' }; },
    ...overrides.browser,
  };
  const file = path.join(root, 'mock.mp4'); fs.writeFileSync(file, 'validated by injected local validator');
  const options = { root, browser, pollInterval: 60000, validateResult: async () => {},
    downloadResult: async (data) => { events.push(['download', data.jobId]); return file; }, ...overrides, browser };
  const service = createRhTvService(options);
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, root, events, options, file };
}

test('free-only accepts explicit zero and rejects missing, paid, exhausted or unestimable quotes', () => {
  for (const value of [{}, { totalPrice: null }, { totalPrice: '' }, { totalPrice: false }, { totalPrice: '0.01', freeLimit: true },
    { totalPrice: 0, discountTotalPrice: 0.01 }, { totalPrice: 0, paidQuantity: 1 }, { totalPrice: 0, tokenPriceEstimable: false },
    { totalPrice: 0, freeLimit: true, freeLimitCount: 0 }, { code: 412, data: { totalPrice: 0 } }]) assert.throws(() => freeQuote(value));
  assert.equal(freeQuote({ code: 0, data: { totalPrice: '0', discountTotalPrice: '0', freeLimit: true, freeLimitCount: 1 } }).total, 0);
  assert.equal(freeQuote({ totalPrice: 0, originalTotalPrice: 5, freeLimit: true }).total, 0);
});

test('actual outgoing canvas rejects extra nodes, wrong model, prompt, duration and count', () => {
  const job = { request: request() };
  const models = collectModels({ code: 0, data: [{ type: 'TEXT_VIDEO', modelList: [model, { ...model, code: 'other', modelCode: 'other', modelName: 'Other' }] }] });
  assert.equal(models.length, 1);
  assert.equal(validateSubmission(job, canvasBody(job), models).quoteRequest.skuId, model.skuId);
  for (const patch of [
    (body) => { body.canvas.nodes.push({ id: 'extra' }); },
    (body) => { body.targetType = 'CANVAS'; },
    (body) => { body.canvas.nodes[0].data.modelCode = 'other'; },
    (body) => { body.canvas.nodes[0].data.params.prompt += ' changed'; },
    (body) => { body.canvas.nodes[0].data.params.duration = 15; },
    (body) => { body.canvas.nodes[0].data.params.generateNum = 2; },
  ]) { const body = canvasBody(job); patch(body); assert.throws(() => validateSubmission(job, body, models)); }
});

test('result parsing binds task and node and rejects missing, preview, multiple or unsafe outputs', () => {
  const payload = { tasks: [{ taskId: 'task-one', status: 'success', plans: [{ nodeId: 'video-one', status: 'success', outputs: [{ url: 'https://cdn.runninghub.ai/a.mp4' }] }] }] };
  assert.equal(taskResult(payload, upstream).status, 'succeeded');
  assert.throws(() => taskResult(payload, { ...upstream, task_id: 'other' }));
  assert.throws(() => taskResult(payload, { ...upstream, node_id: 'other' }));
  for (const outputs of [[], [{ url: 'https://cdn.runninghub.ai/a.jpg' }], [{ url: 'file:///a.mp4' }], [{ url: 'https://cdn.runninghub.ai/a.mp4' }, { url: 'https://cdn.runninghub.ai/b.mp4' }]]) {
    assert.throws(() => taskResult({ tasks: [{ ...payload.tasks[0], plans: [{ nodeId: 'video-one', status: 'success', outputs }] }] }, upstream));
  }
  assert.equal(taskResult({ tasks: [{ taskId: 'task-one', status: 'running', output: [{ url: 'https://cdn.runninghub.ai/a.mp4' }] }] }, upstream).status, 'running');
  assert.equal(taskResult({ tasks: [{ taskId: 'task-one', status: 'failed' }] }, upstream).status, 'failed');
  for (const key of ['originalUrl','originUrl','url','outputUrl','resultUrl','fileUrl','assetUrl']) {
    assert.equal(taskResult({ tasks: [{ taskId: 'task-one', status: 'success', output: [{ [key]: 'https://cdn.runninghub.ai/a.mp4', thumbnail: 'https://cdn.runninghub.ai/preview.jpg' }] }] }, upstream).url, 'https://cdn.runninghub.ai/a.mp4');
  }
  assert.throws(() => taskResult({ tasks: [{ taskId: 'task-one', status: 'success', output: [{ thumbnail: 'https://cdn.runninghub.ai/preview.mp4' }] }] }, upstream));
});

test('quotation includes default factors, correct scalar types and original model identity', () => {
  const job = { request: request() };
  const quotedModel = { ...model, params: { seed: 7 }, config: [...model.config,
    { paramName: 'audio', type: 'BOOLEAN', defaultValue: 'true' },
    { paramName: 'seed', type: 'INT', paramValue: '99' },
    { paramName: 'quality', type: 'FLOAT', defaultValue: '1.5' },
    { paramName: 'options', paramDataType: 'arrayInt', defaultValue: ['1', '2'] },
  ] };
  const body = canvasBody(job); body.canvas.nodes[0].data.params.generateNum = 1;
  const factors = Object.fromEntries(validateSubmission(job, body, [quotedModel]).quoteRequest.priceFactors.map((item) => [item.fieldKey, item.fieldValue]));
  assert.equal(factors.audio, true); assert.equal(factors.seed, 7); assert.equal(factors.quality, 1.5);
  assert.deepEqual(factors.options, [1, 2]); assert.equal(factors.rhModel, model.code); assert.equal(factors.generateNum, undefined);
  body.canvas.nodes[0].data.params.seed = 'not-a-number';
  assert.throws(() => validateSubmission(job, body, [quotedModel]), /计费数值/);
});

test('browser line-ending normalization preserves exact prompt content and dialogue', () => {
  const job = { request: { ...request(), prompt: 'Action\r\nSpeaker: "Hello."\r\n' } };
  const body = canvasBody(job); body.canvas.nodes[0].data.params.prompt = 'Action\nSpeaker: "Hello."';
  assert.ok(validateSubmission(job, body, [model]));
  body.canvas.nodes[0].data.params.prompt = 'Action\nSpeaker: "Bye."';
  assert.throws(() => validateSubmission(job, body, [model]), /提示词/);
});

test('session identity survives token renewal but isolates users and teams without persisting tokens', () => {
  const headers = (sub, nonce, team = '') => ({ authorization: `Bearer x.${Buffer.from(JSON.stringify({ sub, nonce })).toString('base64url')}.y`, 'x-team-id': team });
  assert.equal(sessionIdentity(headers('user', 1)), sessionIdentity(headers('user', 2)));
  assert.notEqual(sessionIdentity(headers('user', 1)), sessionIdentity(headers('other', 1)));
  assert.notEqual(sessionIdentity(headers('user', 1)), sessionIdentity(headers('user', 1, 'team')));
});

test('opt-in runs upload, single submit, poll, download and verification; local client ID remains idempotent', async (t) => {
  const { service, events } = fixture(t);
  const job = await service.dispatch('POST', '/v1/videos', request());
  await service.tick(); assert.equal(events.length, 0);
  service.automation(true); await service.tick();
  let state = await service.dispatch('GET', `/v1/videos/${job.id}`);
  assert.equal(state.status, 'running'); assert.equal(state.upstream_task_id, 'task-one');
  await assert.rejects(service.confirmNotSubmitted(job.id), /已取得网页任务编号/);
  await service.tick();
  state = await service.dispatch('GET', `/v1/videos/${job.id}`);
  assert.equal(state.status, 'succeeded'); assert.ok(await service.resultFile(job.id));
  assert.deepEqual(events.map((event) => event[0]), ['prepare','submit','poll','download']);
  assert.equal((await service.dispatch('POST', '/v1/videos', request())).id, job.id);
  await service.tick(); assert.equal(events.filter((event) => event[0] === 'submit').length, 1);
});

test('a preparation-only size rejection can retry the same job once after upgrading', async (t) => {
  let attempts = 0;
  const { service, events } = fixture(t, { browser: { prepare: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('原图超过网页免压缩 10 MB 上限，请先在软件中调整原图');
  } } });
  const job = await service.dispatch('POST', '/v1/videos', request('upgrade-size-retry'));
  service.automation(true); await service.tick();
  const paused = await service.dispatch('GET', `/v1/videos/${job.id}`);
  assert.equal(paused.status, 'paused'); assert.equal(paused.submission_started, false);
  await service.tick(); assert.equal(attempts, 1, 'paused uploads wait for explicit retry');
  await service.retry(job.id); await service.tick();
  const running = await service.dispatch('GET', `/v1/videos/${job.id}`);
  assert.equal(running.id, job.id); assert.equal(running.client_id, 'upgrade-size-retry');
  assert.equal(running.upstream_task_id, 'task-one');
  assert.equal(events.filter(([event]) => event === 'submit').length, 1);
  await service.retry(job.id); await service.tick();
  assert.equal(events.filter(([event]) => event === 'submit').length, 1, 'known remote IDs only query/download on subsequent retry');
});

test('lost acknowledgement survives restart, keeps serial slot and never automatically resubmits', async (t) => {
  const { service, options, events } = fixture(t, { browser: { submit: async (_job, callbacks) => {
    await callbacks.onBoundary({ upstream: { ...upstream, task_id: undefined } }); throw new Error('lost acknowledgement');
  } } });
  const job = await service.dispatch('POST', '/v1/videos', request());
  await service.dispatch('POST', '/v1/videos', request('next'));
  service.automation(true); await service.tick();
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'submission_unknown');
  await service.close();
  const restored = createRhTvService(options); t.after(() => restored.close());
  await restored.tick(); assert.equal(events.filter((event) => event[0] === 'prepare').length, 1);
  await assert.rejects(restored.retry(job.id), /禁止自动重投/);
  assert.equal(restored.cancel(job.id).cancellation_confirmed, false);
});

test('restart with known receipt resumes only original task and download', async (t) => {
  const { service, options, events } = fixture(t);
  const job = await service.dispatch('POST', '/v1/videos', request());
  service.automation(true); await service.tick(); await service.close();
  const restored = createRhTvService(options); t.after(() => restored.close());
  await restored.tick();
  assert.equal((await restored.dispatch('GET', `/v1/videos/${job.id}`)).status, 'succeeded');
  assert.equal(events.filter((event) => event[0] === 'submit').length, 1);
});

test('fee/login/reference preflight failure pauses; explicit retry is safe only before submission boundary', async (t) => {
  let fail = true;
  const { service, events } = fixture(t, { browser: { prepare: async (job) => { events.push(['prepare', job.id]); if (fail) throw new Error('not free'); } } });
  const job = await service.dispatch('POST', '/v1/videos', request());
  service.automation(true); await service.tick();
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'paused');
  await service.tick(); assert.equal(events.length, 1);
  fail = false; await service.retry(job.id); await service.tick();
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'running');
});

test('disable while preparing prevents submit; submitted tasks still finish while disabled', async (t) => {
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  const { service, events } = fixture(t, { browser: { prepare: async () => waiting } });
  const job = await service.dispatch('POST', '/v1/videos', request());
  service.automation(true); const execution = service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  service.automation(false); release(); await execution;
  assert.equal(events.some((event) => event[0] === 'submit'), false);
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'paused');
  service.automation(true); await service.retry(job.id); await service.tick();
  service.automation(false); await service.tick();
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'succeeded');
});

test('download failure and manual retry never generate another video', async (t) => {
  let fail = true;
  const { service, file, events } = fixture(t, { downloadResult: async () => { if (fail) throw new Error('network'); return file; } });
  const job = await service.dispatch('POST', '/v1/videos', request());
  service.automation(true); await service.tick(); await service.tick();
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'downloading');
  fail = false; await service.retry(job.id); await service.tick();
  assert.equal((await service.dispatch('GET', `/v1/videos/${job.id}`)).status, 'succeeded');
  assert.equal(events.filter((event) => event[0] === 'submit').length, 1);
});
