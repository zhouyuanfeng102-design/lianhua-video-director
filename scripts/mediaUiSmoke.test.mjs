import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { waitForCondition } from './qaProcessHarness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'mediaUiSmoke.mjs'), 'utf8');

const loadUploadFile = ({ cdpDispatchesEvents = false } = {}) => {
  const start = source.indexOf('const uploadFile = ');
  const end = source.indexOf('\n\nawait clickNavigation', start);
  assert.ok(start >= 0 && end > start, 'media smoke upload function must remain executable in isolation');

  const dispatchedEvents = [];
  const blockedEvents = [];
  let assetCount = 0;
  const captureListeners = new Map();
  const qaWindow = {
    addEventListener(type, listener, capture) {
      if (!capture) return;
      captureListeners.set(type, [...(captureListeners.get(type) || []), listener]);
    },
    removeEventListener(type, listener, capture) {
      if (!capture) return;
      captureListeners.set(
        type,
        (captureListeners.get(type) || []).filter((candidate) => candidate !== listener),
      );
    },
  };
  const fileInput = {
    objectId: 'qa-file-input',
    dispatchEvent(event) {
      for (const listener of [...(captureListeners.get(event.type) || [])]) listener(event);
      if (event.immediatePropagationStopped) {
        blockedEvents.push(event.type);
        return true;
      }
      dispatchedEvents.push(event.type);
      if (event.type === 'change') assetCount += 1;
      return true;
    },
  };
  const document = {
    querySelector(selector) {
      return selector === '.assets-view input.file-input[type=file]' ? fileInput : null;
    },
    querySelectorAll(selector) {
      return selector === '.asset-card' ? Array.from({ length: assetCount }) : [];
    },
  };
  class Event {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
      this.immediatePropagationStopped = false;
    }
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    }
  }

  let context;
  context = vm.createContext({
    command: async (method, params) => {
      if (method !== 'DOM.setFileInputFiles') throw new Error(`Unexpected CDP command: ${method}`);
      if (params.objectId !== fileInput.objectId || params.files.length !== 1) {
        throw new Error('CDP did not receive the selected file and input identity');
      }
      fileInput.files = [...params.files];
      if (cdpDispatchesEvents) {
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return {};
    },
    delay: async () => {},
    document,
    Event,
    evaluate: async (expression) => vm.runInContext(expression, context),
    path,
    process: { env: { MEDIA_UPLOAD_TIMEOUT_MS: '100' } },
    waitForCondition,
    window: qaWindow,
  });
  vm.runInContext(
    `${source.slice(start, end)}\n;globalThis.__uploadFile = uploadFile;`,
    context,
    { filename: 'mediaUiSmoke.mjs' },
  );
  return { assetCount: () => assetCount, blockedEvents, dispatchedEvents, uploadFile: context.__uploadFile };
};

test('media upload explicitly emits input and change before waiting for the asset card', async () => {
  const { dispatchedEvents, uploadFile } = loadUploadFile();

  await uploadFile('C:\\qa\\probe.webm', 1);

  assert.deepEqual(dispatchedEvents, ['input', 'change']);
});

test('media upload suppresses CDP-generated events before emitting one explicit event pair', async () => {
  const { assetCount, blockedEvents, dispatchedEvents, uploadFile } = loadUploadFile({
    cdpDispatchesEvents: true,
  });

  await uploadFile('C:\\qa\\probe.webm', 1);

  assert.deepEqual(blockedEvents, ['input', 'change']);
  assert.deepEqual(dispatchedEvents, ['input', 'change']);
  assert.equal(assetCount(), 1);
});

test('media renderer readiness retries a transient navigation context loss', async () => {
  const start = source.indexOf('const waitForMediaRenderer = ');
  const end = source.indexOf("\nawait command('Runtime.enable'", start);
  assert.ok(start >= 0 && end > start, 'media smoke must expose an executable renderer readiness wait');

  let attempts = 0;
  const context = vm.createContext({
    evaluate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Execution context was destroyed.');
      return true;
    },
    process: { env: { MEDIA_APP_READY_TIMEOUT_MS: '250' } },
    waitForCondition,
  });
  vm.runInContext(
    `${source.slice(start, end)}\n;globalThis.__waitForMediaRenderer = waitForMediaRenderer;`,
    context,
    { filename: 'mediaUiSmoke.mjs' },
  );

  await context.__waitForMediaRenderer();

  assert.equal(attempts, 2);
});

test('media video fixture forces canvas frames and retries a header-only recording', async () => {
  const start = source.indexOf('const videoBase64 = await evaluate(');
  const end = source.indexOf('\nfs.writeFileSync(videoPath', start);
  assert.ok(start >= 0 && end > start, 'media smoke must expose its video fixture generation step');

  const captureRates = [];
  let recorderAttempts = 0;
  let requestedFrames = 0;
  let stoppedTracks = 0;
  const browserContext = vm.createContext({
    Blob,
    Uint8Array,
    btoa,
    document: {
      createElement(name) {
        assert.equal(name, 'canvas');
        return {
          getContext: () => ({ fillRect() {}, fillText() {} }),
          captureStream(rate) {
            captureRates.push(rate);
            const track = {
              requestFrame() { requestedFrames += 1; },
              stop() { stoppedTracks += 1; },
            };
            return {
              getVideoTracks: () => [track],
              getTracks: () => [track],
            };
          },
        };
      },
    },
    MediaRecorder: class MediaRecorder {
      constructor() {
        recorderAttempts += 1;
        this.attempt = recorderAttempts;
        this.state = 'inactive';
      }

      start() { this.state = 'recording'; }

      requestData() {
        const size = this.attempt === 1 ? 110 : 2_048;
        this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) });
      }

      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        queueMicrotask(() => this.onstop?.());
      }
    },
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
  });
  const context = vm.createContext({
    evaluate: async (expression) => vm.runInContext(expression, browserContext),
  });
  await vm.runInContext(
    `(async () => {\n${source.slice(start, end)}\nglobalThis.__videoBase64 = videoBase64;\n})()`,
    context,
    { filename: 'mediaUiSmoke.mjs' },
  );

  assert.deepEqual(captureRates, [0, 0]);
  assert.equal(recorderAttempts, 2);
  assert.equal(requestedFrames, 24);
  assert.equal(stoppedTracks, 2);
  assert.equal(Buffer.from(context.__videoBase64, 'base64').length, 2_048);
});
