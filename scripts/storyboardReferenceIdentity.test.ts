import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStoryboardImagePromptWithReferences, refreshStoryboardImageReferenceMetadata,
  stripStoryboardImageReferenceMetadata,
} from '../src/storyboardImageReferences';
import { buildStoryboardReferenceIdentityLines, currentStoryboardFrameSpatialSource } from '../src/storyboardImageReferenceIdentity';
import type { Character, ReferenceAsset } from '../src/types';

const character = (id: string, name: string): Character => ({ id, name, gender: '', apparentAge: '', race: '',
  appearance: '', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [] });
const people = [character('lin', '林沐'), character('ye', '叶清碧'), character('qi', '祈凌霜')];
const image = (id: string, owner: string | null, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: `旧图 ${id}：人物在屏幕右边`, type: 'character', role: 'character', characterReferenceId: owner,
  prompt: '历史图的站位、持物与配饰不能成为当前空间依据。', tags: [], createdAt: 1, updatedAt: 1, ...patch,
});
const refs = [image('ye-image', 'ye'), image('qi-image', 'qi'), image('lin-image', 'lin')];
const source = '画面左侧祈凌霜、中间林沐、右侧叶清碧。三人保持原位。';

test('converter之后按真实图序绑定ID和中文名，空间只逐字引用来源而非转换结果', () => {
  const converterResult = '转换器画面描述：三人交谈，原有镜头与动作。';
  const result = buildStoryboardImagePromptWithReferences(converterResult, refs, { characters: people, currentFrameSpatialSource: source });
  assert.equal(stripStoryboardImageReferenceMetadata(result), converterResult);
  assert.match(result, /图片 1 → 角色 ID "ye" → 中文原名 "叶清碧"/u);
  assert.match(result, /图片 2 → 角色 ID "qi" → 中文原名 "祈凌霜"/u);
  assert.match(result, /图片 3 → 角色 ID "lin" → 中文原名 "林沐"/u);
  assert.equal((result.match(/原稿空间原句：画面左侧祈凌霜、中间林沐、右侧叶清碧。/gu) || []).length, 3);
  assert.match(result, /各自对应参考的身份外观，不互换脸部、发型或服装/u);
  assert.match(result, /有当前帧明确空间原句时按原句对应，不用转换后的姓名或图片排列重分配/u);
  assert.doesNotMatch(result, /历史图的站位|旧图 ye-image|转换器画面描述：.*原稿空间原句/u);
});

test('换图只更新程序块与真实图号，已有源空间和converter产物保留且幂等', () => {
  const context = { characters: people, currentFrameSpatialSource: source };
  const first = buildStoryboardImagePromptWithReferences('只拍同一镜头的静帧。', refs, context);
  const reordered = [refs[2], refs[0], refs[1]];
  const next = refreshStoryboardImageReferenceMetadata(first, reordered, context);
  assert.match(next, /图片 1 → 角色 ID "lin" → 中文原名 "林沐"/u);
  assert.equal(stripStoryboardImageReferenceMetadata(next), '只拍同一镜头的静帧。');
  assert.ok(next.includes(source.split('。')[0] + '。'));
  assert.equal(refreshStoryboardImageReferenceMetadata(next, reordered, context), next);
  assert.equal(refreshStoryboardImageReferenceMetadata(next, [], context), '只拍同一镜头的静帧。');
  assert.equal(refreshStoryboardImageReferenceMetadata('无程序标记的历史最终稿。', refs, context), '无程序标记的历史最终稿。');
});

test('人物自身左右保留原句，不换算屏幕站位；对白和历史图文不提供站位', () => {
  const bodySides = '叶清碧在林沐自身左侧，以指尖擦拭他的左颊。林沐说：<d>[Chinese] 祈凌霜在屏幕左侧。</d>';
  const lines = buildStoryboardReferenceIdentityLines([{ pictureNumber: 1, characterId: 'ye', name: '叶清碧' },
    { pictureNumber: 2, characterId: 'qi', name: '祈凌霜' }], bodySides, people).join('\n');
  assert.ok(lines.includes('原稿空间原句：叶清碧在林沐自身左侧，以指尖擦拭他的左颊。'));
  assert.doesNotMatch(lines, /原稿空间原句：.*祈凌霜在屏幕左侧|叶清碧在屏幕|<d>/u);
  assert.match(lines, /人物自身左、右均不换算为屏幕站位/u);
});

test('解绑和改绑优先；重名、姓名子串与无具名位置不猜角色空间', () => {
  const currentRefs = [{ ...refs[0], referenceEntityBinding: { kind: 'character' as const, entityId: 'lin' } },
    { ...refs[1], referenceEntityBinding: null }];
  const result = buildStoryboardImagePromptWithReferences('本镜原正文。', currentRefs, { characters: people, currentFrameSpatialSource: source });
  assert.match(result, /图片 1 → 角色 ID "lin" → 中文原名 "林沐"/u);
  assert.doesNotMatch(result, /图片 2 → 角色 ID/u);
  const overlapping = [character('an', '安'), character('anning', '安宁')];
  const overlap = buildStoryboardReferenceIdentityLines([{ pictureNumber: 1, characterId: 'an', name: '安' }], '安宁站在画面左侧。', overlapping).join('\n');
  assert.doesNotMatch(overlap, /原稿空间原句/u);
  const duplicate = buildStoryboardReferenceIdentityLines([{ pictureNumber: 1, characterId: 'lin', name: '林沐' }], source,
    [...people, character('other-lin', '林沐')]).join('\n');
  assert.doesNotMatch(duplicate, /原稿空间原句/u);
  const unknown = buildStoryboardReferenceIdentityLines([{ pictureNumber: 1, characterId: 'ye', name: '叶清碧' }], '她站在画面右侧。', people).join('\n');
  assert.doesNotMatch(unknown, /原稿空间原句/u);
});

test('全镜时序和后续站位不成为当前帧要求，缺少定格依据时仍保留实际图号身份', () => {
  const completeShot = '第一镜开始，叶清碧站在画面右侧。5秒后叶清碧走到画面左侧。镜尾叶清碧位于林沐身后。';
  const request: { conversionSource: string; imageFrameDescription?: string } = { conversionSource: completeShot };
  assert.equal(currentStoryboardFrameSpatialSource(request), '');
  const withoutCurrentEvidence = buildStoryboardImagePromptWithReferences('既有converter产物。', refs, {
    characters: people, sourcePrompt: completeShot, currentFrameSpatialSource: currentStoryboardFrameSpatialSource(request),
  });
  assert.match(withoutCurrentEvidence, /图片 1 → 角色 ID "ye" → 中文原名 "叶清碧"/u);
  assert.doesNotMatch(withoutCurrentEvidence, /原稿空间原句：|5秒后|镜尾叶清碧/u);
  assert.equal(stripStoryboardImageReferenceMetadata(withoutCurrentEvidence), '既有converter产物。');
  const frozenInstant = '叶清碧站在画面右侧。';
  const withCurrentEvidence = buildStoryboardImagePromptWithReferences('既有converter产物。', refs, {
    characters: people, sourcePrompt: completeShot,
    currentFrameSpatialSource: currentStoryboardFrameSpatialSource({ ...request, imageFrameDescription: frozenInstant }),
  });
  assert.ok(withCurrentEvidence.includes(`原稿空间原句：${frozenInstant}`));
  assert.doesNotMatch(withCurrentEvidence, /5秒后|镜尾叶清碧|画面左侧/u);
  assert.equal(currentStoryboardFrameSpatialSource({ currentFrameSpatialSource: frozenInstant, imageFrameDescription: '另一个定格。' }), frozenInstant);
});

test('同批首图只作有限连续参考，不抢角色图身份或继承机位站位动作', () => {
  const first = image('same-batch-first', 'ye');
  const result = buildStoryboardImagePromptWithReferences('尾图保持结束时刻的手部近景。', [...refs, first], {
    characters: people, currentFrameSpatialSource: '', continuityAssetId: first.id,
  });
  assert.match(result, /4\. 本批已成功首图 — 仅作人物外观、场景外观与光线连续参考/u);
  assert.match(result, /人物身份以各自角色参考图为准，不沿用首图镜头、位置、动作、姿态或持物/u);
  assert.doesNotMatch(result, /图片 4 → 角色 ID|原稿空间原句/u);
  assert.match(result, /图片 1 → 角色 ID "ye" → 中文原名 "叶清碧"/u);
});
