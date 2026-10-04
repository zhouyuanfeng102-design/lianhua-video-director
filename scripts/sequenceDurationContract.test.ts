import assert from 'node:assert/strict';
import { requestStoryDurationEstimate, requestShotRecommendation, requestAiStorySegmentation } from '../src/services/llm';
import { assertMasterSegmentDurationContract, assertSequenceSegmentDurationContract, diagnoseMasterSegmentDurationContract, requestedSegmentDurationWindows } from '../src/sequenceDurationContract';
import type { AiStoryboardShotPlan, TextApiConfig } from '../src/types';

const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://duration-fixture.example.test/v1/chat/completions', apiKey: 'mock-only', model: 'mock-duration-model', temperature: 0.2, maxTokens: 8000, vision: false };
const story = '林舟打开院门，说：“师姐，我们一起上山。”小师姐收好钥匙，二人沿石阶走向山门。';
const beats = [{ id: 'original-beat', index: 1, text: story, sourceStart: 0, sourceEnd: story.length, weight: 1, kind: 'visible-action' as const }];
const estimateInput = { title: '整倍数回归', story, beats, segmentDurationSec: 15 };
const invalidEstimate = { minSec: 75, recommendedSec: 80, maxSec: 100, fitStatus: 'balanced', reason: '完整原文初步估时。' };
const validEstimate = { minSec: 75, recommendedSec: 90, maxSec: 105, fitStatus: 'balanced', reason: '已按15秒一段选择90秒完整叙事，不改写剧情。' };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
type Payload = { url: string; headers?: Record<string, string>; body?: string };
const calls: Array<{ system: string; user: string }> = [];
const install = (reply: (system: string, user: string, call: number) => unknown): void => {
  calls.length = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async (payload: Payload) => {
      assert.equal(payload.url, config.baseUrl);
      assert.equal(payload.headers?.Authorization, 'Bearer mock-only');
      const body = JSON.parse(payload.body!);
      assert.equal(body.model, config.model);
      const system = body.messages.find((item: { role: string }) => item.role === 'system').content;
      const user = body.messages.find((item: { role: string }) => item.role === 'user').content;
      calls.push({ system, user });
      const value = reply(system, user, calls.length);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) };
    },
  } } });
};
const dataOf = (user: string, tag: string) => JSON.parse(user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'))![1]);
const shotAt = (startSec: number, endSec: number, index: number): AiStoryboardShotPlan => ({
  startSec, endSec, sourceExcerpt: story, purpose: `AI叙事${index}`, subject: '林舟与小师姐', action: `AI完整动作${index}，保留原文人物和因果。`, camera: '平视中景', transition: '同侧动作衔接', lighting: '晨光', sound: '无', result: `AI镜尾${index}`, space: '石阶', direction: '面朝山门上行', performance: '听者闭口', dialogue: '无',
});

try {
  globalThis.fetch = async () => { throw new Error('No real network is allowed in duration regression'); };
  assert.throws(() => requestedSegmentDurationWindows(80, 15), /90秒.*旧稿保持不变/u);
  assert.deepEqual(requestedSegmentDurationWindows(90, 15).map((window) => window.durationSec), [15, 15, 15, 15, 15, 15]);
  for (const segment of [1, 7, 16, 30, 300]) {
    const windows = requestedSegmentDurationWindows(segment * 3, segment);
    assert.equal(windows.length, 3);
    assertSequenceSegmentDurationContract(windows, segment * 3, segment);
    assertMasterSegmentDurationContract(windows.map((window) => ({ startSec: window.globalStartSec, endSec: window.globalEndSec })), segment * 3, segment);
  }

  // Contract diagnostics identify the exact failing shot and keep the
  // effective full-film total in the message; the categories are technical
  // transport/structure failures, not a local semantic/content gate.
  assert.throws(
    () => assertMasterSegmentDurationContract([
      { startSec: 0, endSec: 15 },
      { startSec: 16, endSec: 30 },
    ], 30, 15),
    (error: unknown) => error instanceof Error
      && /^\[gap-overlap\]/u.test(error.message)
      && /第2镜/u.test(error.message)
      && /上一镜end=15秒/u.test(error.message)
      && /本镜start=16秒/u.test(error.message)
      && /有效总时长=30秒/u.test(error.message),
    'a gap reports the previous end, current bounds, and effective total',
  );
  assert.throws(
    () => assertMasterSegmentDurationContract([
      { startSec: 0, endSec: 15 },
      { startSec: 15, endSec: 31 },
    ], 30, 15),
    (error: unknown) => error instanceof Error
      && /^\[overflow\]/u.test(error.message)
      && /第2镜/u.test(error.message)
      && /本镜start=15秒/u.test(error.message)
      && /end=31秒/u.test(error.message)
      && /有效总时长=30秒/u.test(error.message),
    'an overflow reports the exact offending shot',
  );
  assert.throws(
    () => assertMasterSegmentDurationContract([
      { startSec: 0, endSec: 15 },
      { startSec: 15, endSec: Number.NaN },
    ], 30, 15),
    (error: unknown) => error instanceof Error
      && /^\[invalid\]/u.test(error.message)
      && /第2镜/u.test(error.message)
      && /有效总时长=30秒/u.test(error.message),
    'non-finite shot bounds are reported as invalid',
  );

  const missingBoundaryDiagnostic = diagnoseMasterSegmentDurationContract([
    { startSec: 0, endSec: 15 },
    { startSec: 15, endSec: 30 },
    { startSec: 30, endSec: 45 },
    { startSec: 45, endSec: 60 },
    { startSec: 60, endSec: 75 },
    { startSec: 75, endSec: 101 },
    { startSec: 101, endSec: 105 },
    { startSec: 105, endSec: 120 },
    { startSec: 120, endSec: 135 },
    { startSec: 135, endSec: 150 },
    { startSec: 150, endSec: 165 },
    { startSec: 165, endSec: 180 },
    { startSec: 180, endSec: 195 },
    { startSec: 195, endSec: 210 },
    { startSec: 210, endSec: 225 },
    { startSec: 225, endSec: 240 },
  ], 240, 15);
  assert.equal(missingBoundaryDiagnostic?.kind, 'missing-boundary');
  assert.deepEqual(missingBoundaryDiagnostic?.missingBoundaries, [90]);
  assert.deepEqual(missingBoundaryDiagnostic?.crossingShots, [{ shotIndex: 6, startSec: 75, endSec: 101 }]);
  assert.match(missingBoundaryDiagnostic?.message || '', /90秒镜头边界.*第6镜（75–101秒）/u);
  assert.doesNotMatch(missingBoundaryDiagnostic?.message || '', /秒秒/u);
  assert.deepEqual(
    missingBoundaryDiagnostic?.expectedWindows.map((window) => [window.globalStartSec, window.globalEndSec]),
    [[75, 90], [90, 105]],
  );

  // Each repair receives the newest failed candidate and its exact numeric
  // evidence, while the original answer remains available only as a content
  // reference. The third repair may succeed without another AI-review call.
  const windows240 = requestedSegmentDurationWindows(240, 15);
  const validShots240 = windows240.map((window, index) => shotAt(window.globalStartSec, window.globalEndSec, index));
  const wrongShots240 = (missingBoundary: number): AiStoryboardShotPlan[] => {
    const times = [0, ...windows240.map((window) => window.globalEndSec)].filter((time) => time !== missingBoundary);
    return times.slice(0, -1).map((start, index) => shotAt(start, times[index + 1], index));
  };
  const masterParams240 = { durationSec: 240, requiredSegmentDurationSec: 15, workflow: 'drama', pace: 'normal', story };
  const repairCandidates240 = [
    { reason: 'initial-master', shots: wrongShots240(90) },
    { reason: 'reviewed-master', shots: wrongShots240(90) },
    { reason: 'first-repair', shots: wrongShots240(105) },
    { reason: 'second-repair', shots: wrongShots240(120) },
    { reason: 'third-repair-complete', shots: validShots240 },
  ];
  const masterRepairProgress: Array<{ attempt: number; maxAttempts: number; detail: string }> = [];
  install((system, user, call) => {
    assert.match(system, /权威固定窗口清单/u);
    if (call >= 3) {
      const data = dataOf(user, 'storyboard_repair_data');
      const missingBoundary = [90, 105, 120][call - 3];
      assert.equal(data.repairAttempt, call - 2);
      assert.equal(data.originalStoryboardResponse, JSON.stringify(repairCandidates240[0]));
      assert.equal(data.previousRepairResponse, JSON.stringify(repairCandidates240[call - 2]), 'repair continues from the newest exact AI response');
      assert.equal(data.durationSec, 240);
      assert.equal(data.masterTimelineDiagnostic.kind, 'missing-boundary');
      assert.deepEqual(data.masterTimelineDiagnostic.allWindows, windows240);
      assert.deepEqual(data.masterTimelineDiagnostic.missingBoundaries, [missingBoundary]);
      assert.deepEqual(data.masterTimelineDiagnostic.crossingShots, [{ shotIndex: missingBoundary / 15, startSec: missingBoundary - 15, endSec: missingBoundary + 15 }]);
      assert.deepEqual(data.masterTimelineDiagnostic.expectedWindows.map((window: { globalStartSec: number; globalEndSec: number }) => [window.globalStartSec, window.globalEndSec]), [[missingBoundary - 15, missingBoundary], [missingBoundary, missingBoundary + 15]]);
      assert.match(data.validationError, new RegExp(`${missingBoundary}秒`, 'u'));
    }
    return repairCandidates240[call - 1];
  });
  const repairedOnThird = await requestShotRecommendation(config, masterParams240, { reviewWithAi: true, onRepair: (progress) => masterRepairProgress.push(progress) });
  assert.equal(calls.length, 5, 'one generation, one AI review and exactly three same-API repairs');
  assert.deepEqual(masterRepairProgress.map(({ attempt, maxAttempts }) => [attempt, maxAttempts]), [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(repairedOnThird.shots, validShots240, 'successful result is the third AI repair, never a locally synthesized grid');

  // Unauthorized or malformed estimate metadata cannot replace the active
  // timeline contract in the repair diagnostic.
  const declaredExpansion = { minSec: 255, recommendedSec: 255, maxSec: 255, fitStatus: 'balanced', reason: '候选自行声明延长。' };
  const overlongShots = [...validShots240.slice(0, -1), shotAt(225, 255, 15)];
  install((_system, user, call) => {
    if (call === 3) {
      const data = dataOf(user, 'storyboard_repair_data');
      assert.equal(data.durationSec, 240);
      assert.equal(data.masterTimelineDiagnostic.totalDurationSec, 240, 'no expansion was authorized');
      assert.equal(data.masterTimelineDiagnostic.kind, 'overflow');
      assert.deepEqual(data.masterTimelineDiagnostic.offendingShot, { shotIndex: 16, startSec: 225, endSec: 255, previousEndSec: 225 });
    }
    return call === 3 ? { shots: validShots240 } : { durationEstimate: declaredExpansion, shots: overlongShots };
  });
  assert.deepEqual((await requestShotRecommendation(config, masterParams240, { reviewWithAi: true })).shots, validShots240);
  assert.equal(calls.length, 3);
  for (const malformedEstimate of [{ recommendedSec: 255 }, { ...declaredExpansion, minSec: 270 }]) {
    install((_system, user, call) => {
      if (call === 3) {
        const data = dataOf(user, 'storyboard_repair_data');
        assert.equal(data.durationSec, 240);
        assert.equal(data.masterTimelineDiagnostic, undefined, 'invalid estimate remains an estimate-schema error, not a false 255-second contract');
        assert.match(data.validationError, /最短时长|minSec/u);
      }
      return call === 3 ? { shots: validShots240 } : { durationEstimate: malformedEstimate, shots: overlongShots };
    });
    assert.deepEqual((await requestShotRecommendation(config, { ...masterParams240, allowDurationExpansion: true }, { reviewWithAi: true })).shots, validShots240);
    assert.equal(calls.length, 3);
  }

  const savedMaster = { shots: validShots240, marker: 'existing-saved-master' };
  let visibleMaster: unknown = savedMaster;
  install(() => repairCandidates240[1]);
  await assert.rejects(async () => {
    visibleMaster = await requestShotRecommendation(config, masterParams240, { reviewWithAi: true });
  }, /全片时间轴仍未闭合.*自动修复 3 次.*未覆盖已有结果.*90秒/u);
  assert.equal(calls.length, 5, 'persistent numeric failures stop after three repairs');
  assert.equal(visibleMaster, savedMaster, 'failure does not replace the caller-owned saved result');

  // Cancellation at later attempts is checked just like the first attempt;
  // neither a callback nor a late third-repair response can commit new data.
  for (const cancellation of ['abort', 'stale'] as const) {
    const controller = new AbortController();
    let current = true;
    install(() => repairCandidates240[1]);
    await assert.rejects(requestShotRecommendation(config, masterParams240, {
      reviewWithAi: true, signal: controller.signal, isCurrent: () => current,
      onRepair: ({ attempt }) => { if (attempt === 3) { if (cancellation === 'abort') controller.abort(); else current = false; } },
    }), { name: 'AbortError' });
    assert.equal(calls.length, 4, 'cancellation from third-repair progress prevents the fifth API request');
  }
  let finalResponseCurrent = true;
  install((_system, _user, call) => {
    if (call === 5) finalResponseCurrent = false;
    return repairCandidates240[call - 1];
  });
  await assert.rejects(async () => {
    visibleMaster = await requestShotRecommendation(config, masterParams240, { reviewWithAi: true, isCurrent: () => finalResponseCurrent });
  }, { name: 'AbortError' });
  assert.equal(calls.length, 5);
  assert.equal(visibleMaster, savedMaster, 'a stale but otherwise successful third repair is not committed');

  for (const reviewAlreadyFixed of [true, false]) {
    install((system, user, call) => {
      assert.match(system, /正整数倍/u);
      if (call === 1) {
        assert.equal(dataOf(user, 'story_data').story, story);
        assert.equal(dataOf(user, 'story_data').segmentDurationSec, 15);
        return invalidEstimate;
      }
      const data = dataOf(user, call === 2 ? 'story_duration_review_data' : 'story_duration_repair_data');
      assert.equal(data.originalData.story, story);
      assert.equal(data.originalData.segmentDurationSec, 15);
      assert.equal(JSON.parse(call === 2 ? data.candidateEstimate : data.previousResponse).recommendedSec, 80);
      return call === 2 && !reviewAlreadyFixed ? invalidEstimate : validEstimate;
    });
    const result = await requestStoryDurationEstimate(config, estimateInput);
    assert.deepEqual(result, validEstimate, 'only AI-authored whole-multiple estimate reaches the caller');
    assert.equal(calls.length, reviewAlreadyFixed ? 2 : 3);
  }
  install(() => invalidEstimate);
  await assert.rejects(requestStoryDurationEstimate(config, estimateInput), /未覆盖旧估时或计划/u);
  assert.equal(calls.length, 3, 'estimate repair is bounded to one extra API request');

  // An AI “insufficient” verdict is not handed to the user as a manual
  // correction task.  The same text model receives the full source again and
  // raises all three values to a usable 15-second multiple.
  install((system, _user, call) => {
    assert.match(system, /主动增加到更高的 segmentDurationSec 整数倍/u);
    return call === 3 ? validEstimate : { ...validEstimate, fitStatus: 'insufficient' };
  });
  const selfRaisedEstimate = await requestStoryDurationEstimate(config, estimateInput);
  assert.deepEqual(selfRaisedEstimate, validEstimate);
  assert.equal(calls.length, 3, 'insufficient duration is repaired by the AI before returning to the UI');

  // The same AI-owned repair path also handles an over-large answer instead
  // of letting an out-of-range number reach the UI and wait for manual fixes.
  install((_system, _user, call) => call === 3
    ? validEstimate
    : { minSec: 3600, recommendedSec: 3615, maxSec: 3630, fitStatus: 'balanced', reason: '超出全片上限的候选估时。' });
  const cappedEstimate = await requestStoryDurationEstimate(config, estimateInput);
  assert.deepEqual(cappedEstimate, validEstimate, 'AI repairs an over-3600-second candidate before it is committed');
  assert.equal(calls.length, 3);

  for (const staleAt of [1, 2, 3]) {
    let current = true;
    install((_system, _user, call) => { if (call === staleAt) current = false; return invalidEstimate; });
    await assert.rejects(requestStoryDurationEstimate(config, estimateInput, undefined, { isCurrent: () => current }), { name: 'AbortError' });
    assert.equal(calls.length, staleAt, 'a stale estimate never spends another request or commits');
  }
  install(() => invalidEstimate);
  const legacy = await requestStoryDurationEstimate(config, { title: 'legacy', story, beats });
  assert.equal(legacy.recommendedSec, 80); assert.equal(calls.length, 1, 'legacy unspecified-duration callers retain their behavior');
  for (const segment of [1, 7, 30, 300]) {
    const estimate = { ...validEstimate, minSec: segment, recommendedSec: segment * 2, maxSec: segment * 3 };
    install(() => estimate);
    assert.deepEqual(await requestStoryDurationEstimate(config, { ...estimateInput, segmentDurationSec: segment }), estimate);
    const modelShots = [shotAt(0, segment, 0), shotAt(segment, segment * 2, 1)];
    install(() => ({ shots: modelShots }));
    const custom = await requestShotRecommendation(config, { durationSec: segment * 2, requiredSegmentDurationSec: segment, workflow: 'drama', pace: 'normal', story }, { reviewWithAi: true });
    assert.deepEqual(custom.shots, modelShots, 'custom duration is not overwritten by a hard-coded15-second cap');
    const masterShots = modelShots.map((shot, index) => ({ ...shot, id: `custom-${index}`, index: index + 1, authoredBy: 'text-api' as const, prompt: shot.action, sourceBeatIds: [] }));
    const segments = masterShots.map((shot, index) => ({
      sourceShotIds: [shot.id], sourceBeatIds: [], boundaryAfterShotId: shot.id, durationSec: segment,
      globalStartSec: shot.startSec, globalEndSec: shot.endSec, title: `第${index + 1}段`, content: shot.action,
      summary: '完整动作', narrativePurpose: '保留原文', entryState: '保持位置', exitState: '继续前行', transitionHint: '同侧衔接', boundaryReason: '按用户秒数', continuityPack: '身份不变',
    }));
    install(() => ({ segments }));
    const grouped = await requestAiStorySegmentation(config, { title: '自定义秒数', story, beats, totalDurationSec: segment * 2, maxSegmentDurationSec: segment, preferredSegmentDurationSec: segment, masterShots }, undefined, { reviewWithAi: true });
    assert.deepEqual(grouped.segments.map((item) => item.durationSec), [segment, segment]);
  }

  // Screenshot shape: AI previously used 0/6/15/24/30/39/45/54/63/72/80.
  // At the new 90-second target it must itself author the missing60/75 cuts.
  const wrongTimes = [0, 6, 15, 24, 30, 39, 45, 54, 63, 72, 90];
  const fixedTimes = [0, 6, 15, 24, 30, 39, 45, 54, 60, 69, 75, 82, 90];
  const wrongShots = wrongTimes.slice(0, -1).map((start, index) => shotAt(start, wrongTimes[index + 1], index));
  const fixedShots = fixedTimes.slice(0, -1).map((start, index) => shotAt(start, fixedTimes[index + 1], index));
  install((_system, user, call) => {
    if (call === 3) {
      const data = dataOf(user, 'storyboard_repair_data');
      assert.equal(data.sourceStory, story);
      assert.equal(data.durationSec, 90);
      assert.equal(data.requiredSegmentDurationSec, 15);
      assert.deepEqual(data.internalHardBoundariesSec, [15, 30, 45, 60, 75]);
      assert.match(data.validationError, /60秒/u);
    }
    return { shots: call === 3 ? fixedShots : wrongShots };
  });
  const planned = await requestShotRecommendation(config, { durationSec: 90, requiredSegmentDurationSec: 15, workflow: 'drama', pace: 'normal', story }, { reviewWithAi: true });
  assert.equal(calls.length, 3); assert.deepEqual(planned.shots, fixedShots, 'timings and body come from the AI repair byte-for-byte');
  const masterShots = planned.shots.map((shot, index) => ({ ...shot, id: `master-${index}`, index: index + 1, authoredBy: 'text-api' as const, prompt: `【${shot.startSec}s-${shot.endSec}s】${shot.action}`, sourceBeatIds: [] }));
  const segments = requestedSegmentDurationWindows(90, 15).map((window) => {
    const ids = masterShots.filter((shot) => shot.startSec >= window.globalStartSec && shot.endSec <= window.globalEndSec).map((shot) => shot.id);
    return { ...window, sourceShotIds: ids, sourceBeatIds: [], boundaryAfterShotId: ids[ids.length - 1], title: `AI第${window.index}段`, content: 'AI完整剧情段', summary: 'AI摘要', narrativePurpose: '推进原文因果', entryState: '上一段动作继续', exitState: '保持向山门前行', transitionHint: '同轴', boundaryReason: '所选15秒窗口', continuityPack: '人物与行进方向不变' };
  });
  const malformedGroups = [{ ...segments[0], sourceShotIds: masterShots.map((shot) => shot.id), globalEndSec: 90, durationSec: 90, boundaryAfterShotId: masterShots[masterShots.length - 1].id }];
  install((_system, user, call) => {
    const tag = call === 1 ? 'ai_segmentation_data' : call === 2 ? 'ai_segmentation_review_data' : 'ai_segmentation_repair_data';
    const data = dataOf(user, tag);
    assert.deepEqual((call === 1 ? data : data.originalData).requiredSegmentWindows, requestedSegmentDurationWindows(90, 15));
    return { segments: call === 3 ? segments : malformedGroups };
  });
  const grouped = await requestAiStorySegmentation(config, { title: '90秒', story, beats, totalDurationSec: 90, maxSegmentDurationSec: 15, preferredSegmentDurationSec: 15, masterShots, sourceSceneIds: [] }, undefined, { reviewWithAi: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(grouped.segments.map((segment) => segment.durationSec), [15, 15, 15, 15, 15, 15]);
  assert.deepEqual(grouped.segments.flatMap((segment) => segment.sourceShotIds), masterShots.map((shot) => shot.id));

  // Regression for the reported shape: a 135-second full prompt with 16
  // complete master shots.  The review model must receive the exact 15-second
  // window-to-shot map; it must not infer groups from prose and return one
  // malformed long segment.  The repair request receives the same authority.
  const times135 = [0, 6, 15, 24, 30, 39, 45, 54, 60, 69, 75, 84, 90, 99, 105, 120, 135];
  const masterShots135 = times135.slice(0, -1).map((start, index) => ({
    ...shotAt(start, times135[index + 1]!, index),
    id: `master-135-${index + 1}`,
    index: index + 1,
    authoredBy: 'text-api' as const,
    prompt: `【${start}s-${times135[index + 1]}s】完整镜头${index + 1}`,
    sourceBeatIds: [],
  }));
  const segments135 = requestedSegmentDurationWindows(135, 15).map((window) => {
    const ids = masterShots135
      .filter((shot) => shot.startSec >= window.globalStartSec && shot.endSec <= window.globalEndSec)
      .map((shot) => shot.id);
    return {
      ...window,
      sourceShotIds: ids,
      sourceBeatIds: [],
      boundaryAfterShotId: ids[ids.length - 1],
      title: `AI第${window.index}段`, content: 'AI完整剧情段', summary: 'AI摘要',
      narrativePurpose: '推进原文因果', entryState: '上一段动作继续', exitState: '保持动作方向',
      transitionHint: '同轴衔接', boundaryReason: '固定15秒窗口', continuityPack: '人物、位置、光线和声音连续',
    };
  });
  assert.equal(masterShots135.length, 16);
  assert.equal(segments135.length, 9);
  const malformed135 = segments135.map((segment, index) => index === 0
    ? { ...segment, sourceShotIds: masterShots135.map((shot) => shot.id), globalEndSec: 135, durationSec: 135, boundaryAfterShotId: masterShots135[15]!.id }
    : { ...segment, sourceShotIds: [] });
  const gridPayloads: Array<{ system: string; user: string }> = [];
  install((system, user, call) => {
    gridPayloads.push({ system, user });
    const tag = call === 1 ? 'ai_segmentation_data' : call === 2 ? 'ai_segmentation_review_data' : 'ai_segmentation_repair_data';
    const data = dataOf(user, tag);
    const originalData = call === 1 ? data : data.originalData;
    assert.deepEqual(originalData.requiredSegmentWindows, requestedSegmentDurationWindows(135, 15));
    assert.equal(originalData.fixedSegmentGrid.segmentCount, 9);
    assert.deepEqual(originalData.fixedSegmentGrid.segments.map((segment: { sourceShotIds: string[] }) => segment.sourceShotIds), segments135.map((segment) => segment.sourceShotIds));
    if (call === 3) assert.deepEqual(data.authoritativeFixedSegmentGrid.segments, originalData.fixedSegmentGrid.segments);
    return { segments: call === 3 ? segments135 : malformed135 };
  });
  const grouped135 = await requestAiStorySegmentation(config, {
    title: '135秒固定网格', story, totalDurationSec: 135, maxSegmentDurationSec: 15,
    preferredSegmentDurationSec: 15, allowedSegmentDurationsSec: [15], beats,
    masterShots: masterShots135, sourceSceneIds: [],
  }, undefined, { reviewWithAi: true });
  assert.equal(gridPayloads.length, 3, 'wrong review grouping is repaired by the same API');
  assert.ok(gridPayloads.every(({ system }) => /fixedSegmentGrid|固定网格/u.test(system)));
  assert.deepEqual(grouped135.segments.map((segment) => [segment.globalStartSec, segment.globalEndSec, segment.durationSec]), requestedSegmentDurationWindows(135, 15).map((window) => [window.globalStartSec, window.globalEndSec, window.durationSec]));
  assert.deepEqual(grouped135.segments.flatMap((segment) => segment.sourceShotIds), masterShots135.map((shot) => shot.id));
  assert.equal(estimateInput.story, story, 'complete original story remains untouched through estimate, planning and grouping');
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  globalThis.fetch = originalFetch;
}
console.log('sequence duration contract: AI estimate80→90, full15-second windows, AI missing-cut/group repair, custom durations, bounded failure and stale cancellation passed');
