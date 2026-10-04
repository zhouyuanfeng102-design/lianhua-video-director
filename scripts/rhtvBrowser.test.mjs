import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { model, request, canvasBody } from './rhtvFixtures.mjs';
const require = createRequire(import.meta.url);
const { createRhTvBrowser } = require('../electron/rhtvBridge/browser.cjs');
const { API, digest, sessionIdentity } = require('../electron/rhtvBridge/contracts.cjs');

// Deterministic adapter tests. These do not launch a browser or use a live account.
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhtv-browser-'));
  const events = []; const handlers = new Map(); const pages = [];
  const headers = { authorization: 'Bearer test-session' };
  let routeHandler;
  let submittedJob;
  const response = (data) => ({ ok: () => true, status: () => 200, json: async () => data, dispose: async () => {} });
  const quote = options.quote || { code: 0, data: { totalPrice: 0, currency: 'USD', freeLimit: true } };
  async function send(page) {
    const body = options.body ? options.body(canvasBody(submittedJob)) : canvasBody(submittedJob);
    return routeHandler({
      request: () => ({ url: () => `${API}/canvas/task/run`, method: () => 'POST', frame: () => ({ page: () => page }),
        headers: () => headers, postDataJSON: () => body }),
      fetch: async (config) => { events.push(['post', config]); if (options.lostAck) throw new Error('connection lost'); return response({ code: 0, data: { taskId: 'task-one' } }); },
      fulfill: async () => events.push(['fulfill']), abort: async () => events.push(['abort']), continue: async () => events.push(['continue']),
    });
  }
  function newPage() {
    let closed = false; let prompt = ''; let files = [];
    const locator = (selector, opts = {}) => ({
      count: async () => selector.includes('input[type') && options.ambiguousUpload ? 2 : 1,
      waitFor: async () => { events.push(['wait', selector]); if (options.wrongParameters && opts.name === '16:9 / 768p / 5秒') throw new Error('parameter readback differs'); },
      first() { return this; }, nth() { return this; }, and() { return this; },
      click: async () => { events.push(['click', opts.name]); if (opts.name === '开始创作') await send(page); },
      fill: async (value) => { events.push(['fill', value]); if (selector.includes('composer-input')) prompt = value; },
      innerText: async () => prompt,
      isEnabled: async () => !options.uploadError,
      getAttribute: async () => '',
      setInputFiles: async (values) => { files = values; events.push(['files', values]); },
      evaluateAll: async () => {
        const images = files.map((file) => ({ name: file.name, source: options.previewSource || `data:${file.mimeType};base64,${file.buffer.toString('base64')}`,
          width: options.largeDimensions ? 10000 : 100, height: 4000, complete: true }));
        return options.previews ? options.previews(images) : images;
      },
      getByRole: (role, settings) => locator(role, settings),
    });
    const page = {
      goto: async (url) => { events.push(['goto', url]); handlers.get('request')?.({ url: () => `${API}/canvas/model/list`, headers: () => headers });
        handlers.get('response')?.({ ...response([model]), url: () => `${API}/canvas/model/list` }); },
      bringToFront: async () => events.push(['show']), getByRole: locator, locator,
      isClosed: () => closed, close: async () => { closed = true; },
    };
    pages.push(page); return page;
  }
  const chromium = { launchPersistentContext: async (profile, config) => {
    events.push(['launch', profile, config]);
    return { newPage: async () => newPage(), route: async (_pattern, handler) => { routeHandler = handler; },
      request: { post: async (url, config) => { events.push(['query', url, config]); return response(quote); } },
      on: (name, handler) => handlers.set(name, handler), close: async () => handlers.get('close')?.() };
  } };
  const browser = createRhTvBrowser({ root, chromium });
  t.after(async () => { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = options.bytes || Buffer.from('original bytes'); const hash = digest(bytes);
  const file = path.join(root, `${hash}_png`); fs.writeFileSync(file, bytes);
  const job = { id: 'job', request: { ...request(), mode: 'reference', references: [{ slot_index: 3, role: 'character', upload_id: `${hash}_png` }] } };
  submittedJob = job;
  return { browser, events, job, file, pages, send };
}

test('Edge preserves original bytes and prepares without submitting', async (t) => {
  const { browser, events, job, file, pages, send } = fixture(t);
  const result = await browser.prepare(job, [file]);
  assert.match(result.message, /已回读/);
  const files = events.find((event) => event[0] === 'files')[1];
  assert.match(files[0].name, /^slot-4-/); assert.deepEqual(files[0].buffer, fs.readFileSync(file));
  assert.equal(events[0][2].channel, 'msedge');
  assert.equal(events.some((event) => event[0] === 'post'), false);
  await send(pages[0]); assert.equal(events.at(-1)[0], 'abort', 'unguarded generate is blocked');
  await browser.show(job.id); assert.equal(pages.length, 1);
  await browser.close(); await assert.rejects(browser.login(), /正在关闭/);
});

test('first/last uploads are ordered by explicit role, not sparse input slot', async (t) => {
  const { browser, events, job, file } = fixture(t);
  const ref = job.request.references[0]; job.request.mode = 'first_last';
  job.request.references = [{ ...ref, slot_index: 0, role: 'last-frame' }, { ...ref, slot_index: 4, role: 'first-frame' }];
  await browser.prepare(job, [file, file]);
  const files = events.find((event) => event[0] === 'files')[1];
  assert.match(files[0].name, /^slot-5-/); assert.match(files[1].name, /^slot-1-/);
  assert.ok(events.some((event) => event[0] === 'click' && event[1] === '首尾帧'));
});

test('ambiguous upload, incorrect parameters and incomplete images still block preparation', async (t) => {
  for (const config of [{ ambiguousUpload: true }, { wrongParameters: true }, { uploadError: true },
    { previews: () => [] }, { previews: (images) => images.map((image) => ({ ...image, name: 'wrong-image' })) },
    { previews: (images) => images.map((image) => ({ ...image, complete: false })) },
    { previews: (images) => images.map((image) => ({ ...image, width: 0 })) },
    { previews: (images) => images.map((image) => ({ ...image, source: '' })) },
  ]) {
    const { browser, events, job, file } = fixture(t, config);
    await assert.rejects(browser.prepare(job, [file]));
    assert.equal(events.some((event) => event[0] === 'post'), false);
  }
});

test('images over 10 MB and 36 megapixels reach the webpage unchanged and may be compressed there', async (t) => {
  const bytes = Buffer.alloc(12 * 1024 * 1024 + 1, 65);
  const { browser, events, job, file } = fixture(t, { bytes, largeDimensions: true, previewSource: 'data:image/webp;base64,Y29tcHJlc3NlZA==' });
  await browser.prepare(job, [file]);
  assert.deepEqual(events.find((event) => event[0] === 'files')[1][0].buffer, bytes);
  let receipt;
  await browser.submit(job, { onBoundary: async (value) => { receipt = value; }, onSubmitted: async () => {} });
  assert.equal(events.filter((event) => event[0] === 'post').length, 1);
  assert.equal(receipt.reference_receipt[0].checksum, digest(bytes), 'the original checksum is retained, not replaced by a preview hash');
});

test('blob and CDN previews preserve sparse slots and explicit first/last roles', async (t) => {
  for (const previewSource of ['blob:https://rhtv.runninghub.ai/preview-id', 'https://cdn.runninghub.ai/processed-preview.webp']) {
    const { browser, events, job, file } = fixture(t, { previewSource });
    const ref = job.request.references[0]; job.request.mode = 'first_last';
    job.request.references = [{ ...ref, slot_index: 0, role: 'last-frame' }, { ...ref, slot_index: 4, role: 'first-frame' }];
    await browser.prepare(job, [file, file]);
    let receipt;
    await browser.submit(job, { onBoundary: async (value) => { receipt = value; }, onSubmitted: async () => {} });
    assert.deepEqual(receipt.reference_receipt.map(({ slot_index, role }) => [slot_index, role]), [[4, 'first-frame'], [0, 'last-frame']]);
    assert.equal(events.filter((event) => event[0] === 'post').length, 1);
  }
});

test('corrupt local files and reordered attachments remain blocked without size gates', async (t) => {
  const { browser, events, job, file } = fixture(t);
  fs.appendFileSync(file, 'changed original');
  await assert.rejects(browser.prepare(job, [file]), /本机原图校验/);
  assert.equal(events.some((event) => event[0] === 'files'), false);
  const other = fixture(t, { previews: (images) => images.reverse() });
  other.job.request.references.push({ ...other.job.request.references[0], slot_index: 6 });
  await assert.rejects(other.browser.prepare(other.job, [other.file, other.file]), /名称或顺序/);
  assert.equal(other.events.some((event) => event[0] === 'post'), false);
});

test('replacing a processed preview after preparation cannot submit a different image', async (t) => {
  const options = { previewSource: 'blob:https://rhtv.runninghub.ai/original-preview' };
  const { browser, events, job, file } = fixture(t, options);
  await browser.prepare(job, [file]);
  options.previewSource = 'blob:https://rhtv.runninghub.ai/replaced-preview';
  await assert.rejects(browser.submit(job, { onBoundary: async () => {}, onSubmitted: async () => {} }), /准备后发生变化/);
  assert.equal(events.some((event) => event[0] === 'post'), false);
});

test('automatic submission writes boundary before one POST and stores original task identity', async (t) => {
  const { browser, events, job, file, pages, send } = fixture(t);
  await browser.prepare(job, [file]);
  let receipt; let upstream;
  await browser.submit(job, { onBoundary: async (value) => { receipt = value; events.push(['boundary']); }, onSubmitted: async (value) => { upstream = value; events.push(['ack']); } });
  assert.ok(events.findIndex((event) => event[0] === 'boundary') < events.findIndex((event) => event[0] === 'post'));
  assert.deepEqual(events.find((event) => event[0] === 'post')[1], { maxRetries: 0, maxRedirects: 0, timeout: 60000 });
  assert.equal(upstream.task_id, 'task-one'); assert.equal(upstream.node_id, 'video-one');
  assert.equal(receipt.quote.total, 0); assert.equal(receipt.reference_receipt[0].slot_index, 3);
  assert.equal(upstream.account, sessionIdentity({ authorization: 'Bearer test-session' }));
  await send(pages[0]); assert.equal(events.filter((event) => event[0] === 'post').length, 1);
});

test('fees, wrong model, changed first/last order and failed journal all block network submission', async (t) => {
  for (const config of [
    { quote: { totalPrice: '0.01' } }, { quote: {} },
    { body: (body) => { body.canvas.nodes.at(-1).data.modelCode = 'another'; return body; } },
    { body: (body) => { body.canvas.nodes[0].data.title = 'wrong-file'; return body; } },
    { badJournal: true },
  ]) {
    const { browser, events, job, file } = fixture(t, config);
    await browser.prepare(job, [file]);
    await assert.rejects(browser.submit(job, { onBoundary: async () => { if (config.badJournal) throw new Error('disk full'); }, onSubmitted: async () => {} }));
    assert.equal(events.some((event) => event[0] === 'post'), false);
  }
});

test('lost POST acknowledgement cannot repeat within the original page', async (t) => {
  const { browser, events, job, file, pages, send } = fixture(t, { lostAck: true });
  await browser.prepare(job, [file]);
  await assert.rejects(browser.submit(job, { onBoundary: async () => {}, onSubmitted: async () => {} }), /lost/);
  await send(pages[0]); assert.equal(events.filter((event) => event[0] === 'post').length, 1);
});
