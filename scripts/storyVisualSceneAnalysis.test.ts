import assert from 'node:assert/strict';
import { applyStoryVisualScenesToAnalysis } from '../src/storyVisualSceneAnalysis';
import { assembleStoryVisualSceneParagraphs, type StoryVisualActionPlan } from '../src/storyVisualAction';
import type { StoryAnalysisResponse } from '../src/services/llm';
import type { StoryAnalysisCharacter, StoryAnalysisLocation, StoryVisualConversionSnapshot } from '../src/types';

const plan: StoryVisualActionPlan = {
  version: 1, summary: '', sourceParagraphs: [
    { id: 'p1', text: '女仆说：“时间到了。”塔菲站起身，想起不在场的姐姐。' },
    { id: 'p2', text: '数日后，塔菲再次走进大厅。门外侍卫喊道：“请稍候。”' },
  ],
  scenes: [
    { id: 'castle-first', title: '赴约', time: '这一天', timeRelation: '', location: '城堡大厅', setting: '女仆在门边等候。',
      participants: [
        { id: 'vampire', name: '吸血姬', aliases: ['塔菲'], existingEntityId: 'project-tafei', presence: 'present' },
        { id: 'maid', name: '女仆', presence: 'present' },
        { id: 'sister', name: '姐姐', presence: 'mentioned' },
      ], eventIds: ['greeting'], sourceParagraphIds: ['p1'] },
    { id: 'castle-later', title: '再次赴约', time: '数日后', timeRelation: '相隔数日', location: '城堡大厅', setting: '大门关闭。',
      participants: [
        { id: 'vampire', name: '塔菲', presence: 'present' },
        { id: 'guard', name: '门外侍卫', presence: 'offscreen' },
      ], eventIds: ['return'], sourceParagraphIds: ['p2'] },
  ],
  events: [
    { id: 'greeting', sceneId: 'castle-first', kind: 'dialogue', sourceParagraphIds: ['p1'], evidence: '时间到了。',
      actor: '女仆', target: '塔菲', speaker: '女仆', action: '女仆在门边通报。', dialogue: '时间到了。', result: '', uncertainties: [] },
    { id: 'return', sceneId: 'castle-later', kind: 'dialogue', sourceParagraphIds: ['p2'], evidence: '请稍候。',
      actor: '门外侍卫', target: '塔菲', speaker: '门外侍卫', action: '门外传来侍卫的声音。', dialogue: '请稍候。', result: '', uncertainties: [] },
  ],
};
const paragraphs = assembleStoryVisualSceneParagraphs(plan, []);
const snapshot: StoryVisualConversionSnapshot = {
  id: 'conversion', chapterId: 'chapter', sourceName: '章节', sourceText: plan.sourceParagraphs.map((paragraph) => paragraph.text).join('\n\n'),
  actionPlan: plan, paragraphs, resultText: paragraphs.map((paragraph) => paragraph.text).join('\n\n'), createdAt: 1,
};
const characterBinding = { referenceId: 'image-character', subjectId: 'subject-tafei' };
const locationBinding = { referenceId: 'image-location', subjectId: 'subject-castle' };
const analysis: StoryAnalysisResponse = {
  characters: [{ name: '塔菲', existingEntityId: 'project-tafei', aliases: ['吸血姬'], appearance: '沿用已保存外貌', storyReferenceBindings: [characterBinding] }, { name: '路过的商人' }],
  locations: [{ name: '城堡大厅', existingEntityId: 'project-castle', aliases: ['大殿'], description: '沿用已保存场景', storyReferenceBindings: [locationBinding] }],
  props: [{ name: '怀表', existingEntityId: 'project-watch' }, { name: '封好的信' }],
  scenes: [
    { title: '赴约', content: '被压缩成一句话的摘要。', characters: ['吸血姬'], location: '城堡大厅', props: ['怀表'], referenceAssetIds: ['asset-castle-first'] },
    { title: '再次赴约', content: '被改写的第二场。', characters: ['塔菲', '女仆', '姐姐'], location: '大殿', props: ['封好的信'], referenceAssetIds: ['asset-castle-later'] },
  ],
};
const original = structuredClone(analysis);
const result = applyStoryVisualScenesToAnalysis(analysis, snapshot);
assert.deepEqual(analysis, original, 'the adapter does not mutate the model response');
assert.equal(result.scenes.length, 2);
assert.deepEqual(result.scenes.map((scene) => scene.content), paragraphs.map((paragraph) => paragraph.text), 'adopted scene bodies replace the later model summaries in full');
assert.deepEqual(result.scenes.map((scene) => (scene.characters as StoryAnalysisCharacter[]).map((item) => item.name)), [
  ['塔菲', '女仆'], ['塔菲', '门外侍卫'],
], 'each scene gets its own explicit present/offscreen cast, excluding merely mentioned people');
const maid = result.characters?.find((value) => typeof value === 'object' && value.name === '女仆');
assert.deepEqual(maid, { name: '女仆' }, 'a speaking unnamed role keeps a minimum identity without invented appearance or age');
assert.ok(!result.characters?.some((value) => typeof value === 'object' && value.name === '姐姐'), 'a mentioned-only person is not newly promoted to an on-scene character');
const tafei = result.scenes[0].characters?.[0] as StoryAnalysisCharacter;
assert.equal(tafei.existingEntityId, 'project-tafei');
assert.equal(tafei.appearance, '沿用已保存外貌');
assert.deepEqual(tafei.storyReferenceBindings, [characterBinding], 'character image links survive name/alias reconciliation');
assert.deepEqual((result.scenes[0].location as StoryAnalysisLocation).storyReferenceBindings, [locationBinding]);
assert.deepEqual(result.scenes.map((scene) => scene.props), [['怀表'], ['封好的信']], 'props are carried from the corresponding analysis scenes, not the whole chapter');
assert.deepEqual(result.scenes.map((scene) => scene.referenceAssetIds), [['asset-castle-first'], ['asset-castle-later']]);
assert.equal(result.locations?.length, 1, 'different days in the same named location reuse the known location');
for (const scene of result.scenes) assert.equal(snapshot.resultText.slice(scene.sourceStart, scene.sourceEnd), scene.content);
assert.equal(result.scenes[1].sourceStart, paragraphs[0].text.length + 2);

const renamedAnalysis: StoryAnalysisResponse = {
  ...analysis,
  scenes: analysis.scenes.map((scene, index) => ({ ...scene, title: '模型重新命名', content: paragraphs[index].text })),
};
const located = applyStoryVisualScenesToAnalysis(renamedAnalysis, snapshot);
assert.deepEqual(located.scenes.map((scene) => scene.props), [['怀表'], ['封好的信']], 'exact source positions retain the scene association even when titles differ');

const aliasOnlySnapshot = structuredClone(snapshot);
delete aliasOnlySnapshot.actionPlan!.scenes![0].participants[0].existingEntityId;
assert.equal((applyStoryVisualScenesToAnalysis(analysis, aliasOnlySnapshot).scenes[0].characters?.[0] as StoryAnalysisCharacter).existingEntityId,
  'project-tafei', 'a unique explicit alias retains the known character identity');

const explicitConflict: StoryAnalysisResponse = {
  ...analysis,
  characters: [
    { name: '同名甲', aliases: ['吸血姬'], existingEntityId: 'wrong-person' },
    { name: '塔菲', existingEntityId: 'project-tafei', storyReferenceBindings: [characterBinding] },
  ],
};
assert.equal((applyStoryVisualScenesToAnalysis(explicitConflict, snapshot).scenes[0].characters?.[0] as StoryAnalysisCharacter).existingEntityId,
  'project-tafei', 'the adopted explicit identity wins over another record sharing an alias');

assert.equal(applyStoryVisualScenesToAnalysis(analysis), analysis);
const legacySnapshot = { ...snapshot, actionPlan: { ...plan, scenes: undefined } };
assert.equal(applyStoryVisualScenesToAnalysis(analysis, legacySnapshot), analysis, 'legacy conversions retain their previous analysis object unchanged');
console.log('storyVisualSceneAnalysis: passed');
