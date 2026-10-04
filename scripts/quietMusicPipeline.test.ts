import assert from 'node:assert/strict';
import {
  AUDIO_EXISTING_SCOPE_RULE, AUDIO_H3_DELIVERY_RULE, AUDIO_PROMPT_RULE, AUDIO_TRANSLATION_SCOPE_RULE,
  DIEGETIC_AUDIO_SCOPE_RULE, NATURAL_BACKGROUND_MUSIC_RULE, STORY_DRIVEN_MUSIC_RULE,
} from '../src/audioPromptPolicy';
import { H3_DIALOGUE_FORMAT_RULE, H3_FINAL_BODY_FORMAT_RULE, readH3PromptProtocol } from '../src/h3PromptProtocol';
import { applyOfficialH3Prompt, hasCurrentOfficialH3EnglishPrompt, type OfficialH3ProjectContext } from '../src/officialPrompt';
import { translateVideoPromptToEnglish } from '../src/promptTranslation';
import { buildSequencePromptHandoff } from '../src/sequencePromptHandoff';
import { regenerateSequenceReferencePrompt } from './fixtures/h3PipelineMock';
import { requestShotRecommendation } from '../src/services/llm';
import { generateSingleSegmentPrompt, type SingleSegmentPromptStage } from './fixtures/h3PipelineMock';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { AiStoryboardShotPlan, ConverterPreset, Storyboard, TextApiConfig, VideoSegment, VideoSequencePlan, VideoShot } from '../src/types';

// Synthetic source, model replies and request callbacks only. These tests
// verify the contracts sent to AI and preservation of its complete reply;
// they do not pretend that a mock can measure a video model's audio output.
type HttpPayload = { url: string; headers?: Record<string, string>; body?: string };
type HttpResult = { status: number; body: string };
interface AudioFixture {
  id: string;
  audioMode: 'stereo' | 'none';
  requirement: string;
  dialogue: [string, string];
  sound: [string, string];
  englishSound: [string, string];
  soundscape: string;
  englishSoundscape: string;
  music: string;
  englishMusic: string;
}
const tests: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>) => tests.push({ name, run });
const context: OfficialH3ProjectContext = { assets: [], characters: [] };
const converter: ConverterPreset = {
  id: 'quiet-music-mock-converter', name: '合成音频测试转换器', workflow: 'all', inputMode: 'all', scope: 'video',
  systemPrompt: '按合成原稿生成正文。', outputRules: '保持镜数和时间边界。', enabled: true, version: 'mock', updatedAt: 1,
};
const config: TextApiConfig = {
  enabled: true, provider: 'openai_compatible', baseUrl: 'https://quiet-music.mock.invalid/v1/chat/completions',
  apiKey: 'synthetic-not-a-real-credential', model: 'mock-audio-text-model', temperature: 0, maxTokens: 8192, vision: false,
};
const spoken = '第1s @合成甲：“明日见。”';
const softScore = '离别节点有轻而稀疏的古琴短句，极低音量、远在对白与放盒声后面，讲话时降至近静音；句间与无对白镜头不抬升，无鼓点、无高潮，轻入轻出。';
const softScoreEn = 'A sparse, very quiet guqin phrase supports the farewell, far behind speech and the box contact; nearly silent during speech, never louder in pauses or silent shots, no drums or climax, gentle entrance and exit.';
const fixtures: AudioFixture[] = [
  {
    id: 'story-score', audioMode: 'stereo', requirement: '故友离别，配乐可以有但要自然贴合剧情、非常轻。',
    dialogue: [spoken, '无'],
    sound: ['环境层-[无] 动作层-[第3s轻放木盒声] 情绪层-[极轻古琴，给对白让位]', '环境层-[无] 动作层-[无] 情绪层-[极轻古琴，无对白时也不抬高]'],
    englishSound: ['No ambience; a soft box contact at 3s; very quiet guqin ducks beneath speech.', 'No ambience or action sound; the quiet guqin stays at the same low background level without dialogue.'],
    soundscape: '第1镜保留原对白自然音量与第3s轻放木盒声，不压低整条音轨；第2镜不添加动作声。',
    englishSoundscape: 'Keep the original speech at its natural foreground level and the soft box contact at 3s in Shot 1, without lowering the whole mix. No added action sounds in Shot 2.',
    music: softScore, englishMusic: softScoreEn,
  },
  {
    id: 'no-score', audioMode: 'stereo', requirement: '明确不要配乐，保留原对白和必要的同期动作声。',
    dialogue: [spoken, '无'],
    sound: ['环境层-[无] 动作层-[第3s轻放木盒声] 情绪层-[无配乐，不自动添加]', '环境层-[无] 动作层-[无] 情绪层-[无配乐，不自动添加]'],
    englishSound: ['No ambience; a soft box contact at 3s; no score and no automatic scoring.', 'No ambience, action sound or music; do not add a score.'],
    soundscape: '只有原对白和轻放木盒声，无声音事件时保持安静，不把N/A当作自动配乐。',
    englishSoundscape: 'Only the original dialogue and soft box contact; quiet between events. N/A does not invite automatic scoring.',
    music: 'N/A', englishMusic: 'N/A',
  },
  {
    id: 'silent', audioMode: 'none', requirement: '整段静音，不发声、无配乐。', dialogue: ['无', '无'],
    sound: ['环境层-[无] 动作层-[无] 情绪层-[无配乐]', '环境层-[无] 动作层-[无] 情绪层-[无配乐]'],
    englishSound: ['Silent, no sound or music.', 'Silent, no sound or music.'],
    soundscape: 'N/A', englishSoundscape: 'N/A', music: 'N/A', englishMusic: 'N/A',
  },
  {
    id: 'score-without-dialogue', audioMode: 'stereo', requirement: '故友无言告别，允许非常轻的配乐，无对白也不要升高音乐。',
    dialogue: ['无', '无'],
    sound: ['环境层-[无] 动作层-[第3s轻放木盒声] 情绪层-[远处极轻古琴，不遮挡放盒声]', '环境层-[无] 动作层-[无] 情绪层-[同一极低音量，不因无对白抬升]'],
    englishSound: ['No ambience; a soft box contact at 3s; guqin far in the background without masking it.', 'No ambience or action sound; the same very quiet score, never raised merely because nobody speaks.'],
    soundscape: '第1镜第3s轻放木盒声，原剧情没有对白，不添加人声或连续底噪。',
    englishSoundscape: 'Soft box contact at 3s in Shot 1. The source has no dialogue; no added voices or continuous noise.',
    music: softScore, englishMusic: softScoreEn,
  },
  {
    id: 'visible-weather-only', audioMode: 'stereo', requirement: '门外仅在画面中可见远处瀑布和风吹枝叶，原剧情没有听到它们的描写；不要配乐。',
    dialogue: ['无', '无'],
    sound: ['环境层-[无] 动作层-[第3s轻放木盒声] 情绪层-[无配乐]', '环境层-[无] 动作层-[无] 情绪层-[无配乐]'],
    englishSound: ['No ambient bed; the box makes one soft contact at 3s; no score.', 'No added environmental sound, foley or score.'],
    soundscape: 'N/A', englishSoundscape: 'N/A', music: 'N/A', englishMusic: 'N/A',
  },
  {
    id: 'late-distant-waterfall', audioMode: 'stereo', requirement: '木盒已放好后，门边的合成乙听见远处传来瀑布坠落声；只在本段第9至15秒对应的倾听事件中呈现，前面无环境声床，不要配乐。',
    dialogue: ['无', '无'],
    sound: ['环境层-[无] 动作层-[第3s轻放木盒声] 情绪层-[无配乐]', '环境层-[本镜第3s远处传来瀑布坠落声，保持远处听觉距离，至本镜第9s结束，不延伸到其它时段] 动作层-[无] 情绪层-[无配乐]'],
    englishSound: ['No ambient bed; one soft box contact at 3s; no score.', 'From shot-local 3s until 9s, a waterfall is heard in the distance during the listening event, retaining that distant perspective; no extension into other intervals, no added foley or score.'],
    soundscape: 'N/A', englishSoundscape: 'N/A', music: 'N/A', englishMusic: 'N/A',
  },
  {
    id: 'authored-cross-shot-rain', audioMode: 'stereo', requirement: '原剧情明确：两人在檐下告别，整个告别过程都能听到屋外同一场雨，机位没有离开檐下，不要非叙事配乐。',
    dialogue: [spoken, '无'],
    sound: ['环境层-[沿用同一屋外雨声，不叠加第二层] 动作层-[第3s轻放木盒声] 情绪层-[无配乐]', '环境层-[同一声源与听觉距离延续，切镜不重启] 动作层-[无] 情绪层-[无配乐]'],
    englishSound: ['The same outdoor rain source, not a second layer; a soft box contact at 3s; no score.', 'The same source and listening distance continue through the cut without restarting; no added foley or score.'],
    soundscape: '两镜内均在檐下听到屋外同一场雨，保持与对白的自然远近层级，切镜不重启、不重复叠加。',
    englishSoundscape: 'The same outdoor rain is audible from beneath the eaves across both shots, with a natural distance hierarchy beneath speech; it does not restart or form a second layer at the cut.',
    music: 'N/A', englishMusic: 'N/A',
  },
];
const sourceFor = (fixture: AudioFixture): string => [
  '两位成年故友在门边告别。合成甲将木盒放到桌面，随后松开手，合成乙仍站在门边。',
  ...(fixture.dialogue[0] === '无' ? [] : ['合成甲说：“明日见。”']), fixture.requirement,
].join('');
const plansFor = (fixture: AudioFixture): AiStoryboardShotPlan[] => [0, 1].map((index) => ({
  startSec: index === 0 ? 0 : 6, endSec: index === 0 ? 6 : 15, sourceExcerpt: sourceFor(fixture),
  purpose: index === 0 ? '告别时放好木盒' : '保留告别后的反应', subject: '合成甲、合成乙',
  action: index === 0 ? '合成甲将木盒放到桌面' : '合成甲松开手，合成乙仍站在门边',
  camera: '门口东侧静止中景，不越轴', transition: '保持机位一侧', lighting: '柔和窗光',
  sound: fixture.sound[index], result: index === 0 ? '木盒已在桌面' : '木盒不动，两人仍在门边',
  space: '桌面在画面左侧，门在右侧', direction: '合成甲面向右侧门口，合成乙面向合成甲',
  performance: '神情自然克制，合成乙听完后轻轻点头', dialogue: fixture.dialogue[index],
}));
const canonicalShot = (shot: AiStoryboardShotPlan): string => [
  `【${shot.startSec}s-${shot.endSec}s】 主体：@合成甲、@合成乙（克制）[朝向：${shot.direction}] 正在 [${shot.action}]（${shot.purpose}）`,
  `空间：${shot.space}`, `光影：${shot.lighting}`, `镜头：${shot.camera}`, `台词：${shot.dialogue}`, `音效：${shot.sound}`,
].join('；');
const boardFor = (fixture: AudioFixture): Storyboard => {
  const shots: VideoShot[] = plansFor(fixture).map((shot, index) => ({
    ...shot, id: `${fixture.id}-shot-${index + 1}`, index: index + 1, authoredBy: 'text-api',
    prompt: canonicalShot(shot), referenceAssetIds: [], locked: false,
  }));
  const finalPrompt = shots.map((shot) => shot.prompt).join('\n');
  return {
    id: `${fixture.id}-board`, sceneId: 'synthetic-farewell', sourceStoryContent: sourceFor(fixture),
    sourceContentHash: sourceContentHash(sourceFor(fixture)), workflow: 'drama', inputMode: 'text',
    durationSec: 15, durationPreset: '15s', shotMode: 'exact', shotCount: 2, pace: 'standard',
    aspectRatio: '16:9', resolution: '2K', audioMode: fixture.audioMode, stylePresetId: '',
    ruleSetId: 'synthetic-audio-rule', converterPresetId: converter.id, globalLock: '', extraRequirement: fixture.requirement,
    shots, finalPrompt, createdAt: 1, updatedAt: 1,
    promptTrace: {
      mode: 'text-api', shotPlanMode: 'ai-complete', convertedPromptFingerprint: sourceContentHash(finalPrompt),
      modelRuleSetId: 'synthetic-audio-rule', converterPresetId: converter.id, sourceDocumentIds: [], referenceAssetIds: [], generatedAt: 1,
    },
    targetModelId: 'minimax-h3', targetOutput: {
      targetId: 'minimax-h3', prompt: 'synthetic previous result', parameters: { seed: 24680, sampler: 'synthetic-sampler' },
      referenceManifest: [], warnings: [], generatedAt: 1,
    },
  };
};
// A complete mock model reply, not a production formatter or repair helper.
const modelH3 = (fixture: AudioFixture, english = false): string => [
  `integrated_multimodal_description: [Shot 1] ${english ? 'At the doorway, 合成甲 puts a wooden box on the table; 合成乙 listens. The east-side camera remains still.' : '门边，合成甲将木盒放到桌面，合成乙聆听，东侧静止中景。'} ${english ? 'Dialogue' : '台词'}：${fixture.dialogue[0]}；${english ? 'Audio' : '音效'}：${english ? fixture.englishSound[0] : fixture.sound[0]}`,
  '', `[Shot 2] At 00:06.000 ${english ? '合成甲 releases the box while 合成乙 remains by the door; the camera stays on the same side.' : '合成甲松开手，合成乙仍站在门边，摄影机保持同侧。'} ${english ? 'Dialogue' : '台词'}：${fixture.dialogue[1]}；${english ? 'Audio' : '音效'}：${english ? fixture.englishSound[1] : fixture.sound[1]}`,
  '', `overall_soundscape: ${english ? fixture.englishSoundscape : fixture.soundscape}`,
  '', `non_diegetic_music: ${english ? fixture.englishMusic : fixture.music}`,
].join('\n');
const block = (user: string, tag: string): Record<string, any> => {
  const match = user.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  assert.ok(match, `request must include ${tag}`);
  return JSON.parse(match[1]);
};
const noLocalCleaning = (): never => { throw new Error('An AI-reviewed sound body must never use local prose cleaning'); };
const assertAudioScope = (system: string, stage: SingleSegmentPromptStage, continuityOnly = false): void => {
  if (stage === 'translate') {
    assert.ok(system.includes(AUDIO_TRANSLATION_SCOPE_RULE), 'translation and its repairs receive source-only audio authority');
    assert.equal(system.includes(AUDIO_H3_DELIVERY_RULE), false, 'translation cannot re-plan audio from delivery rules');
    assert.equal(system.includes(NATURAL_BACKGROUND_MUSIC_RULE), false, 'translation cannot independently choose a new score/mix');
    return;
  }
  assert.equal(system.includes(AUDIO_H3_DELIVERY_RULE), !continuityOnly);
  assert.equal(system.includes(NATURAL_BACKGROUND_MUSIC_RULE), !continuityOnly);
  if (!continuityOnly) assert.ok(system.includes(AUDIO_PROMPT_RULE));
  if (!continuityOnly) assert.ok(system.includes(DIEGETIC_AUDIO_SCOPE_RULE),
    'existing generation calls distinguish visible scenery, timed diegetic events and justified cross-shot beds');
};
const assertUnchangedOutputControls = (result: Storyboard, board: Storyboard, expectedH3: string): void => {
  assert.equal(result.officialPromptZh, expectedH3, 'model-owned final Chinese, including audio, is saved verbatim');
  assert.equal(result.targetOutput?.prompt, expectedH3);
  assert.equal(result.finalPrompt, board.finalPrompt, 'H3 review does not rewrite canonical source');
  assert.equal(result.durationSec, 15); assert.equal(result.shotCount, 2);
  assert.equal(result.audioMode, board.audioMode);
  for (const field of ['startSec', 'endSec', 'dialogue', 'sound', 'camera', 'lighting', 'action'] as const) {
    assert.deepEqual(result.shots.map((shot) => shot[field]), board.shots.map((shot) => shot[field]), `${field} remains the saved plan, not locally rewritten audio`);
  }
  assert.deepEqual(result.targetOutput?.parameters, applyOfficialH3Prompt(board, context).targetOutput?.parameters,
    'new prose guidance does not add pretend volume API parameters or change existing controls');
};
const promptOf = (payload: HttpPayload, role: 'system' | 'user'): string => {
  const body = JSON.parse(payload.body || '{}') as { messages?: Array<{ role: string; content: string }> };
  return body.messages?.find((message) => message.role === role)?.content || '';
};
const response = (value: unknown): HttpResult => ({
  status: 200, body: JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }),
});

test('shared natural music contract is part of the existing planning audio policy', () => {
  for (const rule of [AUDIO_H3_DELIVERY_RULE, AUDIO_TRANSLATION_SCOPE_RULE, NATURAL_BACKGROUND_MUSIC_RULE]) assert.ok(rule.trim());
  assert.ok(STORY_DRIVEN_MUSIC_RULE.includes(NATURAL_BACKGROUND_MUSIC_RULE));
  assert.ok(AUDIO_PROMPT_RULE.includes(STORY_DRIVEN_MUSIC_RULE));
  assert.ok(AUDIO_PROMPT_RULE.includes(DIEGETIC_AUDIO_SCOPE_RULE));
  assert.match(H3_FINAL_BODY_FORMAT_RULE, /同一声源不在镜内与overall_soundscape重复铺设/u);
});

for (const fixture of fixtures) {
  test(`${fixture.id}: existing convert/review/translate calls carry the right scope and keep exact model audio`, async () => {
    const board = boardFor(fixture);
    const saved = JSON.stringify({ board, fixture, context });
    const stages: SingleSegmentPromptStage[] = [];
    const chinese = modelH3(fixture); const english = modelH3(fixture, true);
    let translations = 0;
    const result = await generateSingleSegmentPrompt({
      board, context, converter, sourceStoryContent: sourceFor(fixture), reviewWithAi: true, clean: noLocalCleaning, now: () => 100,
      request: async (system, user, stage) => {
        stages.push(stage); assertAudioScope(system, stage);
        assert.ok(stages.length <= 4, 'valid model audio does not add another API audit or music-generation phase');
        if (stage === 'convert') {
          const data = block(user, 'video_conversion_data');
          assert.deepEqual(data.shotEvidence.map((shot: any) => shot.plannedSound), fixture.sound);
          assert.deepEqual(data.shotEvidence.map((shot: any) => shot.plannedDialogue), fixture.dialogue);
          assert.equal(data.sourceStoryContent, sourceFor(fixture));
          return board.finalPrompt;
        }
        if (stage === 'review') {
          const data = block(user, 'video_staging_review_data');
          assert.deepEqual(data.shots.map((shot: any) => shot.sound), fixture.sound);
          assert.equal(data.audioMode, fixture.audioMode);
          assert.deepEqual(readH3PromptProtocol(chinese), readH3PromptProtocol(data.candidatePrompt));
          return `\n${chinese}\n`;
        }
        if (++translations === 1) assert.equal(user, chinese, 'translation uses final reviewed Chinese audio, not stale plan fields');
        else {
          const data = block(user, 'review_data');
          assert.equal(data.sourcePrompt, chinese); assert.equal(data.candidateEnglishPrompt, english);
          assert.deepEqual(data.stagingContext.shots.map((shot: any) => shot.sound), fixture.sound);
        }
        return english;
      },
    });
    assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
    assertUnchangedOutputControls(result, board, chinese);
    assert.equal(result.officialPromptEn, english, 'English audio is the exact model review response');
    assert.equal(result.officialPromptEnSource, chinese);
    assert.equal(result.officialPromptEnError, '', 'a successful English audio review must not leave a stale error diagnostic');
    assert.deepEqual(readH3PromptProtocol(english), readH3PromptProtocol(chinese));
    assert.equal(hasCurrentOfficialH3EnglishPrompt(result, context), true);
    assert.equal(JSON.stringify({ board, fixture, context }), saved);
  });
}

test('conversion structure repair and Chinese/English H3 repairs receive phase-specific audio contracts', async () => {
  const fixture = fixtures[0]; const board = boardFor(fixture); const saved = JSON.stringify(board);
  const chinese = modelH3(fixture); const english = modelH3(fixture, true);
  const brokenCanonical = board.finalPrompt.replace(' 正在 [', ' 动作槽 [');
  const stages: SingleSegmentPromptStage[] = [];
  let conversions = 0; let reviews = 0; let translations = 0;
  const result = await generateSingleSegmentPrompt({
    board, context, converter, reviewWithAi: true, clean: noLocalCleaning,
    request: async (system, user, stage) => {
      stages.push(stage);
      assertAudioScope(system, stage, stage === 'review' && reviews >= 1);
      if (stage === 'convert') {
        if (++conversions === 1) return brokenCanonical;
        assert.equal(conversions, 2);
        const data = block(user, 'video_conversion_structural_repair_data');
        assert.equal(data.invalidCandidate, brokenCanonical);
        assert.deepEqual(data.shotEvidence.map((shot: any) => shot.plannedSound), fixture.sound);
        return board.finalPrompt;
      }
      if (stage === 'review') {
        if (++reviews === 1) return board.finalPrompt;
        assert.equal(reviews, 2);
        const data = block(user, 'h3_format_repair_data');
        assert.equal(data.candidatePrompt, board.finalPrompt);
        assert.deepEqual(data.sourceContext.shots.map((shot: any) => shot.sound), fixture.sound);
        assert.deepEqual(data.requiredProtocol, readH3PromptProtocol(chinese));
        return chinese;
      }
      translations += 1;
      if (translations === 1) { assert.equal(user, chinese); return 'Incomplete mock translation.'; }
      if (translations === 2) {
        const data = block(user, 'review_data');
        assert.equal(data.sourcePrompt, chinese); assert.equal(data.candidateEnglishPrompt, 'Incomplete mock translation.');
        return 'Mock English review without H3 fields.';
      }
      assert.equal(translations, 3);
      const data = block(user, 'h3_format_repair_data');
      assert.equal(data.sourceContext.sourcePrompt, chinese);
      assert.equal(data.candidatePrompt, 'Mock English review without H3 fields.');
      assert.deepEqual(data.requiredProtocol, readH3PromptProtocol(chinese));
      return english;
    },
  });
  assert.deepEqual(stages, ['convert', 'convert', 'review', 'review', 'translate', 'translate', 'translate']);
  assertUnchangedOutputControls(result, board, chinese); assert.equal(result.officialPromptEn, english);
  assert.equal(result.officialPromptEnError, '', 'format-repaired English success clears the error diagnostic');
  assert.equal(JSON.stringify(board), saved);
});

test('direct translation, independent review and format repair use only source-confirmed audio', async () => {
  for (const fixture of [fixtures[0], fixtures[1]]) {
    const chinese = modelH3(fixture); const english = modelH3(fixture, true); let calls = 0;
    const result = await translateVideoPromptToEnglish({
      sourcePrompt: chinese, reviewWithAi: true, clean: noLocalCleaning,
      request: async (system, user) => {
        assertAudioScope(system, 'translate');
        if (++calls === 1) { assert.equal(user, chinese); return 'Incomplete mock translation.'; }
        if (calls === 2) { assert.equal(block(user, 'review_data').sourcePrompt, chinese); return 'Incomplete mock review.'; }
        assert.equal(calls, 3);
        assert.equal(block(user, 'h3_format_repair_data').sourceContext.sourcePrompt, chinese);
        return english;
      },
    });
    assert.equal(calls, 3); assert.equal(result, english);
    assert.deepEqual(readH3PromptProtocol(result), readH3PromptProtocol(chinese));
  }
});

for (const needsRepair of [false, true]) {
  test(`H3 dialogue ${needsRepair ? 'with format repairs' : 'without repairs'}: AI review owns speaker IDs and cross-cut dialogue without changing ordinary six fields`, async () => {
    const fixture: AudioFixture = {
      ...fixtures[1], id: 'official-h3-dialogue',
      dialogue: ['第5s @合成甲：“这盒药草交给你，”', '第0s @合成甲接上句：“明天带给师父。”；第5s @合成乙：“好。”'],
    };
    const source = '合成甲将木盒放在桌上，说：“这盒药草交给你，明天带给师父。”合成乙听完后答：“好。”整段不要背景配乐，保留对白和轻放木盒声。';
    const board = { ...boardFor(fixture), sourceStoryContent: source, sourceContentHash: sourceContentHash(source) };
    const chinese = [
      'integrated_multimodal_description: [Shot 1] 合成甲把木盒放到桌上，第5秒由合成甲(S1)说：<d>[Chinese] 这盒药草交给你，<scenetrans></d>音频连续进入下一镜，合成乙闭口聆听。',
      '[Shot 2] At 00:06.000, 合成甲(S1)延续同一句话：<d>[Chinese] <scenetrans>明天带给师父。</d>本镜第5秒合成乙(S2)回应：<d>[Chinese] 好。</d>合成甲闭口聆听。',
      'overall_soundscape: 轻放木盒声。',
      'non_diegetic_music: N/A',
    ].join('\n');
    const english = [
      'integrated_multimodal_description: [Shot 1] 合成甲 puts the box on the table. At 5s, 合成甲 (S1) says <d>[Chinese] 这盒药草交给你，<scenetrans></d> The audio continues uninterrupted into the next shot while 合成乙 listens with lips closed.',
      '[Shot 2] At 00:06.000, 合成甲 (S1) continues the same line from the previous shot: <d>[Chinese] <scenetrans>明天带给师父。</d> At 5s within this shot, 合成乙 (S2) replies <d>[Chinese] 好。</d> while 合成甲 listens with lips closed.',
      'overall_soundscape: A soft contact as the box is set down.',
      'non_diegetic_music: N/A',
    ].join('\n');
    const initialEnglish = english.replace('<d>[Chinese] 好。</d>', '<d>[English] Yes.</d>');
    const invalidChinese = chinese.replace('overall_soundscape:', 'soundscape:');
    const invalidEnglish = english.replace('overall_soundscape:', 'soundscape:');
    let reviews = 0; let translations = 0;
    const stages: SingleSegmentPromptStage[] = [];
    const result = await generateSingleSegmentPrompt({
      board, context, converter, sourceStoryContent: source, reviewWithAi: true, clean: noLocalCleaning,
      request: async (system, user, stage) => {
        stages.push(stage);
        if (stage === 'convert') {
          assert.equal(system.includes(H3_DIALOGUE_FORMAT_RULE), false, 'the ordinary six-field converter is not instructed to add H3 speaker/dialogue tags');
          assert.doesNotMatch(board.finalPrompt, /<d>|<scenetrans>|\(S\d+\)/u);
          return board.finalPrompt;
        }
        assert.ok(system.includes(H3_DIALOGUE_FORMAT_RULE), 'H3 review, translation and format repair all receive the official dialogue syntax instruction');
        if (stage === 'review') {
          assert.ok(system.includes(H3_FINAL_BODY_FORMAT_RULE), 'H3 Chinese review and protocol repair receive the final-body format contract');
        }
        if (stage === 'review') {
          reviews += 1;
          if (reviews === 1) {
            assert.equal(block(user, 'video_staging_review_data').sourceStoryContent, source);
            return needsRepair ? invalidChinese : chinese;
          }
          assert.equal(reviews, 2);
          const data = block(user, 'h3_format_repair_data');
          assert.equal(data.candidatePrompt, invalidChinese, 'the repair API sees the exact reviewed dialogue, not a local reconstruction');
          assert.equal(data.sourceContext.sourceStoryContent, source);
          return chinese;
        }
        translations += 1;
        assertAudioScope(system, stage);
        if (translations === 1) { assert.equal(user, chinese); return initialEnglish; }
        if (translations === 2) {
          const data = block(user, 'review_data');
          assert.equal(data.sourcePrompt, chinese);
          assert.equal(data.candidateEnglishPrompt, initialEnglish, 'even a changed spoken language reaches AI review unchanged; no local dialogue gate');
          return needsRepair ? invalidEnglish : english;
        }
        assert.equal(translations, 3);
        const data = block(user, 'h3_format_repair_data');
        assert.equal(data.sourceContext.sourcePrompt, chinese);
        assert.equal(data.candidatePrompt, invalidEnglish);
        return english;
      },
    });
    assert.deepEqual(stages, needsRepair
      ? ['convert', 'review', 'review', 'translate', 'translate', 'translate']
      : ['convert', 'review', 'translate', 'translate']);
    assertUnchangedOutputControls(result, board, chinese);
    assert.equal(result.officialPromptEn, english);
    assert.equal(result.officialPromptEnError, '');
    assert.deepEqual(readH3PromptProtocol(english), readH3PromptProtocol(chinese));
    assert.deepEqual(readH3PromptProtocol(chinese), readH3PromptProtocol(applyOfficialH3Prompt(board, context).officialPromptZh!));
    assert.doesNotMatch(result.finalPrompt, /<d>|<scenetrans>|\(S\d+\)/u, 'the canonical ordinary six-field format remains intact');
  });
}

test('long-story reference refresh currently keeps the saved audio plan instead of selecting new music', async () => {
  const fixture: AudioFixture = {
    ...fixtures[0],
    id: 'reference-refresh',
    music: '用户已确认的旧配乐：第1镜入场、第2镜保持，极低音量，讲话时让位。',
    englishMusic: 'The already confirmed old score enters in Shot 1 and continues in Shot 2 at a very low level, ducking during speech.',
  };
  const board = applyOfficialH3Prompt({
    ...boardFor(fixture), id: 'reference-refresh-board', sequencePlanId: 'reference-refresh-plan',
    segmentId: 'reference-refresh-segment', segmentIndex: 1, segmentCount: 1,
    globalStartSec: 0, globalEndSec: 15,
  }, context);
  const segment: VideoSegment = {
    id: board.segmentId!, index: 1, title: '参考图更新测试段', globalStartSec: 0, globalEndSec: 15, durationSec: 15,
    content: sourceFor(fixture), summary: '合成告别', sourceSceneIds: ['synthetic-farewell'], sourceBeatIds: [],
    narrativePurpose: '仅更新参考图', entryState: '手在木盒边', exitState: '木盒在桌面', transitionHint: '保持动作衔接',
    continuityPack: '人物和机位保持', storyboardId: board.id, status: 'ready',
  };
  const chinese = modelH3(fixture); const english = modelH3(fixture, true);
  const saved = JSON.stringify({ board, segment });
  const stages: SingleSegmentPromptStage[] = []; let translations = 0;
  const result = await regenerateSequenceReferencePrompt({
    mode: 'reference-refresh', board, segment, context, converter, reviewWithAi: true,
    clean: noLocalCleaning, request: async (system, user, stage) => {
      stages.push(stage);
      if (stage === 'translate') {
        assertAudioScope(system, stage);
        if (++translations === 1) { assert.equal(user, chinese); return english; }
        const data = block(user, 'review_data');
        assert.equal(data.sourcePrompt, chinese); assert.equal(data.candidateEnglishPrompt, english);
        assert.equal(data.stagingContext.audioLedger, undefined);
        return english;
      }
      assert.ok(system.includes(AUDIO_EXISTING_SCOPE_RULE), 'reference refresh receives source-locked audio scope');
      assert.equal(system.includes(AUDIO_H3_DELIVERY_RULE), false, 'reference refresh is not an audio redesign pass');
      assert.equal(system.includes(NATURAL_BACKGROUND_MUSIC_RULE), false, 'reference refresh cannot independently choose a score');
      if (stage === 'convert') {
        const data = block(user, 'video_conversion_data');
        assert.deepEqual(data.shotEvidence.map((shot: any) => shot.plannedSound), fixture.sound);
        assert.equal(data.sourceStoryContent, sourceFor(fixture));
        return board.finalPrompt;
      }
      const data = block(user, 'video_staging_review_data');
      assert.equal(data.revisionScope, 'reference-refresh-non-audio-only');
      assert.equal(data.candidatePrompt, applyOfficialH3Prompt(board, context).officialPromptZh);
      assert.deepEqual(data.shots.map((shot: any) => shot.sound), fixture.sound);
      assert.ok(system.includes('overall_soundscape、non_diegetic_music和逐镜音效原文保持'));
      return chinese;
    },
  });
  assert.deepEqual(stages, ['convert', 'review', 'translate', 'translate']);
  assert.equal(result.officialPromptZh, chinese);
  assert.equal(result.officialPromptEn, english);
  assert.equal(result.officialPromptEnError, '', 'successful reference-refresh English review has no stale error');
  assert.ok(result.officialPromptZh!.includes(fixture.music));
  assert.equal(JSON.stringify({ board, segment }), saved, 'reference refresh does not mutate the saved board or segment');
});

test('continuity-only repair preserves saved music and sounds without a new creative-audio pass', async () => {
  const fixture = fixtures[0];
  const boards = [1, 2].map((index) => applyOfficialH3Prompt({
    ...boardFor(fixture), id: `continuity-audio-board-${index}`, sequencePlanId: 'continuity-audio-plan',
    segmentId: `continuity-audio-segment-${index}`, segmentIndex: index, segmentCount: 2,
    globalStartSec: (index - 1) * 15, globalEndSec: index * 15,
  }, context));
  // Deliberately retain an older, custom score description that is not this
  // release's new default. A continuity-only action is not a mix redesign.
  const customFixture: AudioFixture = { ...fixture, music: '用户已保存的旧配乐安排，保持原曲、原进入时刻与原音量。' };
  boards[1] = { ...boards[1], officialPromptZh: modelH3(customFixture),
    targetOutput: { ...boards[1].targetOutput!, prompt: modelH3(customFixture) } };
  const segments: VideoSegment[] = boards.map((board, index) => ({
    id: board.segmentId!, index: index + 1, title: `合成第${index + 1}段`, globalStartSec: index * 15, globalEndSec: (index + 1) * 15,
    durationSec: 15, content: sourceFor(fixture), summary: '合成告别', sourceSceneIds: ['synthetic-farewell'], sourceBeatIds: [],
    narrativePurpose: '合成连续动作', entryState: '手在木盒边', exitState: '木盒在桌面', transitionHint: '承接松手动作',
    continuityPack: '桌面位置保持', storyboardId: board.id, status: 'ready',
  }));
  const plan: VideoSequencePlan = {
    id: 'continuity-audio-plan', title: '合成衔接', sourceStoryContent: sourceFor(fixture), sourceStoryTitle: '合成告别',
    durationMode: 'fixed', requestedTotalDurationSec: 30, totalDurationSec: 30, segmentDurationSec: 15,
    segmentationMode: 'fixed', fitStatus: 'balanced', segments, createdAt: 1, updatedAt: 1,
  };
  const project = { id: 'continuity-audio-project', storyboards: boards, sequencePlans: [plan] };
  const before = JSON.stringify(project);
  const handoff = buildSequencePromptHandoff(project, plan.id, segments[1].id);
  assert.equal(handoff.issue, undefined); assert.ok(handoff.context);
  const chinese = boards[1].officialPromptZh!;
  // The synthetic model changes visual opening prose only. This is not
  // production-side audio preservation by replacing or patching strings.
  const revised = chinese.replace('门边，合成甲将木盒放到桌面', '本段0.00–0.50秒接续上段末端动作；从0.50秒起合成甲将木盒放到桌面');
  const stages: SingleSegmentPromptStage[] = []; let translations = 0;
  const result = await generateSingleSegmentPrompt({
    board: boards[1], context, purpose: 'continuity-repair', sequenceHandoff: handoff.context, clean: noLocalCleaning,
    request: async (system, user, stage) => {
      stages.push(stage); assert.notEqual(stage, 'convert'); assertAudioScope(system, stage, true);
      if (stage === 'review') {
        const data = block(user, 'video_staging_review_data');
        assert.equal(data.revisionScope, 'adjacent-segment-continuity-only');
        assert.equal(data.candidatePrompt, chinese);
        assert.ok(system.includes('音效及non_diegetic_music原文保持'));
        return revised;
      }
      if (++translations === 1) assert.ok(user.startsWith(revised));
      else assert.equal(block(user, 'review_data').sourcePrompt, revised);
      // Keeping source prose in this mock intentionally isolates transport
      // ownership from language quality; normal translation is tested above.
      return revised;
    },
  });
  assert.deepEqual(stages, ['review', 'translate', 'translate']);
  assertUnchangedOutputControls(result, boards[1], revised);
  assert.ok(result.officialPromptZh!.includes(`non_diegetic_music: ${customFixture.music}`));
  for (const sound of fixture.sound) assert.ok(result.officialPromptZh!.includes(sound));
  assert.equal(result.officialPromptEn, revised);
  assert.equal(JSON.stringify(project), before, 'continuity transport never changes source plans or the preceding score');
});

for (const fixture of [fixtures[0], ...fixtures.slice(4)]) test(`${fixture.id}: planning, AI review and one JSON repair share scoped audio guidance and keep model-authored sounds`, async () => {
  const shots = plansFor(fixture);
  const plan = { reason: '告别动作与反应分两镜', breakdown: ['放盒', '反应'], shots };
  const original = JSON.stringify(plan);
  const missingCamera = JSON.stringify({ ...plan, shots: shots.map((shot, index) => index ? { ...shot, camera: '' } : shot) });
  const requests: HttpPayload[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true,
    value: { lianhuaDesktop: { request: async (payload: HttpPayload): Promise<HttpResult> => {
      requests.push(payload); assert.ok(requests.length <= 3, 'no separate music analysis API stage');
      const system = promptOf(payload, 'system');
      assert.ok(system.includes(AUDIO_PROMPT_RULE)); assert.ok(system.includes(NATURAL_BACKGROUND_MUSIC_RULE));
      assert.ok(system.includes(DIEGETIC_AUDIO_SCOPE_RULE), 'all existing planning stages carry source, temporal scope and non-duplication rules');
      const tag = ['storyboard_planning_data', 'storyboard_ai_review_data', 'storyboard_repair_data'][requests.length - 1];
      const data = block(promptOf(payload, 'user'), tag);
      assert.equal(data.sourceStory, sourceFor(fixture));
      if (requests.length >= 2) assert.equal(data.originalStoryboardResponse, original);
      if (requests.length === 3) assert.equal(data.previousRepairResponse, missingCamera);
      return response(requests.length === 2 ? missingCamera : original);
    } } },
  });
  const params: Parameters<typeof requestShotRecommendation>[1] = {
    story: sourceFor(fixture), durationSec: 15, workflow: 'drama', pace: 'standard', requiredSegmentDurationSec: 15,
    extraRequirement: fixture.requirement,
  };
  const saved = JSON.stringify({ params, shots });
  const result = await requestShotRecommendation(config, params, { reviewWithAi: true });
  assert.equal(requests.length, 3); assert.deepEqual(result.shots, shots);
  for (const request of requests) {
    assert.equal(request.url, requests[0].url); assert.deepEqual(request.headers, requests[0].headers);
  }
  assert.equal(JSON.stringify({ params, shots }), saved);
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('Real network is forbidden in quiet-music mock tests'); };
try {
  for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
  assert.equal(networkAttempts, 0);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as unknown as { window?: unknown }).window;
}
console.log(`quiet music pipeline: ${tests.length} synthetic cases passed; no network, actual project data or paid API used`);
