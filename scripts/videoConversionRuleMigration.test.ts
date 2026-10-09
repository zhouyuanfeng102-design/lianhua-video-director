import assert from 'node:assert/strict';
import {
  createInitialState, CURRENT_SCHEMA_VERSION, defaultConverterPresets, defaultRuleSets,
  defaultStoryExpansionPresets,
  legacyVideoConversionFactoryPresets, normalizeState, UNIFIED_VIDEO_CONVERTER_ID,
  LEGACY_AUDIO_PROMPT_RULE_V0_6_3,
} from '../src/storage';
import {
  DEFAULT_VIDEO_CONVERSION_OUTPUT, DEFAULT_VIDEO_CONVERSION_SYSTEM, VIDEO_DIALOGUE_RULE,
  VIDEO_CONVERSION_EXAMPLE, VIDEO_LOCAL_TIME_RULE,
  LEGACY_DEFAULT_VIDEO_CONVERSION_OUTPUT_V1_4_0, LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_3_0,
  LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_4_0, VIDEO_DIALOGUE_STAGING_RULE,
  LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_7_0,
  VIDEO_SPATIAL_CONTINUITY_RULE, VIDEO_STAGING_REVIEW_RULE, VIDEO_PROMPT_FOCUS_RULE,
  VIDEO_CAUSALITY_OUTPUT_RULE,
} from '../src/videoConversionRules';
import { AUDIO_PROMPT_RULE, DIALOGUE_DELIVERY_RULE } from '../src/audioPromptPolicy';
import { STORY_CAUSALITY_RULE } from '../src/storyCausalityRules';
import { STORY_AGE_FACT_PRESERVATION_RULE } from '../src/characterVocabulary';
import { legacyStoryPreparationV130 } from './fixtures/storyPreparationLegacyPresets';
import type { ConverterPreset, RuleSet } from '../src/types';
import { sourceContentHash } from '../src/sourceIntegrity';
import {
  MOSE_JIANGHU_NSFW_DETAIL_RULES,
} from '../src/nsfwPromptRules';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const timeline = defaultRuleSets.find((rule) => rule.id === 'timeline_director_cn')!;
const converter = defaultConverterPresets.find((preset) => preset.id === UNIFIED_VIDEO_CONVERTER_ID)!;
assert.equal(createInitialState().schemaVersion, CURRENT_SCHEMA_VERSION, 'rule fixtures use the current application schema');
assert.equal(timeline.version, '1.5.0');
assert.equal(converter.version, '1.8.0');
assert.equal(converter.systemPrompt, DEFAULT_VIDEO_CONVERSION_SYSTEM);
assert.equal(converter.outputRules, DEFAULT_VIDEO_CONVERSION_OUTPUT);
assert.ok(
  converter.systemPrompt.includes(MOSE_JIANGHU_NSFW_DETAIL_RULES),
  'the active video converter must retain the complete existing rule block',
);
assert.ok(timeline.baseRules.includes(VIDEO_CONVERSION_EXAMPLE));
assert.ok(timeline.baseRules.includes(VIDEO_LOCAL_TIME_RULE));
assert.ok(timeline.outputRules.includes(VIDEO_DIALOGUE_RULE));
assert.ok(timeline.outputRules.includes(AUDIO_PROMPT_RULE));
for (const rule of [VIDEO_DIALOGUE_STAGING_RULE, VIDEO_SPATIAL_CONTINUITY_RULE, VIDEO_STAGING_REVIEW_RULE, VIDEO_PROMPT_FOCUS_RULE]) {
  assert.ok(converter.systemPrompt.includes(rule), 'the live converter receives shared AI staging and self-repair instructions');
  assert.ok([timeline.baseRules, timeline.continuityRules, timeline.outputRules].join('\n').includes(rule),
    'the rule library exposes the same staging and self-repair contract');
}
const activeRules = [timeline.baseRules, timeline.continuityRules, timeline.outputRules, converter.systemPrompt, converter.outputRules].join('\n');
assert.doesNotMatch(activeRules, /4\.5字\/秒|0\.18秒|0\.28秒|按原句标点截取|连两个字都无法容纳|不足1\.2秒|1–3|色温K值/u,
  'retired time-capacity, dialogue-cropping and mechanical formatting requirements cannot reach new default requests');

// Normalize the fixture once so unrelated historic locationId -> locationIds backfill is not this migration's diff.
const initial = normalizeState(createInitialState());
const projectBefore = clone(initial.project);
// Normalization may deliberately retain optional keys with undefined values
// (for example videoSource). Compare normalized memory to normalized memory.
const settingsBefore = structuredClone(initial.settings);
const oldRules = legacyVideoConversionFactoryPresets.ruleSets;
const oldConverters = legacyVideoConversionFactoryPresets.converterPresets;
const legacyQuietMusicAudioRule = LEGACY_AUDIO_PROMPT_RULE_V0_6_3.replace(
  '自动选择的配乐不得喧宾夺主：稀疏、极低音量、比对白前景至少低 8–12 dB 并远离前景；对白或关键动作声出现时主动压低到近静音，绝不能盖过人声。',
  '无论配乐由AI依剧情选择还是用户明确指定，都应自然贴合时代、场景和当前情绪，优先简洁配器、柔和音色、低存在感，只轻轻烘托，不抢听觉注意力，不默认铺满全段。对白为前景，必要现场声和动作声清楚自然，配乐始终在很远的背景：极低音量、近乎察觉不到，参考听感比正常对白低18–24 dB；该数值仅为相对混音意图，不是API音量参数或实际测量结果。对白或关键动作声出现时平滑让位到近静音，不压低对白或整条音轨来迁就配乐。无对白镜头、台词停顿与对白结束后仍保持同一极低背景音量，不自动回升为前景，不用音乐填满空隙。入退自然柔和，切镜不突然重启或增响，避免突入、强鼓点、夸张低频、戏剧性音量渐强及忽大忽小的抽动；需要情绪推进时用轻微旋律、节奏或配器变化，不靠增大音量。风格预设里的“宏大”“强调”“抬升”只作为风格与叙事意图，不是抬高配乐音量的授权。',
);
// V0.6.7's untouched factory records are kept as test-only values. The
// production migration matches their semantic fingerprints instead of
// shipping these duplicate historical prompt bodies in the app bundle.
const legacyTimelineV140 = {
  ...clone(timeline),
  outputRules: timeline.outputRules.replace(AUDIO_PROMPT_RULE, legacyQuietMusicAudioRule),
  version: '1.4.0',
  updatedAt: 0,
};
const legacyConverterV160 = {
  ...clone(converter),
  systemPrompt: LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_7_0
    .replace(AUDIO_PROMPT_RULE, legacyQuietMusicAudioRule)
    .replace(`\n\n${STORY_CAUSALITY_RULE}`, '')
    .replace(`\n\n${DIALOGUE_DELIVERY_RULE}`, ''),
  outputRules: converter.outputRules
    .replace(`\n\n${VIDEO_CAUSALITY_OUTPUT_RULE}`, '')
    .replace(`\n\n${DIALOGUE_DELIVERY_RULE}`, ''),
  version: '1.6.0',
  updatedAt: 0,
};
const migrationRules = [...oldRules, legacyTimelineV140];
const migrationConverters = [...oldConverters, legacyConverterV160];
assert.ok(oldRules.some((rule) => rule.version === '1.1.0' && rule.outputRules.includes('事件间背景近静音。')),
  'known early quiet-audio default is a full historical fixture, not inferred from the new rule');
assert.ok(oldConverters.some((preset) => preset.version === '1.1.0' && preset.outputRules.includes('屏幕文字不算对白。删除')),
  'original v1.1.0 punctuation variant remains exactly identifiable');
const legacyTimelineV120 = oldRules.find((rule) => rule.version === '1.2.0');
const legacyTimelineV130 = oldRules.find((rule) => rule.version === '1.3.0');
const legacyConverterV140 = oldConverters.find((preset) => preset.version === '1.4.0');
const legacyConverterV150 = oldConverters.find((preset) => preset.version === '1.5.0');
assert.ok(legacyTimelineV120, 'the previous v1.2.0 timeline remains an exact migration fixture');
assert.ok(legacyTimelineV130, 'the shipped v1.3.0 timeline remains an exact migration fixture');
assert.ok(legacyTimelineV140, 'the shipped V0.6.7 v1.4.0 timeline remains an exact migration fixture');
assert.ok(legacyConverterV140, 'the previous v1.4.0 converter remains an exact migration fixture');
assert.ok(legacyConverterV150, 'the shipped v1.5.0 converter remains an exact migration fixture');
assert.ok(legacyConverterV160, 'the shipped V0.6.7 v1.6.0 converter remains an exact migration fixture');
assert.equal(
  legacyTimelineV130.outputRules,
  [VIDEO_DIALOGUE_RULE, VIDEO_DIALOGUE_STAGING_RULE, LEGACY_AUDIO_PROMPT_RULE_V0_6_3, VIDEO_STAGING_REVIEW_RULE, VIDEO_PROMPT_FOCUS_RULE].join('\n'),
  'the V0.6.3 timeline fixture is frozen independently of the live audio rule',
);
assert.equal(
  legacyConverterV150.systemPrompt,
  LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_7_0
    .replace(AUDIO_PROMPT_RULE, LEGACY_AUDIO_PROMPT_RULE_V0_6_3)
    .replace(`\n\n${STORY_CAUSALITY_RULE}`, '')
    .replace(`\n\n${DIALOGUE_DELIVERY_RULE}`, ''),
  'the V0.6.3 converter fixture is frozen independently of live audio, dialogue and causality rules',
);
assert.equal(legacyConverterV150.outputRules, DEFAULT_VIDEO_CONVERSION_OUTPUT
  .replace(`\n\n${VIDEO_CAUSALITY_OUTPUT_RULE}`, '')
  .replace(`\n\n${DIALOGUE_DELIVERY_RULE}`, ''));
assert.ok(!legacyConverterV150.systemPrompt.includes(STORY_CAUSALITY_RULE));
assert.ok(!legacyConverterV150.outputRules.includes(VIDEO_CAUSALITY_OUTPUT_RULE));
assert.equal(legacyConverterV160.systemPrompt.replace(legacyQuietMusicAudioRule, LEGACY_AUDIO_PROMPT_RULE_V0_6_3), legacyConverterV150.systemPrompt,
  'the V0.6.7 converter fixture differs only by its frozen quiet-music text');
assert.equal(legacyTimelineV140.outputRules.includes(legacyQuietMusicAudioRule), true,
  'the V0.6.7 timeline fixture carries the frozen quiet-music text');
// Captured from the untouched rule/converter saved by the V0.6.7 packaged
// smoke run, not derived from today's defaults. This keeps the fixture honest
// without importing historical project data or a duplicate full preset bundle.
const shippedTimelineFields: ReadonlyArray<keyof RuleSet> = [
  'id', 'name', 'description', 'mode', 'baseRules', 'continuityRules', 'outputRules', 'enabled', 'version',
];
const shippedConverterFields: ReadonlyArray<keyof ConverterPreset> = [
  'id', 'name', 'workflow', 'inputMode', 'scope', 'systemPrompt', 'outputRules', 'enabled', 'version',
];
const shippedTimelineFingerprintBody = JSON.stringify(shippedTimelineFields.map((field) => legacyTimelineV140[field]));
const shippedConverterFingerprintBody = JSON.stringify(shippedConverterFields.map((field) => legacyConverterV160[field]));
assert.equal(shippedTimelineFingerprintBody.length, 3749);
assert.equal(sourceContentHash(shippedTimelineFingerprintBody), 'src-v1-48f6b6df20ca7b70');
assert.equal(shippedConverterFingerprintBody.length, 5958);
assert.equal(sourceContentHash(shippedConverterFingerprintBody), 'src-v1-7419a9a2c3c2e01d');
assert.equal(legacyConverterV140.systemPrompt, LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_4_0.replace(AUDIO_PROMPT_RULE, LEGACY_AUDIO_PROMPT_RULE_V0_6_3));
assert.equal(legacyConverterV140.outputRules, LEGACY_DEFAULT_VIDEO_CONVERSION_OUTPUT_V1_4_0);

for (const oldRule of migrationRules) {
  const migrated = normalizeState({ ...clone(initial), ruleSets: [clone(oldRule)] });
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION, 'rule content migration does not introduce another schema');
  assert.equal(migrated.ruleSets[0].version, '1.5.0');
  assert.equal(migrated.ruleSets[0].baseRules, timeline.baseRules);
  assert.equal(migrated.ruleSets[0].continuityRules, timeline.continuityRules);
  assert.equal(migrated.ruleSets[0].outputRules, timeline.outputRules);
  assert.deepEqual(migrated.project, projectBefore, 'source-rule migration does not rewrite existing project prompts, scenes or references');
  assert.deepEqual(migrated.settings, settingsBefore, 'source-rule migration preserves chosen rules, models and generation parameters');
  assert.deepEqual(normalizeState(migrated), migrated, 'source-rule migration is idempotent');
}
for (const oldConverter of migrationConverters) {
  const migrated = normalizeState({ ...clone(initial), converterPresets: [clone(oldConverter)] });
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION, 'converter content migration does not introduce another schema');
  assert.equal(migrated.converterPresets[0].version, converter.version);
  assert.equal(migrated.converterPresets[0].systemPrompt, converter.systemPrompt);
  assert.equal(migrated.converterPresets[0].outputRules, converter.outputRules);
  assert.deepEqual(migrated.project, projectBefore);
  assert.deepEqual(migrated.settings, settingsBefore);
  assert.deepEqual(normalizeState(migrated), migrated);
}

const legacyConverterV130 = oldConverters.find((preset) => preset.version === '1.3.0');
assert.ok(legacyConverterV130, 'the exact untouched v1.3.0 video converter must remain a migration fixture');
assert.equal(legacyConverterV130.systemPrompt, LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_3_0.replace(AUDIO_PROMPT_RULE, LEGACY_AUDIO_PROMPT_RULE_V0_6_3),
  'adding staging rules must not alter the exact retired v1.3.0 system');
assert.equal(legacyConverterV130.outputRules, LEGACY_DEFAULT_VIDEO_CONVERSION_OUTPUT_V1_4_0,
  'v1.3.0 output remains the old format/example, not the newly expanded live output');
const storyPreparation = defaultStoryExpansionPresets[0];
assert.ok(storyPreparation, 'the app must expose a default story-preparation preset');
assert.equal(storyPreparation.version, '1.4.4');
assert.ok(
  storyPreparation.systemPrompt.includes(MOSE_JIANGHU_NSFW_DETAIL_RULES),
  'the active v1.4.4 story-preparation preset must preserve the existing complete rule block',
);
assert.ok(storyPreparation.systemPrompt.includes(STORY_CAUSALITY_RULE));
const legacyStoryPreparationV140WithoutAge = {
  ...clone(legacyStoryPreparationV130),
  systemPrompt: [legacyStoryPreparationV130.systemPrompt, MOSE_JIANGHU_NSFW_DETAIL_RULES].join('\n\n'),
  version: '1.4.0',
};
const legacyStoryPreparationV140 = {
  ...clone(legacyStoryPreparationV130),
  systemPrompt: [legacyStoryPreparationV130.systemPrompt, STORY_AGE_FACT_PRESERVATION_RULE, MOSE_JIANGHU_NSFW_DETAIL_RULES].join('\n\n'),
  version: '1.4.0',
};
const migratedV130 = normalizeState({
  ...clone(initial),
  converterPresets: [clone(legacyConverterV130)],
  storyExpansionPresets: [clone(legacyStoryPreparationV130)],
});
assert.equal(migratedV130.converterPresets[0].version, converter.version);
assert.equal(migratedV130.converterPresets[0].systemPrompt, converter.systemPrompt);
assert.equal(migratedV130.storyExpansionPresets[0].version, '1.4.4');
assert.equal(migratedV130.storyExpansionPresets[0].systemPrompt, storyPreparation.systemPrompt);
assert.deepEqual(migratedV130.project, projectBefore, 'v1.3.0 prompt migration must not rewrite project content');
assert.deepEqual(migratedV130.settings, settingsBefore, 'v1.3.0 prompt migration must not change user settings');
assert.deepEqual(normalizeState(migratedV130), migratedV130, 'v1.3.0 prompt migration must be idempotent');

for (const historicStory of [legacyStoryPreparationV140WithoutAge, legacyStoryPreparationV140]) {
  const migrated = normalizeState({ ...clone(initial), storyExpansionPresets: [clone(historicStory)] });
  assert.equal(migrated.storyExpansionPresets[0].version, '1.4.4', 'both shipped 1.4.0 layouts upgrade');
  assert.equal(migrated.storyExpansionPresets[0].name, storyPreparation.name);
  assert.equal(migrated.storyExpansionPresets[0].systemPrompt, storyPreparation.systemPrompt);
  assert.equal(migrated.storyExpansionPresets[0].outputRules, storyPreparation.outputRules);
  assert.deepEqual(migrated.project, projectBefore);
  assert.deepEqual(migrated.settings, settingsBefore);
  assert.deepEqual(normalizeState(migrated), migrated);
  for (const patch of [
    { name: '我的画面转化规则' }, { enabled: false }, { customMetadata: '用户字段' },
    { systemPrompt: `${historicStory.systemPrompt}\n用户自定剧情要求。` },
  ]) {
    const owned = { ...clone(historicStory), ...patch };
    assert.deepEqual(normalizeState({ ...clone(initial), storyExpansionPresets: [owned] }).storyExpansionPresets, [owned],
      'customized 1.4.0 story presets remain user-owned, including the age-rule variant');
  }
}

for (const ownershipCase of [
  {
    label: 'renamed',
    converter: { ...clone(legacyConverterV130), name: '用户命名的视频转换器' },
    story: { ...clone(legacyStoryPreparationV130), name: '用户命名的剧情准备预设' },
  },
  {
    label: 'edited',
    converter: { ...clone(legacyConverterV130), systemPrompt: `${legacyConverterV130.systemPrompt}\n用户自定镜头要求。` },
    story: { ...clone(legacyStoryPreparationV130), systemPrompt: `${legacyStoryPreparationV130.systemPrompt}\n用户自定叙事要求。` },
  },
  {
    label: 'disabled',
    converter: { ...clone(legacyConverterV130), enabled: false },
    story: { ...clone(legacyStoryPreparationV130), enabled: false },
  },
  {
    label: 'custom metadata',
    converter: { ...clone(legacyConverterV130), customMetadata: '用户所有' },
    story: { ...clone(legacyStoryPreparationV130), customMetadata: '用户所有' },
  },
]) {
  const preserved = normalizeState({
    ...clone(initial),
    converterPresets: [ownershipCase.converter],
    storyExpansionPresets: [ownershipCase.story],
  });
  assert.deepEqual(
    preserved.converterPresets,
    [ownershipCase.converter],
    `a ${ownershipCase.label} v1.3.0 video converter is user-owned and must remain byte-for-byte unchanged`,
  );
  assert.deepEqual(
    preserved.storyExpansionPresets,
    [ownershipCase.story],
    `a ${ownershipCase.label} v1.3.0 story-preparation preset is user-owned and must remain byte-for-byte unchanged`,
  );
}

// Editing even one semantic field, disabling the rule, or adding metadata proves user ownership.
const ownedPresetFixtures: ReadonlyArray<readonly [RuleSet, ConverterPreset]> = [
  [oldRules[0], oldConverters[0]], [legacyTimelineV120, legacyConverterV140],
  [legacyTimelineV130, legacyConverterV150], [legacyTimelineV140, legacyConverterV160],
];
for (const patch of [
  { name: '用户自定义规则名' }, { enabled: false }, { version: 'user-version' }, { customField: '用户自定义元数据' },
]) {
  for (const [ruleFixture, converterFixture] of ownedPresetFixtures) {
    const rule: RuleSet & { customField?: string } = { ...clone(ruleFixture), ...patch };
    const preset: ConverterPreset & { customField?: string } = { ...clone(converterFixture), ...patch };
    const kept = normalizeState({ ...clone(initial), ruleSets: [rule], converterPresets: [preset] });
    assert.deepEqual(kept.ruleSets, [rule]);
    assert.deepEqual(kept.converterPresets, [preset]);
  }
}
const customRule = { ...clone(oldRules[0]), outputRules: `${oldRules[0].outputRules}\n用户明确添加的创作要求。` };
const customConverter = { ...clone(oldConverters[0]), systemPrompt: `${oldConverters[0].systemPrompt}\n用户自定叙事风格。` };
const keptCustom = normalizeState({ ...clone(initial), ruleSets: [customRule], converterPresets: [customConverter] });
assert.deepEqual(keptCustom.ruleSets, [customRule], 'custom content is not overwritten even when it retains an old builtin ID');
assert.deepEqual(keptCustom.converterPresets, [customConverter]);
const customizedRecentRule = { ...clone(legacyTimelineV120), continuityRules: `${legacyTimelineV120.continuityRules}\n用户自定轴线安排。` };
const customizedRecentConverter = { ...clone(legacyConverterV140), outputRules: `${legacyConverterV140.outputRules}\n用户自定画外声安排。` };
const keptRecentCustom = normalizeState({ ...clone(initial), ruleSets: [customizedRecentRule], converterPresets: [customizedRecentConverter] });
assert.deepEqual(keptRecentCustom.ruleSets, [customizedRecentRule], 'new timeline migration preserves edited previous defaults');
assert.deepEqual(keptRecentCustom.converterPresets, [customizedRecentConverter], 'new converter migration preserves edited previous defaults');
const userScoredRule = { ...clone(legacyTimelineV140), outputRules: `${legacyTimelineV140.outputRules}\n用户本次明确要求低音量古琴配乐。` };
const userScoredConverter = { ...clone(legacyConverterV160), systemPrompt: `${legacyConverterV160.systemPrompt}\n用户本次明确要求低音量古琴配乐。` };
const keptUserScored = normalizeState({ ...clone(initial), ruleSets: [userScoredRule], converterPresets: [userScoredConverter] });
assert.deepEqual(keptUserScored.ruleSets, [userScoredRule], 'the no-BGM migration never strips authored music from a user-owned preset');
assert.deepEqual(keptUserScored.converterPresets, [userScoredConverter]);
const timestampOnlyRecent = normalizeState({
  ...clone(initial),
  ruleSets: [{ ...clone(legacyTimelineV140), updatedAt: 123 }],
  converterPresets: [{ ...clone(legacyConverterV160), updatedAt: 124 }],
});
assert.equal(timestampOnlyRecent.ruleSets[0].version, '1.5.0', 'bookkeeping timestamps do not prevent an exact factory migration');
assert.equal(timestampOnlyRecent.converterPresets[0].version, converter.version);
assert.deepEqual(normalizeState(timestampOnlyRecent), timestampOnlyRecent, 'new no-BGM factory migration remains idempotent after timestamp changes');
// The action update applies at the request boundary; it has no migration
// authority over a previously saved v1.7.0 converter or user additions.
const previouslySavedV170 = {
  ...clone(converter),
  systemPrompt: LEGACY_DEFAULT_VIDEO_CONVERSION_SYSTEM_V1_7_0,
  version: '1.7.0',
  updatedAt: 321,
};
for (const savedConverter of [
  previouslySavedV170,
  { ...clone(previouslySavedV170), systemPrompt: `${previouslySavedV170.systemPrompt}\n用户自定动作节奏。` },
]) {
  const preserved = normalizeState({ ...clone(initial), converterPresets: [savedConverter] });
  assert.deepEqual(preserved.converterPresets, [savedConverter],
    'the action update preserves saved v1.7.0 converters including custom content');
  assert.deepEqual(preserved.project, projectBefore, 'preserving saved converters does not rewrite confirmed project prompts');
  assert.deepEqual(preserved.settings, settingsBefore, 'the action update keeps user parameters and selections');
  assert.deepEqual(normalizeState(preserved), preserved, 'saved v1.7.0 preservation remains idempotent');
}
const deleted = normalizeState({
  ...clone(initial),
  ruleSets: [],
  converterPresets: [],
  storyExpansionPresets: [],
});
assert.deepEqual(deleted.ruleSets, []);
assert.deepEqual(deleted.converterPresets, []);
assert.deepEqual(deleted.storyExpansionPresets, []);
assert.equal(deleted.settings.defaultRuleSetId, initial.settings.defaultRuleSetId, 'a deleted selection is not silently reset');

console.log(`videoConversionRuleMigration: ${oldRules.length} historical rules and ${oldConverters.length} converters upgraded; custom/disabled/deleted presets, projects and parameters preserved`);
