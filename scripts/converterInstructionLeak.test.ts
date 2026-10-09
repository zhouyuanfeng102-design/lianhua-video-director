import assert from 'node:assert/strict';
import { convertStoryboardDraftToFinal, hasCurrentTextApiConversion } from '../src/appEffects';
import { h3OutputRetryDecision } from '../src/h3OutputRecovery';
import { VideoPromptInstructionLeakError } from '../src/videoPromptInstructionLeak';
import type { ConverterPreset, Storyboard, VideoShot } from '../src/types';

const speech = '转换器输出这个标题是我的课程内容，不要输出规则解释，requiredDialogues 是屏幕上的字。';
const canonical = `【0s-5s】 主体：@讲师（平静）[朝向：观众] 正在 [指向黑板]（演示课堂内容）；空间：前景-讲台 中景-讲师 背景-黑板；光影：窗边自然光；镜头：稳定中景；台词：第1s @讲师：“${speech}”；音效：环境层-[教室轻响] 动作层-[指示棒接触声] 情绪层-[无配乐]`;
const converter: ConverterPreset = { id: 'instruction-boundary-converter', name: '合成转换测试', workflow: 'all', inputMode: 'all',
  scope: 'video', enabled: true, version: 'test', systemPrompt: '根据完整剧情组织动作，requiredDialogues 逐句保留原话与说话人。',
  outputRules: '只输出完整六字段正文。不要输出规则解释。', updatedAt: 1 };
const shot: VideoShot = { id: 'instruction-boundary-shot', index: 1, startSec: 0, endSec: 5, subject: '讲师', action: '指向黑板',
  purpose: '演示课堂内容', camera: '稳定中景', transition: '自然承接', lighting: '窗边自然光', sound: '教室轻响', result: '讲解完毕',
  referenceAssetIds: [], prompt: canonical, locked: false };
const makeDraft = (): Storyboard => ({ id: 'instruction-boundary-board', sceneId: 'instruction-boundary-scene',
  sourceStoryContent: `讲师指向黑板，说：“${speech}”`, workflow: 'drama', inputMode: 'text', durationSec: 5, durationPreset: '5s',
  shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: converter.id, globalLock: '', finalPrompt: canonical, shots: [structuredClone(shot)],
  englishPrompt: 'previous English', englishPromptSource: canonical, createdAt: 1, updatedAt: 1,
  targetOutput: { targetId: 'seedance-2.5', prompt: 'previous saved output', parameters: { seed: 77 }, referenceManifest: [], warnings: [], generatedAt: 1 },
  promptPlan: { canonicalPrompt: canonical, durationSec: 5, aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', workflow: 'drama',
    inputMode: 'text', shotIds: [shot.id], referenceAssetIds: [], constraints: [], trace: { ruleSetId: '', converterId: converter.id } } });
const ruleEcho = '转换器 智能导演：先依据 requiredDialogues 安排完整对白，逐句保留原话和说话人。\n转换器输出：不要输出规则解释，只输出完整六字段正文。';
const terminalLeak = (error: unknown): boolean => {
  assert.ok(error instanceof VideoPromptInstructionLeakError);
  assert.equal(error.retryable, false);
  assert.match(error.message, /生成规则或转换器输出要求.*原稿已保留/u);
  assert.equal(h3OutputRetryDecision(error, { maxTokens: 4096, growthCeiling: 65536 }).retry, false);
  assert.equal(error.message.includes(speech), false, 'errors do not echo private story or the rejected response');
  return true;
};

// A success-looking echo must fail before both strict structural repair and
// the permissive intermediate-candidate path can save canonical/finalPrompt.
for (const acceptAiAuthoredContent of [false, true]) {
  for (const output of [ruleEcho, `\`\`\`text\n${ruleEcho}\n\`\`\``, `${canonical}\n${ruleEcho}`]) {
    const draft = makeDraft(); const before = structuredClone(draft); let calls = 0; let candidate: Storyboard | undefined;
    await assert.rejects(async () => { candidate = await convertStoryboardDraftToFinal({ draft, converter, acceptAiAuthoredContent,
      clean: () => { throw new Error('response must not be silently hidden by the UI cleaner'); }, request: async () => { calls += 1; return output; } }); }, terminalLeak);
    assert.equal(calls, 1, 'rule leakage is terminal, without a structural repair or another paid request');
    assert.equal(candidate, undefined);
    assert.deepEqual(draft, before, 'previous canonical, finalPrompt, target output and translations are unchanged');
  }
}

// Envelope quotes must not disguise rules. Only actual text fields are read;
// trusted request rules and delivery metadata are not scanned as story prose.
for (const key of ['canonicalPrompt', 'finalPrompt', 'h3Prompt', 'seedancePrompt', 'englishPrompt']) {
  const draft = makeDraft(); const before = structuredClone(draft); let calls = 0;
  const body = JSON.stringify({ [key]: ruleEcho, metadata: { note: 'ordinary metadata' } });
  await assert.rejects(() => convertStoryboardDraftToFinal({ draft, converter, acceptAiAuthoredContent: true,
    clean: (value) => value, request: async () => { calls += 1; return `\`\`\`json\n${body}\n\`\`\``; } }), terminalLeak);
  assert.equal(calls, 1); assert.deepEqual(draft, before);
}

// If the existing structural repair is necessary for an unrelated malformed
// timeline, a repair response that contains rules still cannot be committed.
{
  const draft = makeDraft(); const before = structuredClone(draft); let calls = 0;
  await assert.rejects(() => convertStoryboardDraftToFinal({ draft, converter, clean: (value) => value,
    request: async () => { calls += 1; return calls === 1 ? canonical.replace(' 正在 [', ' 动作 [') : ruleEcho; } }), terminalLeak);
  assert.equal(calls, 2, 'one pre-existing structure repair is allowed; leakage adds no further request');
  assert.deepEqual(draft, before);
}

// The same terms can be authored dialogue or on-screen content. Preserve the
// complete real answer, and do not reject the converter rules in request input.
for (const acceptAiAuthoredContent of [false, true]) {
  const draft = makeDraft(); const before = structuredClone(draft); let calls = 0;
  const result = await convertStoryboardDraftToFinal({ draft, converter, acceptAiAuthoredContent, clean: (value) => value,
    request: async (system, user) => {
      calls += 1; assert.match(system, /requiredDialogues.*逐句保留/u); assert.match(system, /不要输出规则解释/u);
      assert.match(user, /转换器输出这个标题/u); return canonical;
    } });
  assert.equal(calls, 1); assert.equal(result.finalPrompt, canonical); assert.equal(result.promptPlan?.canonicalPrompt, canonical);
  assert.ok(hasCurrentTextApiConversion(result)); assert.ok(result.finalPrompt.includes(speech)); assert.deepEqual(draft, before);
}
console.log('Video conversion instruction boundary passed: rule echoes stop before candidate writes or extra requests; decoded JSON bodies, existing repair, and authored dialogue remain safe (synthetic mocks only).');
