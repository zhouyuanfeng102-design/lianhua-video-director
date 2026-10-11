import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultStoryExpansionPresets, normalizeState } from '../src/storage';
import { normalizeStoryVisualConversionSnapshot } from '../src/semanticSequencePlan';
import { matchingStoryVisualConversion, rememberStoryVisualConversion, storyVisualPreparationFingerprint } from '../src/storyVisualConversion';
import { STORY_VISUAL_ENGINE_VERSION, type StoryVisualActionPlan, type StoryVisualParagraph } from '../src/storyVisualAction';

const source = '绝死将尸体踢向少女。少女避开，尸体穿过回廊撞在后墙上。';
const body = '绝死踢中尸体，尸体朝少女飞去。少女移出飞行路径，尸体从她身旁掠过，穿过回廊后撞上后墙。';
const actionPlan: StoryVisualActionPlan = {
  version: 1, summary: '踢出、避让、撞墙，少女没有被击中', sourceParagraphs: [{ id: 'p1', text: source }],
  events: [{ id: 'e1', sourceParagraphIds: ['p1'], evidence: source, actor: '绝死', target: '少女',
    action: '踢出尸体', phases: ['踢出', '避开', '撞墙'], result: '尸体撞墙，少女避开', uncertainties: ['左右方向未指定'] }],
};
const paragraphs: StoryVisualParagraph[] = [{ id: 'v1', sourceParagraphIds: ['p1'], eventIds: ['e1'], text: body,
  stagingAdditions: ['从少女身旁掠过是对原有避让的画面编排，原文没有指定左右'] }];
const initial = normalizeState({});
const chapterId = initial.project.sourceDocuments[0].id;
const snapshot = { id: 'adopted', chapterId, sourceName: '战斗', sourceText: source, resultText: body, createdAt: 42,
  actionPlan, paragraphs, engineVersion: STORY_VISUAL_ENGINE_VERSION, detailMode: 'detailed' as const };
const saved = rememberStoryVisualConversion(initial.project, snapshot);
const restored = normalizeState(JSON.parse(JSON.stringify({ ...initial, project: saved })));
const matched = matchingStoryVisualConversion(restored.project, chapterId, body)!;
assert.deepEqual(matched, snapshot, 'adopted prose, quoted facts and staging survive persistence together');
assert.equal(matchingStoryVisualConversion(restored.project, chapterId, `${body} 用户加写。`), undefined);
assert.equal(matchingStoryVisualConversion(restored.project, 'other-chapter', body), undefined);
const copied = normalizeStoryVisualConversionSnapshot(matched)!;
copied.actionPlan!.events[0].phases!.push('副本变化');
copied.paragraphs![0].stagingAdditions.push('副本变化');
assert.equal(matched.actionPlan!.events[0].phases!.length, 3);
assert.equal(matched.paragraphs![0].stagingAdditions.length, 1);
const corrupt = normalizeStoryVisualConversionSnapshot({ ...snapshot, paragraphs: [{ ...paragraphs[0], text: '另一份正文' }] })!;
assert.equal(corrupt.paragraphs?.[0].text, '另一份正文', 'stored AI metadata is copied without a local content comparison');
const modelMetadata = normalizeStoryVisualConversionSnapshot({ ...snapshot,
  actionPlan: { ...actionPlan, version: '1', events: [
    { ...actionPlan.events[0], evidence: '绝死将尸体踢向少女。', sourceParagraphIds: ['model-p1'] },
    { ...actionPlan.events[0], evidence: '模型返回的依据文字' },
  ] },
  paragraphs: [{ ...paragraphs[0], sourceParagraphIds: ['model-p1'], eventIds: ['model-e1'] }],
})!;
assert.equal(modelMetadata.actionPlan?.events.length, 2, 'model metadata is retained without an evidence or duplicate-ID gate');
assert.equal(modelMetadata.actionPlan?.events[0].evidence, '绝死将尸体踢向少女。');
assert.equal(modelMetadata.paragraphs?.[0].sourceParagraphIds[0], 'model-p1');
const oldSnapshot = normalizeStoryVisualConversionSnapshot({ id: 'old', chapterId, sourceName: '旧稿', sourceText: source,
  resultText: body, createdAt: 1 })!;
assert.equal(oldSnapshot.actionPlan, undefined, 'old projects remain readable without invented events');

const legacy = JSON.parse(readFileSync(new URL('./fixtures/storyExpansionV144.json', import.meta.url), 'utf8'));
const migrated = normalizeState({ ...initial, storyExpansionPresets: [legacy] });
assert.equal(migrated.storyExpansionPresets[0].version, '1.5.0');
assert.equal(migrated.storyExpansionPresets[0].systemPrompt, defaultStoryExpansionPresets[0].systemPrompt);
for (const edit of [{ name: '我的规则' }, { enabled: false }, { systemPrompt: `${legacy.systemPrompt}\n我的补充` }, { custom: '用户字段' }]) {
  const custom = { ...legacy, ...edit };
  assert.deepEqual(normalizeState({ ...initial, storyExpansionPresets: [custom] }).storyExpansionPresets[0], custom,
    'customized or disabled historical rules must not be replaced');
}
const fingerprint = storyVisualPreparationFingerprint(initial, 'detailed');
assert.notEqual(storyVisualPreparationFingerprint(initial, 'faithful'), fingerprint);
const editedApi = structuredClone(initial); editedApi.settings.textApi.model = 'another-model';
assert.notEqual(storyVisualPreparationFingerprint(editedApi, 'detailed'), fingerprint);
const editedPreset = structuredClone(initial); editedPreset.storyExpansionPresets[0].systemPrompt += '\n新增要求';
assert.notEqual(storyVisualPreparationFingerprint(editedPreset, 'detailed'), fingerprint);
const editedCharacter = structuredClone(initial); editedCharacter.project.characters[0].name = '改名';
assert.notEqual(storyVisualPreparationFingerprint(editedCharacter, 'detailed'), fingerprint);
const editedLocation = structuredClone(initial); editedLocation.project.locations[0].description += '新增站位';
assert.notEqual(storyVisualPreparationFingerprint(editedLocation, 'detailed'), fingerprint);
console.log('PASS story visual conversion persistence, legacy migration and request fingerprints');
