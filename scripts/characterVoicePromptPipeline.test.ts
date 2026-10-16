import assert from 'node:assert/strict';
import { characterVoiceIdentityFacts, currentCharacterVoiceFacts } from '../src/characterVoiceFacts';
import { buildOfficialH3SourceFingerprint } from '../src/officialPrompt';
import { officialH3ContextForStoryboard } from '../src/officialH3Context';
import { buildOfficialSeedanceInput } from '../src/seedanceSource';
import { getOfficialSeedanceSourceFingerprint, generateOfficialSeedancePrompt, translateSeedancePromptToEnglish } from '../src/seedancePrompt';
import { generateSingleSegmentPrompt } from '../src/singleSegmentPrompt';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import { requestShotRecommendation } from '../src/services/llm';
import { createInitialState } from '../src/storage';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { Character, ConverterPreset, Storyboard, TextApiConfig, VideoSequencePlan } from '../src/types';

// Production data builders and request paths, with local model responses only.
const frozen: Character = { id: 'voice-person', name: '夏提雅', gender: '女', apparentAge: '18岁', actualAge: '实际200岁',
  race: '长寿人形角色', appearance: '年轻面容', outfit: '红色铠甲', signatureProps: '', personality: '冷酷、强硬',
  motionHabits: '', anchor: '红色铠甲', negativeContinuity: '', assetIds: [],
  voiceProfile: { version: 1, perceivedAge: '青年女性', timbre: '清亮', source: 'manual' } };
const current: Character = { ...frozen, name: '当前资料的新名字', apparentAge: '21岁', appearance: '当前新外观',
  voiceProfile: { version: 2, perceivedAge: '18至22岁的青年女声', timbre: '清透、轻盈', language: '中文', accent: '普通话',
    style: '吐字清晰', notes: '威严只通过停顿与力度表达', referenceAssetId: 'voice-sample', source: 'manual' } };
const source = '夏提雅低声而强硬地说：“现在离开这里。”';
const canonical = '【0s-15s】主体：@夏提雅 正在 [面对门口说话后观察对方]；空间：大厅；光影：冷光；镜头：固定中景；台词：第2s至第6s夏提雅：“现在离开这里。”；音效：无';
const board: Storyboard = { id: 'voice-board', sceneId: 'voice-scene', sequencePlanId: 'voice-plan', sourceStoryContent: source,
  workflow: 'drama', inputMode: 'text', durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '16:9', resolution: '720p', audioMode: 'stereo', stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '',
  finalPrompt: canonical, createdAt: 1, updatedAt: 1,
  audioLedger: [{ id: 'voice-cue', kind: 'dialogue', label: '驱离', speaker: frozen.name, speakerId: frozen.id,
    text: '现在离开这里。', startSec: 2, endSec: 6, notes: '保持已确认的青年声龄' }],
  shots: [{ id: 'voice-shot', index: 1, startSec: 0, endSec: 15, subject: frozen.name, action: '说话后观察对方', purpose: '警告',
    camera: '固定中景', lighting: '冷光', sound: '既有对白', transition: '自然结束', referenceAssetIds: [], prompt: canonical, locked: false }],
};
const project = { ...structuredClone(createInitialState().project), characters: [current], assets: [], locations: [], props: [], scenes: [],
  storyboards: [board], sequencePlans: [{ id: 'voice-plan', planningMode: 'semantic-segments', segments: [],
    semanticPlanningSnapshot: { characterContinuity: [frozen] } } as unknown as VideoSequencePlan] };
const baseline = JSON.stringify({ project, board });
const context = officialH3ContextForStoryboard(project, board);
assert.equal(context.characters?.[0].name, frozen.name, 'voice edits cannot thaw the frozen narrative identity');
assert.equal(context.characters?.[0].apparentAge, '18岁');
assert.equal(context.characters?.[0].voiceProfile?.version, 1, 'the frozen source keeps its original voice evidence');
assert.deepEqual(context.currentCharacterVoiceFacts, currentCharacterVoiceFacts([frozen], [current]));
assert.equal(context.currentCharacterVoiceFacts?.[0].voiceProfile?.perceivedAge, current.voiceProfile?.perceivedAge);
assert.equal(context.currentCharacterVoiceFacts?.[0].name, frozen.name);
assert.deepEqual(currentCharacterVoiceFacts([frozen], [{ id: frozen.id }])[0].voiceProfile, null, 'removal is explicit absence, never a silence command');
assert.equal(characterVoiceIdentityFacts({ name: '未定人物', gender: '女', apparentAge: '年轻外貌' }).voiceProfile, undefined,
  'ordinary facts never create a voice profile or pitch');

const input = buildOfficialSeedanceInput(project, board);
const facts = input.sourceEvidence?.characterIdentityFacts as ReturnType<typeof characterVoiceIdentityFacts>[];
assert.deepEqual(facts[0], characterVoiceIdentityFacts(frozen));
assert.deepEqual(input.sourceEvidence?.audioLedgerFacts, board.audioLedger);
assert.equal(input.voiceFactScope, 'source-grounded-new-draft');
assert.equal((input.sourceEvidence?.currentCharacterVoiceFacts as typeof context.currentCharacterVoiceFacts)?.[0].voiceProfile?.version, 2);
const changedProject = structuredClone(project);
changedProject.characters[0].voiceProfile!.timbre = '用户新确认的柔和清亮';
assert.notEqual(getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(changedProject, board)), getOfficialSeedanceSourceFingerprint(input),
  'same-ID current voice edits invalidate the saved Seedance source without thawing ordinary facts');
assert.notEqual(buildOfficialH3SourceFingerprint(board, officialH3ContextForStoryboard(changedProject, board)), buildOfficialH3SourceFingerprint(board, context),
  'H3 source identity includes the same current voice edit');

const chinese = ['视频规格：15秒；16:9；720p；stereo。', '参考素材与职责：本次没有外部参考素材。',
  '主体连续性：夏提雅保持红色铠甲，声音为18至22岁的青年女声，清透、轻盈。', '一句话概述：夏提雅发出驱离警告。',
  '连续时间轴：\n【0s-15s】夏提雅（18至22岁的青年女声，清透、轻盈）第2至6秒低声而强硬地说：“现在离开这里。”随后观察对方；固定中景。',
  '全局约束：保持声龄与音色，威严仅通过本句停顿和力度表达，不添加配乐。'].join('\n');
const english = ['Video specification: 15 seconds; 16:9; 720p; stereo.', 'References and responsibilities: no external media.',
  'Subject continuity: 夏提雅 keeps red armor and a youthful female voice perceived as 18–22, clear and light.',
  'One-sentence summary: 夏提雅 gives a warning.',
  'Continuous timeline:\n【0s-15s】夏提雅, with the same clear, light female voice perceived as 18–22, says softly and firmly from 2 to 6 seconds: “现在离开这里。” Then watches the other person; fixed medium shot.',
  'Global constraints: keep the voice age and timbre; express authority through pauses and delivery strength. No music.'].join('\n');
const readData = (user: string, tag: string): Record<string, any> => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `missing production data envelope ${tag}`);
  return JSON.parse(match[1]);
};
const converter: ConverterPreset = { id: 'voice-converter', name: '声音传输测试', workflow: 'all', inputMode: 'all', scope: 'video',
  enabled: true, version: 'test', systemPrompt: '保留原剧情。', outputRules: '保留普通六字段。', updatedAt: 1 };
const stages: string[] = [];
const generated = await generateSingleSegmentPrompt({ board, context, converter, targetPromptFormat: 'seedance', clean: (value) => value,
  buildSeedanceInput: (candidate) => buildOfficialSeedanceInput(project, candidate),
  request: async (system, user, stage) => {
    stages.push(stage);
    if (stage === 'convert') {
      const data = readData(user, 'video_conversion_data');
      assert.deepEqual(data.characterIdentityFacts[0].voiceProfile, frozen.voiceProfile);
      assert.equal(data.characterIdentityFacts[0].apparentAge, '18岁');
      assert.equal(data.characterIdentityFacts[0].actualAge, '实际200岁');
      assert.deepEqual(data.currentCharacterVoiceFacts, context.currentCharacterVoiceFacts);
      assert.equal(data.voiceFactScope, 'source-grounded-new-draft');
      return canonical;
    }
    if (stage === 'review') {
      const data = readData(user, 'seedance_source_data');
      assert.equal(data.voiceFactScope, 'source-grounded-new-draft');
      assert.deepEqual(data.sourceEvidence.characterIdentityFacts, facts);
      assert.deepEqual(data.sourceEvidence.audioLedgerFacts, board.audioLedger);
      assert.deepEqual(data.sourceEvidence.currentCharacterVoiceFacts, context.currentCharacterVoiceFacts);
      assert.match(system, /不自动增加听感年龄、压低基础声区/u);
      assert.match(system, /临时选角.*不冒充用户确认事实/u);
      return chinese;
    }
    assert.match(system, /不从新voiceProfile、外观年龄、实际年龄或样音备注重新选角/u);
    assert.ok(!user.includes('"voiceProfile":'), 'translation receives confirmed prose, not a newer casting dossier');
    return english;
  },
});
assert.deepEqual(stages, ['convert', 'review', 'translate']);
assert.equal(generated.seedance25Output?.promptZh, chinese);
assert.equal(generated.seedance25Output?.promptEn, english);
assert.doesNotMatch(chinese, /voiceProfile|voiceFactScope|<d>|\[Shot/u);

// Existing/reference operation owns preservation even when a new dossier is available.
const preserved = { ...generated, promptTrace: { mode: 'text-api' as const, modelRuleSetId: '', converterPresetId: converter.id,
  sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1, convertedPromptFingerprint: sourceContentHash(canonical) } };
await generateSingleSegmentPrompt({ board: preserved, context, converter, purpose: 'reference-refresh', skipConversion: true,
  voiceFactScope: 'source-grounded-new-draft', // A visual-only purpose cannot be widened by this hint.
  targetPromptFormat: 'seedance', clean: (value) => value, buildSeedanceInput: (candidate) => buildOfficialSeedanceInput(project, candidate),
  request: async (_system, user, stage) => {
    if (stage === 'review') { assert.equal(readData(user, 'seedance_source_data').voiceFactScope, 'preserve-confirmed-source'); return chinese; }
    assert.equal(stage, 'translate'); return english;
  },
});
await generateSingleSegmentPrompt({ board: preserved, context, converter, skipConversion: true,
  voiceFactScope: 'source-grounded-new-draft', targetPromptFormat: 'seedance', clean: (value) => value,
  buildSeedanceInput: (candidate) => buildOfficialSeedanceInput(project, candidate),
  request: async (_system, user, stage) => {
    if (stage === 'review') { assert.equal(readData(user, 'seedance_source_data').voiceFactScope, 'source-grounded-new-draft'); return chinese; }
    assert.equal(stage, 'translate'); return english;
  },
});
assert.equal(await translateSeedancePromptToEnglish({ sourcePrompt: chinese, request: async (system, user) => {
  assert.match(system, /听感声龄、音色/u);
  assert.ok(user.includes('18至22岁的青年女声，清透、轻盈'), 'protected translation input retains the authored voice direction');
  return english;
} }), english);

// Exact H3 protocol shape stays unchanged; voice direction remains outside spoken text.
const shot = '[Shot 1] 夏提雅(S1)，18至22岁的青年女声，清透、轻盈。第2至6秒低声说<d>[Chinese] 现在离开这里。</d>，随后观察对方。';
assert.deepEqual(readH3PromptProtocol(`integrated_multimodal_description: ${shot}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`).sections,
  ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music']);
assert.deepEqual(readH3PromptProtocol(`subject_definitions: 夏提雅，红色铠甲。\nsummary: 驱离警告。\nretention_analysis: 保持身份。\ndetailed_description: ${shot}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`).sections,
  ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);

// Actual planner transport must retain structured ages/profile, not just appearance prose.
const previousWindow = globalThis.window;
let planningRequests = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async (payload: { body: string }) => {
  planningRequests += 1;
  const body = JSON.parse(payload.body);
  const data = readData(body.messages.find((message: { role: string }) => message.role === 'user').content, 'storyboard_planning_data');
  assert.deepEqual(data.characterContinuity[0].voiceProfile, frozen.voiceProfile);
  assert.equal(data.characterContinuity[0].gender, '女');
  assert.equal(data.characterContinuity[0].apparentAge, '18岁');
  assert.equal(data.characterContinuity[0].actualAge, '实际200岁');
  assert.deepEqual(data.currentCharacterVoiceFacts, context.currentCharacterVoiceFacts);
  assert.equal(data.voiceFactScope, 'source-grounded-new-draft');
  assert.match(body.messages[0].content, /自然读音时长优先/u);
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reason: '原句自然说完后观察，固定十五秒。', breakdown: ['完整发话'],
    shots: [{ startSec: 0, endSec: 15, sourceExcerpt: source, purpose: '警告', subject: frozen.name, action: '第2至6秒说完原话后观察',
      camera: '固定中景', transition: '自然结束', lighting: '冷光', sound: '现在离开这里。', result: '已说完并观察' }] }) } }] }) };
} } } });
try {
  const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://voice.example.test/v1/chat/completions',
    apiKey: 'offline-voice-test', model: 'mock', temperature: 0, maxTokens: 4096, vision: false };
  const planned = await requestShotRecommendation(config, { durationSec: 15, workflow: 'drama', pace: 'standard', story: source,
    characterContinuity: [frozen], currentCharacterVoiceFacts: context.currentCharacterVoiceFacts });
  assert.equal(planned.shots.length, 1); assert.equal(planned.shots[0].endSec, 15);
  assert.equal(planningRequests, 1, 'no extra model audit or automatic retry is added');
} finally {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow });
}
assert.equal(JSON.stringify({ project, board }), baseline, 'voice planning cannot mutate saved source or frozen voices');
console.log('Character voice prompt pipeline: frozen/current evidence, age/profile payloads, fingerprints, scopes, translation and H3/Seedance format passed.');
