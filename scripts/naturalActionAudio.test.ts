import assert from 'node:assert/strict';
import { AUDIO_PROMPT_RULE, NATURAL_ACTION_AUDIO_RULE } from '../src/audioPromptPolicy';
import { createInitialState, CURRENT_SCHEMA_VERSION, legacyVideoConversionFactoryPresets, normalizeState, UNIFIED_VIDEO_CONVERTER_ID } from '../src/storage';

// Frozen 0.5.79 rule: same-schema installs must not retain the forced-kiss requirement.
const oldAudioRule = '环境层只写本镜有实际声源依据且叙事必要的声音；未指定时写“无”，仅无事件的背景近静音，不是整条音轨静音。不要因林地、室内、雨景或无配乐自动补连续底噪、房间底声、嘶声、白噪声，也不要用持续、低响或渐强的谷风、环境风、灵泉、溪流等环境声填满镜头及全局声景。对白与有可见动作依据的脚步、接触、碰撞等动作声保留原时序且清楚可辨，不把动作音压成不可闻；画面明确发生亲吻（包括唇触脸颊、额头或嘴唇）时，在唇部实际接触时刻同步细微、短促、可辨识的轻吻声或唇接触声，不能以背景近静音为由删除，也不能只用含糊的“极轻接触声”代替吻声。未发生、只是靠近、想吻或差点吻不能加吻声。不得因没有配乐、静止、靠近或普通转头凭空补声音，不自动添加持续呼吸、ASMR或摩擦声；没有画面动作就不补对应动作音。默认无配乐；用户或剧情明确要求的背景音乐必须保留，作为低音量背景并让位于对白与关键动作声，不得擅自添加或强行删除配乐。';
const initial = createInitialState();
const timeline = initial.ruleSets.find((rule) => rule.id === 'timeline_director_cn')!;
const converter = initial.converterPresets.find((preset) => preset.id === UNIFIED_VIDEO_CONVERTER_ID)!;
assert.ok(timeline && converter);
const historicalTimeline = legacyVideoConversionFactoryPresets.ruleSets[0];
const historicalConverter = legacyVideoConversionFactoryPresets.converterPresets[0];
const oldTimeline = { ...historicalTimeline, outputRules: historicalTimeline.outputRules.replace(AUDIO_PROMPT_RULE, oldAudioRule), updatedAt: 123 };
const oldConverter = { ...historicalConverter,
  systemPrompt: historicalConverter.systemPrompt.replace(AUDIO_PROMPT_RULE, oldAudioRule),
  outputRules: historicalConverter.outputRules.replace(AUDIO_PROMPT_RULE, oldAudioRule), updatedAt: 124 };
const oldState = { ...initial, schemaVersion: 21, ruleSets: [oldTimeline], converterPresets: [oldConverter],
  settings: { ...initial.settings, imageApi: { ...initial.settings.imageApi,
    workflowJson: '{"sampler":{"seed":123456789,"steps":15,"cfg":4.5,"sampler_name":"euler","denoise":1}}' } } };
const migrated = normalizeState(oldState);
const control = normalizeState({ ...oldState, ruleSets: [timeline], converterPresets: [converter] });
assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
assert.equal(migrated.ruleSets[0].outputRules, timeline.outputRules);
assert.equal(migrated.converterPresets[0].systemPrompt, converter.systemPrompt);
assert.equal(migrated.converterPresets[0].outputRules, converter.outputRules);
for (const text of [migrated.ruleSets[0].outputRules, `${migrated.converterPresets[0].systemPrompt}\n${migrated.converterPresets[0].outputRules}`]) {
  assert.ok(text.includes(NATURAL_ACTION_AUDIO_RULE));
  assert.doesNotMatch(text, /唇部实际接触时刻同步细微、短促、可辨识/u);
}
assert.deepEqual(normalizeState(migrated), migrated, 'natural audio migration is idempotent');
assert.deepEqual(migrated.settings, control.settings, 'models, seeds and sampling parameters remain untouched');
assert.deepEqual(migrated.project, control.project, 'existing source, shots, prompts and dialogue are not rewritten');

for (const patch of [{ enabled: false }, { version: 'custom' }, { customMetadata: 'owned' }, { name: '自定义声音规则' }]) {
  const customTimeline = { ...oldTimeline, ...patch };
  const customConverter = { ...oldConverter, ...patch };
  const kept = normalizeState({ ...oldState, ruleSets: [customTimeline], converterPresets: [customConverter] });
  assert.deepEqual(kept.ruleSets[0], customTimeline, 'do not overwrite disabled or custom presets');
  assert.deepEqual(kept.converterPresets[0], customConverter);
}
const scoredTimeline = { ...oldTimeline, outputRules: `${oldTimeline.outputRules}\n用户明确保留低音量古琴配乐。` };
const scoredConverter = { ...oldConverter, systemPrompt: `${oldConverter.systemPrompt}\n用户明确保留低音量古琴配乐。` };
const scored = normalizeState({ ...oldState, ruleSets: [scoredTimeline], converterPresets: [scoredConverter] });
assert.deepEqual(scored.ruleSets[0], scoredTimeline);
assert.deepEqual(scored.converterPresets[0], scoredConverter);
const deleted = normalizeState({ ...oldState, ruleSets: [], converterPresets: [] });
assert.deepEqual(deleted.ruleSets, [], 'deleted presets cannot be resurrected by the audio hotfix');
assert.deepEqual(deleted.converterPresets, []);

console.log('natural action audio default migration checks passed');
