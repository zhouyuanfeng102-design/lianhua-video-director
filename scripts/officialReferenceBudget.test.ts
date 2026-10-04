import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindVerifiedGeneratedH3CharacterReferences, buildBudgetedOfficialH3References } from '../src/officialReferenceBudget';
import {
  buildOfficialH3CompileInput,
  buildOfficialH3References,
  buildOfficialH3SourceFingerprint,
  buildOfficialH3SubjectDefinitions,
  compileOfficialH3Prompt,
  type OfficialH3ProjectContext,
} from '../src/officialPrompt';
import { compileTargetPrompt, type PromptSubjectDefinitionInput } from '../src/promptAdapters';
import type { Character, Project, ReferenceAsset, Storyboard, VideoShot } from '../src/types';

const hero: Character = {
  id: 'character-hero', name: '林舟', gender: '男', apparentAge: '成年', race: '人族',
  appearance: '黑发；眉骨清晰；左颊一道旧伤', outfit: '银灰长袍；深蓝腰带；磨损黑靴',
  anchor: '衣领银色云纹；左腕红绳', signatureProps: '青铜钥匙；刻有双鹤纹章',
  personality: '沉着', motionHabits: '站稳后迈步', negativeContinuity: '', assetIds: [],
};
const companion: Character = {
  ...hero, id: 'character-companion', name: '阿青', gender: '女',
  appearance: '短发；圆脸；右眉浅痣', outfit: '深绿短袍；白布鞋',
  anchor: '左肩绣着白鹭', signatureProps: '乌木短笛',
};
const identityLine = (character: Character): string => (
  `人物“${character.name}”固定身份与外貌：性别：${character.gender}；种族/物种：${character.race}；外观：${character.appearance}；服装：${character.outfit}；固定道具：${character.signatureProps}；连续性锚点：${character.anchor}`
);
const sourceSnapshot = [
  identityLine(hero), identityLine(companion),
  '本镜画面主体与站位：林舟在画面左侧，阿青在右侧，两人距离一步',
  '本镜可见动作：林舟推开石门→阿青右脚踏过门槛',
  '本镜可见结果：石门留出一人宽的入口',
  '独特视觉资料：门楣右上方有铜绿六角符记；逆光来自画面左侧；蓝灰电影写实',
].join('\n');
const picture = (id: string, overrides: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: `${id}构图参考`, type: 'reference', role: 'composition', referenceRole: 'composition',
  mediaType: 'image', source: 'generated', sourceStoryboardId: 'source-board', sourceShotId: `source-${id}`,
  visualAnchor: sourceSnapshot, prompt: '原始完整生图提示词不能修改',
  fileName: `${id}.png`, relativePath: `${id}.png`, dataUrl: 'data:image/png;base64,AA==',
  checksum: `${id}-checksum`, width: 1536, height: 1024, targetBindings: ['minimax-h3'],
  tags: ['分镜图'], createdAt: 1, updatedAt: 1, ...overrides,
});
const shot: VideoShot = {
  id: 'current-shot', index: 1, startSec: 0, endSec: 5, purpose: '当前段推进', subject: '林舟与阿青',
  action: '林舟接住阿青递来的钥匙', result: '林舟右手握住钥匙', camera: '中景固定侧拍',
  transition: '硬切', lighting: '左侧冷光', sound: '钥匙轻碰',
  referenceAssetIds: ['picture-b', 'picture-a'], prompt: '', locked: false,
};
const board: Storyboard = {
  id: 'current-board', sceneId: 'scene', workflow: 'drama', inputMode: 'text_reference',
  durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard',
  aspectRatio: '16:9', resolution: '2K', audioMode: 'stereo', stylePresetId: 'cinema',
  ruleSetId: 'default', converterPresetId: 'default', globalLock: '保持原有人物服装',
  shots: [shot], finalPrompt: '【0s-5s】主体：林舟与阿青；动作：林舟接住阿青递来的钥匙；空间：门廊；光影：左侧冷光；镜头：中景固定侧拍；台词：无；音效：动作层-[钥匙轻碰] 情绪层-[无配乐]。',
  targetModelId: 'minimax-h3', targetOutput: {
    targetId: 'minimax-h3', prompt: 'old', parameters: { seed: 271828, steps: 15, cfg: 1.4, audio_denoise_strength: 1 },
    referenceManifest: [], warnings: [], generatedAt: 1,
  },
  createdAt: 1, updatedAt: 1,
};
const context: OfficialH3ProjectContext = { assets: [picture('picture-a'), picture('picture-b')], characters: [hero, companion] };
const originalState = JSON.stringify({ board, context });
const rawReferences = buildOfficialH3References(board, context.assets);
const unboundDefinitions = buildOfficialH3SubjectDefinitions(board, context, []);
const fullDefinitions = buildOfficialH3SubjectDefinitions(board, context, rawReferences);
const input = buildOfficialH3CompileInput(board, context);
const withoutReferenceIds = (definitions: readonly PromptSubjectDefinitionInput[]) => definitions.map(({ referenceAssetIds: _referenceAssetIds, ...definition }) => definition);
const countRenderedSubjects = (prompt: string) => [...prompt.matchAll(/^<Subject\s+\d+> is /gmu)].length;
assert.deepEqual(withoutReferenceIds(fullDefinitions), withoutReferenceIds(unboundDefinitions), 'binding may only add reference ids, not edit identity facts');
assert.deepEqual(fullDefinitions.map((definition) => definition.referenceAssetIds),
  [rawReferences.map((reference) => reference.id), rawReferences.map((reference) => reference.id)],
  'each proven character must reuse both selected generated compositions in selection order');
assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(unboundDefinitions, rawReferences), fullDefinitions);
assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(fullDefinitions, rawReferences), fullDefinitions, 'binding is idempotent');
assert.deepEqual(input.subjectDefinitions, fullDefinitions, 'full semantic identities are never shortened');
assert.deepEqual(input.references?.map((reference) => reference.id), rawReferences.map((reference) => reference.id));
for (const [index, reference] of input.references!.entries()) {
  const { responsibility, ...metadata } = reference;
  const { responsibility: oldResponsibility, ...originalMetadata } = rawReferences[index];
  assert.deepEqual(metadata, originalMetadata, 'pixel identity, ordering, raw anchors, provenance and all metadata must survive');
  assert.ok(responsibility!.length < oldResponsibility!.length);
  assert.match(responsibility!, /人物“林舟”固定身份与外貌：沿用同名主体定义/u);
  assert.match(responsibility!, /人物“阿青”固定身份与外貌：沿用同名主体定义/u);
  assert.doesNotMatch(responsibility!, /黑发；眉骨清晰/u);
  assert.ok(responsibility!.includes('林舟在画面左侧，阿青在右侧，两人距离一步'));
  assert.ok(responsibility!.includes('林舟推开石门→阿青右脚踏过门槛'));
  assert.ok(responsibility!.includes('石门留出一人宽的入口'));
  assert.ok(responsibility!.includes('门楣右上方有铜绿六角符记；逆光来自画面左侧；蓝灰电影写实'));
  assert.match(responsibility!, /静态构图.*当前 Shots.*不重演来源镜头/u);
  assert.doesNotMatch(responsibility!, /^本镜可见动作/mu);
  assert.doesNotMatch(responsibility!, /<Subject\s+\d+>/u, 'the budgeter must never invent output-mode-dependent Subject tokens');
}
assert.deepEqual(buildBudgetedOfficialH3References(input.references!, fullDefinitions), input.references, 'derived budgeting is idempotent');
const compiled = compileOfficialH3Prompt(board, context);
const unbudgeted = compileTargetPrompt({ ...input, references: rawReferences });
assert.deepEqual(compiled.output.referenceManifest.map((reference) => [reference.id, reference.token]),
  unbudgeted.referenceManifest.assets.map((reference) => [reference.id, reference.token]));
for (const character of [hero, companion]) {
  for (const fact of [character.appearance, character.outfit, character.anchor, character.signatureProps]) {
    assert.ok(compiled.output.prompt.includes(fact), `complete identity fact must survive: ${fact}`);
  }
}
assert.equal(compiled.output.parameters.seed, 271828);
assert.equal(compiled.output.parameters.steps, 15);
assert.equal(compiled.output.parameters.cfg, 1.4);
assert.equal(compiled.output.parameters.audio_denoise_strength, 1);
assert.equal(JSON.stringify({ board, context }), originalState, 'compilation must not mutate source assets, story, shots or workflow parameters');
assert.equal(buildOfficialH3SourceFingerprint(board, context), compiled.sourceFingerprint);
const changedSource = { ...context, assets: context.assets.map((asset, index) => index ? asset : { ...asset, visualAnchor: `${asset.visualAnchor}\n独特新事实：右侧还有红灯。` }) };
assert.notEqual(buildOfficialH3SourceFingerprint(board, changedSource), compiled.sourceFingerprint);

// Excluded sources keep their exact responsibilities, including any seemingly
// duplicated prose. Source role/provenance determines eligibility, not a name.
for (const overrides of [
  { source: 'upload' as const }, { source: 'imported' as const }, { sourceEntityId: hero.id },
  { sourceStoryboardId: '' }, { sourceShotId: '' }, { referenceRole: 'style' as const },
  { referenceRole: 'first-frame' as const }, { referenceRole: 'last-frame' as const },
  { mediaType: 'video' as const },
]) {
  const reference = { ...picture('excluded', overrides), responsibility: sourceSnapshot };
  assert.deepEqual(buildBudgetedOfficialH3References([reference], fullDefinitions), [reference]);
  assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(unboundDefinitions, [reference]), unboundDefinitions, 'excluded reference types cannot infer new identities');
}
const flagKeyframe = { ...rawReferences[0], firstFrame: true };
assert.deepEqual(buildBudgetedOfficialH3References([flagKeyframe], fullDefinitions), [flagKeyframe]);
assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(unboundDefinitions, [flagKeyframe]), unboundDefinitions);
for (const type of ['audio', 'video', 'clay-render']) {
  const reference = { ...rawReferences[0], type, mediaType: undefined };
  assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(unboundDefinitions, [reference]), unboundDefinitions, 'legacy non-image types must not be mistaken for pictures');
}

// Unknown, changed or ambiguous identity facts must remain verbatim. In
// particular substring coincidences cannot prove identity coverage.
for (const [identity, definitions] of [
  [identityLine(hero), []],
  [identityLine(hero), fullDefinitions.filter((definition) => definition.name !== hero.name)],
  [identityLine(hero), [...fullDefinitions, fullDefinitions[0]]],
  [identityLine(hero), fullDefinitions.map((definition) => ({ ...definition, gender: '非男' }))],
  [identityLine(hero), fullDefinitions.map((definition) => ({ ...definition, outfit: '完全不同的新衣服' }))],
  [`${identityLine(hero)}；唯一伤痕：耳后新切口`, fullDefinitions],
  [identityLine(hero).replace('外观：', '未知外观：'), fullDefinitions],
] as Array<[string, PromptSubjectDefinitionInput[]]>) {
  const reference = { ...rawReferences[0], responsibility: identity };
  assert.deepEqual(buildBudgetedOfficialH3References([reference], definitions), [reference]);
  const bindingCandidates = definitions.map((definition) => ({ ...definition, referenceAssetIds: [] }));
  assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(bindingCandidates, [reference]), bindingCandidates, 'unknown, conflicted or ambiguous identities cannot create guessed bindings');
}

// Two different compositions must only bind their own verified casts, never
// every entity appearing in the segment. A shared name in prose is no proof.
const separateCasts = [
  { ...rawReferences[0], id: 'hero-only', responsibility: `${identityLine(hero)}\n本镜画面主体与站位：林舟站在左侧，墙上写着阿青的名字` },
  { ...rawReferences[1], id: 'companion-only', responsibility: identityLine(companion) },
];
assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(unboundDefinitions, separateCasts).map((definition) => definition.referenceAssetIds),
  [['hero-only'], ['companion-only']], 'two pictures with different people must not cross-bind');
const orderedExplicit = [
  { ...unboundDefinitions[0], referenceAssetIds: ['explicit-first', rawReferences[1].id!] },
  unboundDefinitions[1],
];
assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(orderedExplicit, rawReferences)[0].referenceAssetIds,
  ['explicit-first', rawReferences[1].id!, rawReferences[0].id!], 'existing explicit links and order are kept; only missing selected ids are appended');
assert.deepEqual(orderedExplicit[0].referenceAssetIds, ['explicit-first', rawReferences[1].id!], 'binding cannot mutate an existing id array');
const entityPortrait = picture('entity-portrait', { role: 'character', referenceRole: 'character', sourceEntityId: hero.id });
const directPicture = picture('direct-picture', { source: 'upload' });
const directBoard = { ...board, shots: [{ ...shot, referenceAssetIds: [directPicture.id, entityPortrait.id, ...shot.referenceAssetIds] }] };
const directContext = { ...context, characters: [{ ...hero, assetIds: [directPicture.id] }, companion], assets: [...context.assets, entityPortrait, directPicture] };
const directDefinitions = buildOfficialH3SubjectDefinitions(directBoard, directContext);
assert.deepEqual(directDefinitions[0].referenceAssetIds, [directPicture.id, entityPortrait.id, ...rawReferences.map((reference) => reference.id)],
  'project assetIds and sourceEntityId bindings both survive composition inference');
const nonCharacters: PromptSubjectDefinitionInput[] = [
  { name: '石桥', kind: 'scene', description: '青石拱桥', referenceAssetIds: [] },
  { name: '灵溪', kind: 'scene', description: '桥下清溪', referenceAssetIds: [] },
  { name: '流萤草', kind: 'prop', description: '发光细草', referenceAssetIds: [] },
];
assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences([...unboundDefinitions, ...nonCharacters], rawReferences).slice(-3), nonCharacters);
const duplicatedName = [...unboundDefinitions, { name: hero.name, kind: 'scene', description: '同名场景', referenceAssetIds: [] }];
assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(duplicatedName, [separateCasts[0]]), duplicatedName, 'a character and scene sharing one name is still ambiguous');
for (const responsibility of [
  '林舟与阿青站在画面中；衣服沿用设定',
  '人物“林舟”固定身份与外貌：',
  `${identityLine(hero)}\n${identityLine({ ...hero, outfit: '不匹配的红色盔甲' })}`,
]) {
  const reference = { ...rawReferences[0], responsibility };
  assert.deepEqual(bindVerifiedGeneratedH3CharacterReferences(unboundDefinitions, [reference]), unboundDefinitions,
    'unknown templates, empty identities and a contradictory second row cannot infer links');
}
const oneUploaded = picture('one-upload', { source: 'upload', visualAnchor: '没有可验证身份的普通综合参考图' });
const onePictureBoard = { ...board, shots: [{ ...shot, referenceAssetIds: [oneUploaded.id] }] };
assert.deepEqual(buildOfficialH3SubjectDefinitions(onePictureBoard, { ...context, assets: [oneUploaded] }).map((definition) => definition.referenceAssetIds),
  [[oneUploaded.id], [oneUploaded.id]], 'the existing single-picture fallback remains compatible');
const partialReference = { ...rawReferences[0], responsibility: [identityLine(hero), identityLine(companion)].join('\n') };
const partial = buildBudgetedOfficialH3References([partialReference], [fullDefinitions[0]])[0].responsibility!;
assert.match(partial, /人物“林舟”固定身份与外貌：沿用同名主体定义/u);
assert.ok(partial.includes(identityLine(companion)), 'a missing semantic subject must keep its complete source identity');
const whitespaceDefinition = fullDefinitions.map((definition) => ({ ...definition, appearance: definition.appearance?.replace('；眉骨', '；\n眉骨') }));
const whitespaceReference = { ...rawReferences[0], responsibility: identityLine(hero).replace('；眉骨', '； 眉骨') };
assert.match(buildBudgetedOfficialH3References([whitespaceReference], whitespaceDefinition)[0].responsibility!, /沿用同名主体定义/u);

for (const keyframeRole of ['first-frame', 'last-frame'] as const) {
  const keyframe = picture('picture-a', { role: keyframeRole, referenceRole: keyframeRole });
  const keyframeBoard = { ...board, shots: [{ ...shot, referenceAssetIds: [keyframe.id] }] };
  const keyframePrompt = compileOfficialH3Prompt(keyframeBoard, { ...context, assets: [keyframe] }).output.prompt;
  assert.doesNotMatch(keyframePrompt, /<Subject\s+\d+>/u);
  assert.doesNotMatch(keyframePrompt, /subject_definitions:/u);
  assert.ok(keyframePrompt.includes(hero.appearance));
}
const noReferencesPrompt = compileOfficialH3Prompt({ ...board, shots: [{ ...shot, referenceAssetIds: [] }] }, { ...context, assets: [] }).output.prompt;
assert.doesNotMatch(noReferencesPrompt, /<Subject\s+\d+>/u);
assert.ok(noReferencesPrompt.includes(hero.appearance));

// Optional read-only real-project replay. No settings/configuration are logged
// and this script never saves, migrates or submits the supplied project state.
if (process.argv[2]) {
  const filePath = process.argv[2];
  const original = fs.readFileSync(filePath, 'utf8');
  const state = JSON.parse(original) as { project: Project; projects?: Project[] };
  const project = state.project.name === '55866' ? state.project : state.projects?.find((item) => item.name === '55866');
  assert.ok(project, 'expected user project 55866');
  const projectBefore = JSON.stringify(project);
  const plan = project.sequencePlans?.find((item) => item.segments.length === 4);
  const second = project.storyboards.find((item) => item.id === plan?.segments[1]?.storyboardId);
  assert.ok(second, 'expected the second segment linked by the four-segment sequence');
  const realContext: OfficialH3ProjectContext = {
    assets: project.assets, characters: project.characters, locations: project.locations, props: project.props,
    sceneContent: project.scenes.find((scene) => scene.id === second.sceneId)?.content,
  };
  const realInput = buildOfficialH3CompileInput(second, realContext);
  const realRawRefs = buildOfficialH3References(second, realContext.assets);
  // Disable only the new generated-template inference on copies to replay
  // pre-fix binding semantics; direct/sourceEntityId links remain available.
  const previousDefinitions = buildOfficialH3SubjectDefinitions(second, realContext, realRawRefs.map((reference) => ({ ...reference, source: 'upload' })));
  const before = compileTargetPrompt({ ...realInput, subjectDefinitions: previousDefinitions });
  const after = compileOfficialH3Prompt(second, realContext).output;
  assert.ok(after.prompt.length < before.prompt.length);
  assert.equal(previousDefinitions.length, 6);
  assert.deepEqual(withoutReferenceIds(realInput.subjectDefinitions!), withoutReferenceIds(previousDefinitions), 'all six original semantic identities are unchanged');
  const realCharacters = realInput.subjectDefinitions!.filter((definition) => definition.kind === 'character');
  assert.equal(realCharacters.length, 3);
  for (const definition of realCharacters) assert.deepEqual(definition.referenceAssetIds, realRawRefs.map((reference) => reference.id));
  for (const name of ['石桥', '灵溪', '流萤草']) {
    const definition = realInput.subjectDefinitions!.find((item) => item.name === name);
    assert.ok(definition, `expected ${name}`);
    assert.deepEqual(definition.referenceAssetIds, previousDefinitions.find((item) => item.name === name)?.referenceAssetIds,
      `${name} cannot inherit unproven character-image bindings`);
  }
  assert.equal(countRenderedSubjects(before.prompt), 8);
  assert.equal(countRenderedSubjects(after.prompt), 6);
  const definitionSection = after.prompt.split('\n\nsummary:')[0];
  let identityFieldsVerified = 0;
  for (const [index, definition] of realInput.subjectDefinitions!.entries()) {
    const row = definitionSection.split('\n').find((line) => line.startsWith(`<Subject ${index + 1}> is ${definition.name}`));
    assert.ok(row, `missing definition for ${definition.name}`);
    for (const field of ['description', 'gender', 'race', 'appearance', 'outfit', 'anchor', 'motion'] as const) {
      // H3 joins fields with semicolons and normalizes only boundary Chinese
      // punctuation. Keep every interior character when checking the facts.
      const fact = definition[field]?.trim().replace(/^[，,；;。\s]+|[，,；;。\s]+$/gu, '');
      if (!fact) continue;
      assert.ok(row.includes(fact), `complete ${definition.name}.${field} must survive in its own Subject definition`);
      identityFieldsVerified += 1;
    }
  }
  const compositionResponsibilityOccurrences = realInput.references!.map((reference) => {
    const occurrences = after.prompt.split(reference.responsibility!).length - 1;
    assert.equal(occurrences, 1, `all unique static composition evidence for ${reference.id} must survive exactly once`);
    return occurrences;
  });
  const removedIds = new Set(realRawRefs.slice(1).map((reference) => reference.id!));
  const onePictureBoard: Storyboard = {
    ...second,
    globalReferenceAssetIds: second.globalReferenceAssetIds?.filter((id) => !removedIds.has(id)),
    shots: second.shots.map((shot) => ({ ...shot, referenceAssetIds: shot.referenceAssetIds.filter((id) => !removedIds.has(id)) })),
    firstFrameAssetId: removedIds.has(second.firstFrameAssetId || '') ? undefined : second.firstFrameAssetId,
    lastFrameAssetId: removedIds.has(second.lastFrameAssetId || '') ? undefined : second.lastFrameAssetId,
  };
  const onePictureInput = buildOfficialH3CompileInput(onePictureBoard, realContext);
  const onePictureOutput = compileOfficialH3Prompt(onePictureBoard, realContext).output;
  assert.equal(onePictureInput.references!.length, 1);
  assert.equal(countRenderedSubjects(onePictureOutput.prompt), 6);
  assert.deepEqual(withoutReferenceIds(onePictureInput.subjectDefinitions!), withoutReferenceIds(realInput.subjectDefinitions!));
  assert.deepEqual(onePictureOutput.parameters, after.parameters, 'one vs two pictures cannot change seeds or compiler parameters');
  assert.equal(onePictureInput.canonicalPrompt, realInput.canonicalPrompt, 'reference count cannot rewrite canonical shots or timing');
  assert.equal(JSON.stringify(project), projectBefore, 'formal in-memory source project, assets, shots and settings must remain untouched');
  assert.equal(fs.readFileSync(filePath, 'utf8'), original, 'formal state file must remain untouched');
  console.log(JSON.stringify({
    readOnlyReplay: true, segment: 2, beforeCharacters: before.prompt.length, afterCharacters: after.prompt.length,
    subjectCount: realInput.subjectDefinitions?.length, renderedSubjectsBefore: countRenderedSubjects(before.prompt), renderedSubjectsAfter: countRenderedSubjects(after.prompt),
    onePictureCharacters: onePictureOutput.prompt.length, twoPictureCharacters: after.prompt.length,
    addedSecondPictureCharacters: after.prompt.length - onePictureOutput.prompt.length,
    identityFieldsVerified, compositionResponsibilityOccurrences,
    characterBindings: realCharacters.map((definition) => ({ name: definition.name, ids: definition.referenceAssetIds })),
    references: realInput.references?.map((reference, index) => ({ id: reference.id, before: realRawRefs[index].responsibility?.length, after: reference.responsibility?.length })),
    parametersUnchanged: ['seed', 'steps', 'cfg', 'sampler', 'audio_denoise_strength'].every((key) => after.parameters[key] === second.targetOutput?.parameters[key]),
  }));
}
// Cross-renderer delivery contract: proven identity binding must also preserve
// each picture's independent composition evidence in the final H3 document.
assert.ok(compiled.output.prompt.length < unbudgeted.prompt.length);
assert.equal(countRenderedSubjects(compiled.output.prompt), fullDefinitions.length, 'proven picture references must not produce fictitious extra picture-as-person Subjects');
assert.equal([...compiled.output.prompt.matchAll(/门楣右上方有铜绿六角符记/gu)].length, rawReferences.length,
  'each covered composition must retain its unique visual evidence once, not lose it or repeat it per linked character');
console.log('official generated reference budget tests passed');
