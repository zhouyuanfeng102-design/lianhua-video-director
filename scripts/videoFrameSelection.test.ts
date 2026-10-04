import assert from 'node:assert/strict';
import {
  extractVideoTailFrameSelection, prepareVideoTailFrameImage, recommendVideoTailFrame, videoTailFrameAiIssue,
  type VideoTailFrameSelectionDependencies, type VideoTailFrameSelectionDesktop, type VideoTailFrameSelectionInput,
} from '../src/videoFrameSelection';
import type { TextApiConfig } from '../src/types';
import type { WorkbenchExtractedFrame, WorkbenchFrameRequest, WorkbenchFrameResult } from '../src/videoWorkbenchTypes';
import { TextModelHttpError, TextModelResponseError } from '../src/services/llm';
import type { VideoTailFrameAiAttempt } from '../src/videoTailFrameRetry';

let count = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); count += 1; console.log(`ok ${count} - ${name}`); };
const config: TextApiConfig = { enabled: true, vision: true, provider: 'openai_compatible', baseUrl: 'https://vision.invalid/v1',
  apiKey: 'frame-service-private-key', model: 'user-selected-vision', temperature: 0.2, maxTokens: 4096 };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN0aDjAwMDAxAAGABGqAYSDRjw3AAAAAElFTkSuQmCC';
const frame = (index: number, timeSec = 3.96 + index * 0.4): WorkbenchExtractedFrame => ({
  role: index === 5 ? 'last-frame' : 'custom-frame', frameIndex: 99 + index * 10, timeSec, width: 1920, height: 1080,
  fileName: `frame-${index}.png`, relativePath: `media/images/frame-${index}.png`, checksum: `checksum-${index}`,
  mediaType: 'image', mimeType: 'image/png', managed: true, missing: false, sizeBytes: 4000, url: `app-media://frame-${index}.png`,
});
const candidates = Array.from({ length: 6 }, (_, index) => ({ id: `frame-${index + 1}`, timeSec: frame(index).timeSec, isLastFrame: index === 5, dataUrl: png }));
const selectionInput = () => ({ config: { ...config }, candidates, previousPrompt: '上一段完整提示词：背影正走进树林。', nextPrompt: '下一段完整提示词：转身看到六足巨兽。', storyContext: '完整剧情：修仙者与六足甲壳巨兽相遇。' });
const returns = (response: string): NonNullable<VideoTailFrameSelectionDependencies['requestModel']> => async () => response;
const dependencies = (response = '{"selectedId":"frame-3","reason":"这帧背影和六足巨兽都符合下段剧情，不需要强行补脸。"}'): VideoTailFrameSelectionDependencies => ({
  requestModel: returns(response), prepareImage: async (value) => value,
});
const fixture = () => {
  const requests: WorkbenchFrameRequest[] = []; const reads: string[] = []; const cancelled: string[] = [];
  const result = (frames: WorkbenchExtractedFrame[]): WorkbenchFrameResult => ({ frames,
    probe: { durationSec: 6, width: 1920, height: 1080, fps: 25, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' } });
  const desktop: VideoTailFrameSelectionDesktop = {
    extractWorkbenchFrames: async (request) => { requests.push(structuredClone(request)); return result(request.mode === 'last' ? [frame(5)] : Array.from({ length: 6 }, (_, index) => frame(index))); },
    readManagedImageDataUrl: async ({ relativePath }) => { reads.push(relativePath); return { dataUrl: png }; },
    cancelWorkbenchJob: async (jobId) => { cancelled.push(jobId); return true; },
  };
  const input: VideoTailFrameSelectionInput = { desktop, jobId: 'qa-selection', projectId: 'qa-project',
    source: { assetId: 'qa-video', relativePath: 'media/videos/qa-video.mp4', expectedChecksum: 'video-checksum' }, ...selectionInput() };
  return { desktop, input, requests, reads, cancelled, result };
};

await test('all complete source text and six ordered images reach the explicitly selected vision model', async () => {
  const input = selectionInput(); input.storyContext += '全文内容'.repeat(14000);
  let calls = 0;
  const result = await recommendVideoTailFrame(input, { requestModel: async (activeConfig, system, user, _signal, options) => {
    calls += 1;
    assert.deepEqual(activeConfig, config);
    const payload = JSON.parse(user);
    assert.equal(payload.completeStoryContext, input.storyContext);
    assert.equal(payload.completePreviousPrompt, input.previousPrompt);
    assert.equal(payload.completeNextPrompt, input.nextPrompt);
    assert.deepEqual(payload.candidates.map((item: { id: string }) => item.id), candidates.map((item) => item.id));
    assert.deepEqual(options?.referenceImages, candidates.map((item) => item.dataUrl));
    assert.match(system, /不要把露脸、全身/u);
    assert.match(system, /本地不会按你的语义、置信度/u);
    return '{"selectedId":"frame-2","reason":"不露脸也可以保持剧情镜头。","confidence":0.000001}';
  } });
  assert.equal(calls, 1); assert.equal(result.source, 'ai'); assert.equal(result.selectedId, 'frame-2');
  assert.match(result.reason, /不露脸/u); assert.match(result.warning!, /动作回退/u);
});

await test('AI can select a back view, nonhuman creature or close-up with no local semantic veto', async () => {
  for (const reason of ['只有背影，没有人脸，适合下段转身。', '六足甲壳非人类主体被遮挡仍符合剧情。', '特写只展示一只手，无全身也可以衔接。']) {
    const result = await recommendVideoTailFrame(selectionInput(), dependencies(JSON.stringify({ selectedId: 'frame-1', reason, confidence: 0 })));
    assert.equal(result.source, 'ai'); assert.equal(result.reason, reason);
  }
});

await test('true last frame is an ordinary valid AI choice and has no artificial earlier-frame warning', async () => {
  const result = await recommendVideoTailFrame(selectionInput(), dependencies('{"selectedId":"frame-6","reason":"真实末帧更适合连续动作。"}'));
  assert.equal(result.source, 'ai'); assert.equal(result.offsetFromEndSec, 0); assert.equal(result.warning, undefined);
});

await test('fenced JSON and braces inside a reason parse without rewriting content', async () => {
  const reason = '保留 {角色} 的背影与“异形”外观。';
  const result = await recommendVideoTailFrame(selectionInput(), dependencies(`分析完成\n\`\`\`json\n${JSON.stringify({ selectedId: 'frame-4', reason })}\n\`\`\``));
  assert.equal(result.selectedId, 'frame-4'); assert.equal(result.reason, reason);
});

await test('missing optional explanation does not reject a valid candidate', async () => {
  const result = await recommendVideoTailFrame(selectionInput(), dependencies('{"selectedId":"frame-4"}'));
  assert.equal(result.source, 'ai'); assert.equal(result.selectedId, 'frame-4'); assert.ok(result.reason);
});

await test('unparseable or invented choices fall back visibly without blocking or paid retries', async () => {
  for (const response of ['没有结果', '{"selectedId":"imaginary-frame","timeSec":99999}', '{"timeSec":5.1}', '{"selectedId":"frame-1"}\n{"selectedId":"frame-2"}']) {
    let calls = 0;
    const result = await recommendVideoTailFrame(selectionInput(), { requestModel: async () => { calls += 1; return response; } });
    assert.equal(calls, 1); assert.equal(result.source, 'last-frame'); assert.equal(result.selectedId, 'frame-6');
    assert.equal(result.offsetFromEndSec, 0); assert.match(result.warning!, /不阻止继续生成/u);
  }
});

await test('disabled, unconfigured and non-vision configurations do not call another model', async () => {
  for (const patch of [{ enabled: false }, { model: '' }, { baseUrl: '' }, { vision: false }]) {
    const active = { ...config, ...patch }; assert.ok(videoTailFrameAiIssue(active));
    const result = await recommendVideoTailFrame({ ...selectionInput(), config: active }, { requestModel: async () => { throw new Error('must not request'); } });
    assert.equal(result.source, 'last-frame'); assert.match(result.warning!, /已回退真实尾帧/u);
  }
});

await test('provider failures fall back once and redact secret/image echoes', async () => {
  let calls = 0;
  const result = await recommendVideoTailFrame(selectionInput(), { requestModel: async () => {
    calls += 1; throw new Error(`provider rejected ${config.apiKey} ${png}`);
  } });
  assert.equal(calls, 1); assert.equal(result.source, 'last-frame');
  assert.ok(!result.warning?.includes(config.apiKey)); assert.ok(!result.warning?.includes(png));
});

await test('summary does not retain images or credentials even if model echoes them in its reason', async () => {
  const result = await recommendVideoTailFrame(selectionInput(), dependencies(JSON.stringify({ selectedId: 'frame-2', reason: `${config.apiKey} ${png}` })));
  const stored = JSON.stringify(result); assert.ok(!stored.includes(config.apiKey)); assert.ok(!stored.includes(png));
});

await test('an already cancelled request does not invoke charging boundary or model', async () => {
  const controller = new AbortController(); controller.abort(); let charged = false;
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), signal: controller.signal, onBeforeAI: async () => { charged = true; } }, dependencies()), { name: 'AbortError' });
  assert.equal(charged, false);
});

await test('user cancellation during a non-cooperative model request rejects, not fallback', async () => {
  const controller = new AbortController(); let called = false; let requestSignal: AbortSignal | undefined;
  const pending = recommendVideoTailFrame({ ...selectionInput(), signal: controller.signal }, { requestModel: async (_config, _system, _user, signal) => {
    called = true; requestSignal = signal; controller.abort(); return new Promise<string>(() => {});
  } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(called, true); assert.equal(requestSignal?.aborted, true);
});

await test('late model completion cannot turn a cancelled request into success', async () => {
  const controller = new AbortController();
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), signal: controller.signal }, { requestModel: async () => {
    controller.abort(); return '{"selectedId":"frame-2"}';
  } }), { name: 'AbortError' });
});

await test('transport AbortError is not swallowed as an AI failure', async () => {
  await assert.rejects(recommendVideoTailFrame(selectionInput(), { requestModel: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } }), { name: 'AbortError' });
});

await test('bounded timeout aborts the request and falls back with no automatic retry', async () => {
  let calls = 0; let requestSignal: AbortSignal | undefined;
  const result = await recommendVideoTailFrame(selectionInput(), { timeoutMs: 2, requestModel: async (_config, _system, _user, signal) => {
    calls += 1; requestSignal = signal; return new Promise<string>(() => {});
  } });
  assert.equal(calls, 1); assert.equal(requestSignal?.aborted, true); assert.equal(result.source, 'last-frame'); assert.match(result.warning!, /超时/u);
});

await test('charging journal rejection propagates and cannot secretly start the model', async () => {
  let calls = 0;
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), onBeforeAI: async () => { throw new Error('checkpoint unavailable'); } }, {
    requestModel: async () => { calls += 1; return ''; },
  }), /checkpoint unavailable/u); assert.equal(calls, 0);
});

await test('one charging boundary precedes the only model request', async () => {
  const events: string[] = [];
  await recommendVideoTailFrame({ ...selectionInput(), onBeforeAI: async () => { events.push('checkpoint'); } }, { requestModel: async () => {
    events.push('request'); return '{"selectedId":"frame-2"}';
  } }); assert.deepEqual(events, ['checkpoint', 'request']);
});

await test('shared extraction keeps genuine last frame, six candidates and exact source provenance', async () => {
  const f = fixture(); const originalSource = structuredClone(f.input.source);
  const result = await extractVideoTailFrameSelection(f.input, dependencies());
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].mode, 'last'); assert.equal(f.requests[1].mode, 'uniform');
  assert.equal(f.requests[1].inSec, frame(5).timeSec - 2); assert.equal(f.requests[1].outSec, 6); assert.equal(f.requests[1].count, 6);
  assert.notEqual(f.requests[0].jobId, f.requests[1].jobId); assert.deepEqual(f.requests[0].source, originalSource); assert.deepEqual(f.input.source, originalSource);
  assert.equal(result.candidates.length, 6); assert.equal(result.candidates.filter((item) => item.isLastFrame).length, 1);
  assert.equal(result.candidates[5].frame.role, 'last-frame'); assert.equal(result.frame.role, 'custom-frame');
  assert.equal(result.frame.timeSec, frame(2).timeSec); assert.equal(result.selection.source, 'ai');
  assert.ok(!JSON.stringify(result).includes('base64,')); assert.ok(!JSON.stringify(result).includes(config.apiKey));
});

await test('candidate reading and thumbnail decoding are sequential and precede charging', async () => {
  const f = fixture(); const events: string[] = []; let active = 0; let maxActive = 0;
  f.desktop.readManagedImageDataUrl = async ({ relativePath }) => { events.push(relativePath); active += 1; maxActive = Math.max(maxActive, active); return { dataUrl: png }; };
  f.input.onBeforeAI = async () => { assert.equal(active, 0); events.push('checkpoint'); };
  await extractVideoTailFrameSelection(f.input, { requestModel: async () => { events.push('request'); return '{"selectedId":"frame-6"}'; },
    prepareImage: async (image) => { events.push('thumbnail'); active -= 1; return image; } });
  assert.equal(maxActive, 1); assert.equal(events[12], 'checkpoint'); assert.equal(events[13], 'request');
});

await test('missing model skips extra extraction/reading/charging and preserves fallback', async () => {
  const f = fixture(); f.input.config = { ...config, enabled: false }; let charge = false;
  f.input.onBeforeAI = async () => { charge = true; };
  const result = await extractVideoTailFrameSelection(f.input, dependencies());
  assert.equal(f.requests.length, 1); assert.equal(f.reads.length, 0); assert.equal(charge, false); assert.equal(result.selection.source, 'last-frame');
});

await test('candidate extraction failure falls back to already saved real last frame', async () => {
  const f = fixture(); const base = f.desktop.extractWorkbenchFrames!;
  f.desktop.extractWorkbenchFrames = async (request) => { if (request.mode === 'uniform') throw new Error('ffmpeg extra extraction failed'); return base(request); };
  const result = await extractVideoTailFrameSelection(f.input, dependencies());
  assert.equal(result.selection.source, 'last-frame'); assert.equal(result.frame.timeSec, frame(5).timeSec); assert.match(result.selection.warning!, /候选帧准备失败/u);
});

await test('candidate read failure uses true last frame and never requests a paid repair', async () => {
  const f = fixture(); let calls = 0;
  f.desktop.readManagedImageDataUrl = async () => { throw new Error('checksum changed'); };
  const result = await extractVideoTailFrameSelection(f.input, { requestModel: async () => { calls += 1; return ''; } });
  assert.equal(calls, 0); assert.equal(result.selection.source, 'last-frame'); assert.equal(result.candidates.length, 6); assert.match(result.selection.warning!, /checksum changed/u);
});

await test('one-frame clips require no visual request or duplicate candidates', async () => {
  const f = fixture(); f.desktop.extractWorkbenchFrames = async () => f.result([frame(5, 0)]);
  let calls = 0;
  const result = await extractVideoTailFrameSelection(f.input, { requestModel: async () => { calls += 1; return ''; } });
  assert.equal(calls, 0); assert.equal(result.candidates.length, 1); assert.equal(result.frame.timeSec, 0); assert.match(result.selection.warning!, /只有一张/u);
});

await test('very short clips clamp candidate range at zero instead of rejecting content', async () => {
  const f = fixture();
  f.desktop.extractWorkbenchFrames = async (request) => {
    f.requests.push(request);
    return { ...f.result(request.mode === 'last' ? [frame(5, 0.08)] : [frame(0, 0), frame(1, 0.04), frame(5, 0.08)]), probe: { ...f.result([]).probe, durationSec: 0.12 } };
  };
  const result = await extractVideoTailFrameSelection(f.input, dependencies('{"selectedId":"frame-1","reason":"保留合适的特写"}'));
  assert.equal(f.requests[1].inSec, 0); assert.equal(result.candidates.length, 3); assert.equal(result.selection.source, 'ai');
});

await test('only source/file integrity failures block when no safe real last frame exists', async () => {
  for (const patch of [{ missing: true }, { checksumMismatch: true }, { checksum: '' }, { relativePath: '../outside.png' }, { role: 'custom-frame' as const }]) {
    const f = fixture(); f.desktop.extractWorkbenchFrames = async () => f.result([{ ...frame(5), ...patch }]);
    await assert.rejects(extractVideoTailFrameSelection(f.input, dependencies()), /真实尾帧未保存/u);
  }
});

await test('cancelling extraction cancels the actual local sub-job and never becomes fallback', async () => {
  const f = fixture(); const controller = new AbortController(); f.input.signal = controller.signal;
  f.desktop.extractWorkbenchFrames = async () => { controller.abort(); return new Promise<WorkbenchFrameResult>(() => {}); };
  await assert.rejects(extractVideoTailFrameSelection(f.input, dependencies()), { name: 'AbortError' });
  assert.deepEqual(f.cancelled, ['qa-selection-last']);
});

await test('charging checkpoint failure remains fatal through the shared extraction wrapper', async () => {
  const f = fixture(); let calls = 0;
  f.input.onBeforeAI = async () => { throw new Error('do not continue without durable consent'); };
  await assert.rejects(extractVideoTailFrameSelection(f.input, { ...dependencies(), requestModel: async () => { calls += 1; return ''; } }), /durable consent/u);
  assert.equal(calls, 0);
});

await test('raw URLs are not accepted as candidate image content', async () => {
  await assert.rejects(prepareVideoTailFrameImage('https://untrusted.invalid/frame.png'), /本地 PNG/u);
});

await test('renderer thumbnailing keeps aspect ratio, caps the longest side at 960 and never upsizes', async () => {
  const originalDocument = globalThis.document; const originalImage = globalThis.Image;
  try {
    for (const [width, height, expectedWidth, expectedHeight] of [[1920, 1080, 960, 540], [1080, 1920, 540, 960], [400, 300, 400, 300]]) {
      const sizes: number[][] = []; let releasedSource = false;
      class ImageStub {
        naturalWidth = width; naturalHeight = height;
        set src(value: string) { if (!value) releasedSource = true; }
        async decode() {}
      }
      const canvas = { width: 0, height: 0,
        getContext: () => ({ drawImage: (_image: unknown, _x: number, _y: number, outputWidth: number, outputHeight: number) => { sizes.push([outputWidth, outputHeight]); } }),
        toDataURL: (mime: string, quality: number) => { assert.equal(mime, 'image/jpeg'); assert.equal(quality, 0.84); return 'data:image/jpeg;base64,anBlZw=='; },
      };
      Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: ImageStub });
      Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { createElement: (name: string) => { assert.equal(name, 'canvas'); return canvas; } } });
      assert.equal(await prepareVideoTailFrameImage(png), 'data:image/jpeg;base64,anBlZw==');
      assert.deepEqual(sizes, [[expectedWidth, expectedHeight]]); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.equal(releasedSource, true);
    }
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: originalDocument });
    Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: originalImage });
  }
});

await test('thumbnail decoding remains cancellable and does not retain its full-size image', async () => {
  const originalDocument = globalThis.document; const originalImage = globalThis.Image;
  const controller = new AbortController(); let released = false;
  try {
    class ImageStub {
      set src(value: string) { if (!value) released = true; }
      decode() { controller.abort(); return new Promise<void>(() => {}); }
    }
    Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: ImageStub });
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {} });
    await assert.rejects(prepareVideoTailFrameImage(png, controller.signal), { name: 'AbortError' }); assert.equal(released, true);
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: originalDocument });
    Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: originalImage });
  }
});

await test('real common transport sends each image separately for both OpenAI and Claude', async () => {
  const originalWindow = globalThis.window;
  try {
    for (const provider of ['openai_compatible', 'claude'] as const) {
      let payload: Record<string, unknown> | undefined;
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
        request: async (request: { body?: string }) => {
          payload = JSON.parse(request.body!);
          return { status: 200, body: JSON.stringify(provider === 'claude'
            ? { content: [{ type: 'text', text: '{"selectedId":"frame-6","reason":"末帧适合。"}' }] }
            : { choices: [{ message: { content: '{"selectedId":"frame-6","reason":"末帧适合。"}' } }] }) };
        },
      } } });
      const result = await recommendVideoTailFrame({ ...selectionInput(), config: { ...config, provider } });
      assert.equal(result.source, 'ai'); assert.equal(payload!.model, config.model);
      const messages = payload!.messages as Array<{ role: string; content: Array<{ type: string }> }>;
      const content = messages.find((message) => message.role === 'user')!.content;
      assert.equal(content.filter((item) => item.type === (provider === 'claude' ? 'image' : 'image_url')).length, 6);
    }
  } finally { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); }
});

await test('one-click strict AI format failures stop after initial plus three attempts without raw-tail fallback', async () => {
  for (const response of ['没有结果', '{"selectedId":"foreign-frame"}']) {
    let calls = 0;
    await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true }, {
      retryDelayMs: 0,
      requestModel: async () => { calls += 1; return response; },
    }), /已自动重试 3\/3 次.*不会自动改用原尾帧/u);
    assert.equal(calls, 4);
  }
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), config: { ...config, enabled: false }, requireAiSelection: true }, {
    requestModel: async () => { throw new Error('disabled config must not be sent'); },
  }), /未启用.*不会自动改用原尾帧/u);
  const h = fixture(); h.desktop.readManagedImageDataUrl = async () => { throw new Error('候选图片无法读取'); };
  await assert.rejects(extractVideoTailFrameSelection({ ...h.input, requireAiSelection: true }, dependencies()), /不会自动改用原尾帧/u);
});

await test('strict quota recovery grows only this run and journals each attempt before request', async () => {
  const input = { ...selectionInput(), config: { ...config, maxTokens: 3000 }, requireAiSelection: true as const };
  const untouched = structuredClone(input); const tokens: number[] = []; const boundaries: VideoTailFrameAiAttempt[] = [];
  const events: string[] = []; const progress: string[] = [];
  const result = await recommendVideoTailFrame({ ...input,
    onBeforeAI: async (attempt) => { assert.ok(attempt); boundaries.push({ ...attempt }); events.push(`boundary-${attempt.attempt}`); },
    onProgress: (message) => progress.push(message),
  }, { retryDelayMs: 0, requestModel: async (activeConfig, system, user, signal, options) => {
    tokens.push(activeConfig.maxTokens); events.push(`request-${tokens.length}`);
    assert.equal(signal?.aborted, false); assert.equal(activeConfig.model, input.config.model); assert.equal(activeConfig.baseUrl, input.config.baseUrl);
    assert.deepEqual(options?.referenceImages, candidates.map((candidate) => candidate.dataUrl));
    const payload = JSON.parse(user); assert.equal(payload.completeStoryContext, input.storyContext);
    assert.equal(payload.completePreviousPrompt, input.previousPrompt); assert.equal(payload.completeNextPrompt, input.nextPrompt);
    assert.match(system, /理由用一两句简短说明/u); assert.match(system, /本地不会按你的语义/u);
    if (tokens.length > 1) { assert.ok(options?.finalInstruction); assert.equal(options?.disableThinking, true); }
    if (tokens.length === 1) throw new TextModelResponseError('length', '文本模型达到最大输出额度，只返回了思考内容，没有返回正文；不会自动进行 JSON 格式重试。');
    if (tokens.length === 2) throw new TextModelResponseError('reasoning_only', '文本模型只返回了思考内容，没有返回正文。');
    return '{"selectedId":"frame-2","reason":"背影适合继续转身。"}';
  } });
  assert.equal(result.source, 'ai'); assert.equal(result.selectedId, 'frame-2');
  assert.deepEqual(tokens, [3000, 6000, 12000]);
  assert.deepEqual(boundaries, tokens.map((maxTokens, index) => ({ attempt: index + 1, maxAttempts: 4, maxTokens })));
  assert.deepEqual(events, ['boundary-1', 'request-1', 'boundary-2', 'request-2', 'boundary-3', 'request-3']);
  assert.ok(progress.some((message) => /自动重试 1\/3/u.test(message))); assert.ok(progress.some((message) => /自动重试 2\/3/u.test(message)));
  assert.deepEqual(input, untouched, 'local token growth must not mutate global API settings or source prompts');
});

await test('strict retry growth has a ceiling and explicit single-attempt compatibility remains single', async () => {
  const tokens: number[] = []; let calls = 0;
  const selected = await recommendVideoTailFrame({ ...selectionInput(), config: { ...config, maxTokens: 30000 }, requireAiSelection: true }, {
    retryDelayMs: 0, requestModel: async (activeConfig) => { tokens.push(activeConfig.maxTokens); if (++calls < 4) throw new TextModelResponseError('length', '达到最大输出额度'); return '{"selectedId":"frame-6"}'; },
  });
  assert.equal(selected.source, 'ai'); assert.deepEqual(tokens, [30000, 32768, 32768, 32768]);
  calls = 0;
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true, maxAiAttempts: 1 }, {
    retryDelayMs: 0, requestModel: async () => { calls += 1; throw new TextModelResponseError('length', '达到最大输出额度'); },
  }), /最大输出额度/u); assert.equal(calls, 1, 'historical task authorization must not acquire three new paid attempts');
  calls = 0;
  const legacy = await recommendVideoTailFrame({ ...selectionInput(), maxAiAttempts: 4 }, {
    retryDelayMs: 0, requestModel: async () => { calls += 1; throw new TextModelResponseError('length', '达到最大输出额度'); },
  }); assert.equal(calls, 1); assert.equal(legacy.source, 'last-frame', 'legacy optional-AI path keeps its old one-call behavior');
});

await test('empty or malformed completed responses and HTTP transient statuses can recover within four calls', async () => {
  const failures = [
    new TextModelResponseError('empty_content', '缺少正文'), new TextModelResponseError('invalid_response', '不是有效的 JSON 协议对象'),
    ...[429, 500, 502, 503].map((status) => new TextModelHttpError(status, `HTTP ${status}`)),
  ];
  for (const failure of failures) {
    let calls = 0;
    const result = await recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true }, {
      retryDelayMs: 0, requestModel: async (activeConfig) => { assert.equal(activeConfig.maxTokens, config.maxTokens); if (++calls === 1) throw failure; return '{"selectedId":"frame-6"}'; },
    }); assert.equal(result.source, 'ai'); assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true, maxAiAttempts: 99 }, {
    retryDelayMs: 0, requestModel: async () => { calls += 1; throw new TextModelResponseError('length', '达到最大输出额度，仅返回思考，没有正文'); },
  }), /已自动重试 3\/3 次.*最大输出额度.*不会自动改用原尾帧/u);
  assert.equal(calls, 4, 'even an excessive requested attempt value must not exceed initial plus three');
});

await test('auth, explicit refusal/filtering and non-recoverable HTTP responses are never retried', async () => {
  for (const failure of [
    new TextModelResponseError('refusal', '接口返回 refusal 标记'), new TextModelResponseError('content_filter', '接口返回 content_filter 标记'),
    ...[400, 401, 403, 404, 408, 422, 504].map((status) => new TextModelHttpError(status, `HTTP ${status} 请求不可用`)),
    new Error('网络断开，远端结果未知'),
  ]) {
    let calls = 0;
    await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true }, {
      retryDelayMs: 0, requestModel: async () => { calls += 1; throw failure; },
    }), /不会自动改用原尾帧/u); assert.equal(calls, 1);
  }
});

await test('strict cancellation during retry backoff or a later request forbids further requests and late results', async () => {
  for (const phase of ['backoff', 'request'] as const) {
    const controller = new AbortController(); let calls = 0; const boundaries: number[] = [];
    await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true, signal: controller.signal,
      onBeforeAI: async (attempt) => { boundaries.push(attempt!.attempt); },
      onProgress: (message) => { if (phase === 'backoff' && /准备自动重试/u.test(message)) controller.abort(); },
    }, { retryDelayMs: 0, requestModel: async () => {
      calls += 1; if (calls === 1) throw new TextModelResponseError('length', '达到最大输出额度');
      controller.abort(); return '{"selectedId":"frame-2"}';
    } }), { name: 'AbortError' });
    assert.equal(calls, phase === 'backoff' ? 1 : 2); assert.deepEqual(boundaries, phase === 'backoff' ? [1] : [1, 2]);
  }
});

await test('a later charging-journal failure is fatal rather than another AI retry', async () => {
  const events: string[] = [];
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true, onBeforeAI: async (attempt) => {
    events.push(`boundary-${attempt!.attempt}`); if (attempt!.attempt === 2) throw new Error('retry checkpoint failed');
  } }, { retryDelayMs: 0, requestModel: async () => { events.push('request-1'); throw new TextModelResponseError('length', '达到最大输出额度'); } }), /retry checkpoint failed/u);
  assert.deepEqual(events, ['boundary-1', 'request-1', 'boundary-2']);
});

await test('strict timeout leaves remote outcome unknown and does not auto-repurchase analysis', async () => {
  let calls = 0; let signal: AbortSignal | undefined;
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true }, {
    retryDelayMs: 0, timeoutMs: 2, requestModel: async (_config, _system, _user, activeSignal) => { calls += 1; signal = activeSignal; return new Promise<string>(() => {}); },
  }), /超时.*远端结果未确认.*停止自动重试/u);
  assert.equal(calls, 1); assert.equal(signal?.aborted, true);
});

await test('strict retries reuse extracted candidates and thumbnails, never reconstruct source video', async () => {
  const h = fixture(); const original = { ...h.input, source: { ...h.input.source } }; let calls = 0; let thumbnails = 0;
  const result = await extractVideoTailFrameSelection({ ...h.input, requireAiSelection: true }, {
    retryDelayMs: 0, prepareImage: async (value) => { thumbnails += 1; return value; },
    requestModel: async (_config, _system, _user, _signal, options) => {
      calls += 1; assert.equal(options?.referenceImages?.length, 6);
      if (calls < 4) throw new TextModelResponseError('reasoning_only', '只返回了思考内容，没有正文');
      return '{"selectedId":"frame-3","reason":"保留背影动作。"}';
    },
  });
  assert.equal(calls, 4); assert.equal(h.requests.length, 2); assert.equal(h.reads.length, 6); assert.equal(thumbnails, 6);
  assert.equal(result.selection.source, 'ai'); assert.equal(result.frame.checksum, 'checksum-2');
  assert.deepEqual(h.input.source, original.source); assert.equal(h.input.previousPrompt, original.previousPrompt); assert.equal(h.input.nextPrompt, original.nextPrompt);
});

await test('all-attempt failure keeps its cause and count but redacts secret and image echoes', async () => {
  let calls = 0; const progress: string[] = [];
  await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true, onProgress: (message) => progress.push(message) }, {
    retryDelayMs: 0, requestModel: async () => { calls += 1; throw new TextModelHttpError(503, `HTTP 503 服务暂时不可用 ${config.apiKey} ${png}`); },
  }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /已自动重试 3\/3 次.*503/u);
    for (const text of [error.message, ...progress]) { assert.ok(!text.includes(config.apiKey)); assert.ok(!text.includes(png)); }
    return true;
  }); assert.equal(calls, 4);
});

await test('invalid explicit retry allowances cannot accidentally enable default four attempts', async () => {
  for (const maxAiAttempts of [0, -1, NaN, Infinity, -Infinity]) {
    let calls = 0;
    await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true, maxAiAttempts }, {
      retryDelayMs: 0, requestModel: async () => { calls += 1; throw new TextModelResponseError('length', '达到最大输出额度'); },
    }), /最大输出额度/u); assert.equal(calls, 1, `invalid authorization ${maxAiAttempts} must be single-attempt`);
  }
});

await test('explicit output cap is respected even below 256 and never regrows beyond the provider limit', async () => {
  for (const status of [400, 422]) {
    const tokens: number[] = [];
    const result = await recommendVideoTailFrame({ ...selectionInput(), requireAiSelection: true }, {
      retryDelayMs: 0, requestModel: async (activeConfig) => {
        tokens.push(activeConfig.maxTokens);
        if (tokens.length === 1) throw new TextModelHttpError(status, 'Invalid max_tokens value: valid range is [1, 128]');
        if (tokens.length === 2) throw new TextModelResponseError('length', '达到最大输出额度');
        return '{"selectedId":"frame-6"}';
      },
    }); assert.equal(result.source, 'ai'); assert.deepEqual(tokens, [4096, 128, 128]);
  }
});

await test('input or context limits are not misread as permission to change output allowance', async () => {
  for (const message of [
    'max_tokens exceeds context window maximum 4096',
    'max_tokens must be at most 4096 because input tokens exceed limit',
    'max_tokens maximum is 4096; prompt too long',
    'max_tokens exceeds window maximum 4096',
  ]) {
    let calls = 0;
    await assert.rejects(recommendVideoTailFrame({ ...selectionInput(), config: { ...config, maxTokens: 8192 }, requireAiSelection: true }, {
      retryDelayMs: 0, requestModel: async () => { calls += 1; throw new TextModelHttpError(400, message); },
    }), /不会自动改用原尾帧/u); assert.equal(calls, 1, 'unknown input/context limit must not cause a speculative new request');
  }
});

await test('real transport retry preserves six images and only sends thinking flags for supported DeepSeek', async () => {
  const originalWindow = globalThis.window; const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Live network is disabled in frame retry protocol tests'); };
  try {
    for (const provider of ['deepseek', 'openai_compatible', 'claude'] as const) {
      const bodies: Array<Record<string, unknown>> = [];
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
        request: async (request: { body?: string }) => {
          bodies.push(JSON.parse(request.body!));
          return { status: 200, body: JSON.stringify(provider === 'claude'
            ? bodies.length === 1 ? { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }], stop_reason: 'max_tokens' }
              : { content: [{ type: 'text', text: '{"selectedId":"frame-6"}' }], stop_reason: 'end_turn' }
            : bodies.length === 1 ? { choices: [{ message: { content: null, reasoning_content: 'PRIVATE_REASONING' }, finish_reason: 'length' }] }
              : { choices: [{ message: { content: '{"selectedId":"frame-6"}' }, finish_reason: 'stop' }] }) };
        },
      } } });
      const activeConfig = { ...config, provider }; const unchanged = { ...activeConfig };
      const result = await recommendVideoTailFrame({ ...selectionInput(), config: activeConfig, requireAiSelection: true }, { retryDelayMs: 0 });
      assert.equal(result.source, 'ai'); assert.equal(bodies.length, 2); assert.deepEqual(bodies.map((body) => body.max_tokens), [4096, 8192]);
      assert.equal(bodies[0].thinking, undefined);
      if (provider === 'deepseek') assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
      else assert.equal(bodies[1].thinking, undefined, 'non-DeepSeek protocols must not receive an invented thinking flag');
      for (const body of bodies) {
        const messages = body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
        assert.equal(messages.find((message) => message.role === 'user')!.content.filter((part) => part.type === (provider === 'claude' ? 'image' : 'image_url')).length, 6);
        assert.equal(body.reasoning_effort, undefined); assert.equal(body.max_output_tokens, undefined);
      }
      assert.deepEqual(activeConfig, unchanged); assert.ok(!JSON.stringify(result).includes('PRIVATE_REASONING'));
    }
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow });
  }
});

await test('strict one-frame clip still asks AI and accepts its own last-frame choice', async () => {
  const h = fixture(); h.desktop.extractWorkbenchFrames = async () => h.result([frame(5)]); let calls = 0;
  const selected = await extractVideoTailFrameSelection({ ...h.input, requireAiSelection: true }, {
    prepareImage: async (data) => data,
    requestModel: async (_config, _system, user) => {
      calls += 1; const payload = JSON.parse(user); assert.equal(payload.candidates.length, 1);
      return JSON.stringify({ selectedId: payload.candidates[0].id, reason: '唯一帧也是最适合的末帧。' });
    },
  });
  assert.equal(calls, 1); assert.equal(selected.selection.source, 'ai'); assert.equal(selected.frame.timeSec, frame(5).timeSec);
});

console.log(`video frame selection: ${count} tests passed`);
