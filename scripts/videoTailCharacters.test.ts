import assert from 'node:assert/strict';
import { prepareVideoTailCharacterDraft } from '../src/videoTailCharacters';
import { compileOfficialH3Prompt } from '../src/officialPrompt';
import { readH3PromptProtocol } from '../src/h3PromptProtocol';
import type { Character, Project, ReferenceAsset, Storyboard, VideoShot } from '../src/types';
import type { VideoGenerationDraft } from '../src/videoGenerationTypes';

let tests = 0;
const test = (name: string, run: () => void) => { run(); console.log(`ok ${++tests} - ${name}`); };
const image = (id: string, patch: Partial<ReferenceAsset> = {}): ReferenceAsset => ({
  id, name: id, type: 'character', role: 'character', mediaType: 'image', source: 'upload',
  relativePath: `image/${id}.png`, tags: [], createdAt: 1, updatedAt: 1, ...patch,
});
const character = (id: string, name: string, assetIds: string[]): Character => ({
  id, name, assetIds, gender: '', apparentAge: '成年', race: '人类', appearance: '稳定脸部', outfit: '已确认衣服',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '',
});
const shot = (patch: Partial<VideoShot> = {}): VideoShot => ({
  id: 'shot', index: 1, startSec: 0, endSec: 15, subject: '女师傅与男徒弟', action: '女师傅走向男徒弟', camera: '固定镜头',
  purpose: '', transition: '', lighting: '', sound: '女师傅说：“明天再来。”', result: '', prompt: '', locked: false,
  referenceAssetIds: ['pupil', 'scene', 'master'], ...patch,
});
const storyboard = (patch: Partial<Storyboard> = {}): Storyboard => ({
  id: 'board', sceneId: 'scene-id', workflow: 'drama', inputMode: 'text_reference', durationSec: 15, durationPreset: '15s',
  shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', shots: [shot()],
  finalPrompt: '【0s-15s】主体：女师傅与男徒弟；动作：女师傅在山门走向男徒弟；空间：山门；光影：晨光；镜头：固定镜头；台词：第1s @女师傅：“明天再来。”；音效：环境层-[风声] 动作层-[脚步声] 情绪层-[笛声持续]',
  createdAt: 1, updatedAt: 1, targetModelId: 'minimax-h3', globalReferenceAssetIds: ['master', 'pupil', 'scene'],
  ...patch,
});
const setup = (boardPatch: Partial<Storyboard> = {}): { project: Project; draft: VideoGenerationDraft; board: Storyboard } => {
  const board = storyboard(boardPatch);
  const project: Project = {
    id: 'project', name: '', description: '', sourceDocuments: [],
    characters: [character('c-master', '女师傅', ['master']), character('c-pupil', '男徒弟', ['pupil']), character('c-absent', '未出场人物', ['absent'])],
    locations: [{ id: 'location', name: '山门', description: '', timeWeather: '', lighting: '', palette: '', fixedProps: '', anchor: '', assetIds: ['scene'] }],
    props: [], scenes: [], storyboards: [board], sequencePlans: [], generationTasks: [], createdAt: 1, updatedAt: 1,
    assets: [image('master', { sourceEntityId: 'c-master', sourceEntityKind: 'character' }), image('pupil', { sourceEntityId: 'c-pupil', sourceEntityKind: 'character' }),
      image('absent', { sourceEntityId: 'c-absent', sourceEntityKind: 'character' }), image('scene', { type: 'location', role: 'scene' })],
  };
  const compiled = compileOfficialH3Prompt(board, { assets: project.assets, characters: project.characters, locations: project.locations, props: project.props });
  board.officialPromptZh = compiled.output.prompt; board.targetOutput = compiled.output; board.officialPromptSource = compiled.sourceFingerprint;
  const draft: VideoGenerationDraft = {
    name: '第2段', backend: 'comfyui', prompt: board.officialPromptZh,
    source: { storyboardId: board.id, language: 'zh', sequencePlanId: 'plan', segmentId: 'segment2', segmentIndex: 2 },
    references: [{ assetId: 'master', role: 'character' }, { assetId: 'pupil', role: 'character' }, { assetId: 'scene', role: 'scene' }],
    parameters: { seed: 123, duration: 15 }, workflowId: 'flow', reuseTaskId: 'old-task',
  };
  return { project, draft, board };
};
const definition = (prompt: string, index: number): string => prompt.match(new RegExp(`^<Subject ${index}>.*$`, 'mu'))?.[0] || '';
const sound = (prompt: string): string => prompt.slice(prompt.indexOf('overall_soundscape:'));

test('saved H3 manifest, not editor order, drives Picture remapping while Subject ids stay fixed', () => {
  const { project, draft, board } = setup();
  assert.deepEqual(board.targetOutput!.referenceManifest.map((entry) => entry.id), ['pupil', 'scene', 'master']);
  const before = JSON.stringify({ project, draft });
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, [{ assetId: 'master', role: 'character' }, { assetId: 'pupil', role: 'character' }]);
  assert.match(definition(result.draft.prompt, 1), /女师傅 referenced from <Picture 2>/u);
  assert.match(definition(result.draft.prompt, 2), /男徒弟 referenced from <Picture 3>/u);
  assert.match(definition(result.draft.prompt, 3), /山门 referenced from <Picture 1>/u);
  assert.equal(result.draft.reuseTaskId, draft.reuseTaskId, 'retry connection and credentials keep their frozen source');
  assert.equal(result.draft.parameters, draft.parameters, 'non-reference task settings are not rewritten');
  assert.equal(JSON.stringify({ project, draft }), before, 'saved prompts, source images and input draft are immutable');
  assert.ok(result.notices?.some((notice) => notice.includes('scene')));
});

test('H3 official sections, every Shot/At marker, dialogue and sound remain intact', () => {
  const { project, draft } = setup();
  const result = prepareVideoTailCharacterDraft(project, draft);
  const originalProtocol = readH3PromptProtocol(draft.prompt)!;
  const protocol = readH3PromptProtocol(result.draft.prompt)!;
  assert.ok(protocol);
  assert.deepEqual(protocol.sections, originalProtocol.sections);
  assert.deepEqual(protocol.shots, originalProtocol.shots);
  assert.deepEqual(protocol.references.filter((token) => token.startsWith('<Subject')), originalProtocol.references.filter((token) => token.startsWith('<Subject')));
  assert.ok(result.draft.prompt.includes('“明天再来。”'));
  assert.equal(sound(result.draft.prompt), sound(draft.prompt));
  assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('detailed_description:')), draft.prompt.slice(draft.prompt.indexOf('detailed_description:')));
  assert.doesNotMatch(result.draft.prompt, /本次参考职责|为紧邻上一段视频的本地真实最后一帧|服装以已确认剧情和当前逐镜状态为准/u);
});

test('English draft keeps the Chinese saved subject identity map without translating authored text', () => {
  const { project, draft, board } = setup();
  board.officialPromptEn = board.officialPromptZh!.replaceAll('女师傅', 'Master').replaceAll('男徒弟', 'Pupil');
  board.officialPromptEnSource = board.officialPromptZh;
  draft.prompt = board.officialPromptEn; draft.source!.language = 'en';
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(definition(result.draft.prompt, 1), /Master referenced from <Picture 2>/u);
  assert.match(definition(result.draft.prompt, 2), /Pupil referenced from <Picture 3>/u);
  assert.doesNotMatch(result.draft.prompt, /Reference assignment for this submission/u);
  assert.equal(sound(result.draft.prompt), sound(draft.prompt));
});

test('explicit ordinary selections win over the character card primary and unrelated history is not appended', () => {
  const { project, draft } = setup();
  project.assets.push(image('master-new', { sourceEntityId: 'c-master', sourceEntityKind: 'character' }));
  project.characters[0].assetIds.unshift('master-new');
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references.map((reference) => reference.assetId), ['master', 'pupil']);
  assert.ok(!result.draft.prompt.includes('未出场人物'));
});

test('missing selected identity falls back to first usable current character binding, not every asset', () => {
  const { project, draft } = setup();
  draft.references = [{ assetId: 'scene', role: 'scene' }];
  project.assets.push(image('private', { referenceScope: 'nsfw-private-profile' }), image('historical-scene', { sourceStoryboardId: 'old-board' }));
  project.characters[0].assetIds = ['private', 'historical-scene', 'master'];
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references.map((reference) => reference.assetId), ['master', 'pupil']);
  assert.doesNotMatch(result.draft.prompt, /private|historical-scene/u);
});

test('a current scene image used for old character definitions is split into tail composition and stable identity refs', () => {
  const { project, draft, board } = setup({ shots: [shot({ referenceAssetIds: ['scene'] })], globalReferenceAssetIds: ['scene'] });
  // The compiler deliberately permits one composite picture to anchor several subjects.
  assert.match(definition(draft.prompt, 1), /<Picture 1>/u);
  draft.references = [{ assetId: 'scene', role: 'composition' }];
  const original = board.officialPromptZh;
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(definition(result.draft.prompt, 1), /女师傅 referenced from <Picture 2>/u);
  assert.match(definition(result.draft.prompt, 2), /男徒弟 referenced from <Picture 3>/u);
  assert.match(definition(result.draft.prompt, 3), /山门 referenced from <Picture 1>/u);
  assert.equal(board.officialPromptZh, original);
});

test('an old character image can be replaced by the current explicitly chosen identity of the same owner', () => {
  const { project, draft } = setup();
  project.assets.push(image('master-selected', { sourceEntityId: 'c-master', sourceEntityKind: 'character' }));
  draft.references[0].assetId = 'master-selected';
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references.map((reference) => reference.assetId), ['master-selected', 'pupil']);
  assert.match(definition(result.draft.prompt, 1), /<Picture 2>/u);
});

test('a shared ordinary identity photo is kept once and binds both existing Subjects', () => {
  const { project, draft } = setup();
  project.assets.push(image('shared', { type: 'reference', role: 'composition' }));
  project.characters[0].assetIds.push('shared'); project.characters[1].assetIds.push('shared');
  draft.references = [{ assetId: 'shared', role: 'general' }, { assetId: 'scene', role: 'scene' }];
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, [{ assetId: 'shared', role: 'character' }]);
  assert.match(definition(result.draft.prompt, 1), /<Picture 2>/u);
  assert.match(definition(result.draft.prompt, 2), /<Picture 2>/u);
  assert.deepEqual(result.characterLabels, ['女师傅、男徒弟']);
});

test('standalone bracket references bind by existing slots without renumbering Subject or Shot', () => {
  const { project } = setup();
  const draft: VideoGenerationDraft = { name: '', backend: 'api', references: [{ assetId: 'master', role: 'subject' }], parameters: {},
    prompt: '<Subject 7> [Shot 8] refers to [Pic1], [Picture 1] and <Picture 1>. Audio 3 unchanged.' };
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(result.draft.prompt, /<Subject 7> \[Shot 8\] refers to \[Pic2\], \[Picture 2\] and <Picture 2>\. Audio 3 unchanged\./u);
});

test('integrated H3 without reference tokens stays byte-identical, with no reference-alignment preamble', () => {
  const { project, draft } = setup({ inputMode: 'text', shots: [shot({ referenceAssetIds: [] })], globalReferenceAssetIds: [] });
  draft.references = [];
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.equal(readH3PromptProtocol(result.draft.prompt)?.sections[0], 'integrated_multimodal_description');
  assert.doesNotMatch(result.draft.prompt, /subject_definitions:/u);
  assert.equal(result.draft.prompt, draft.prompt);
});

test('the segment cast never falls back to all project characters or the complete novel', () => {
  const { project, draft } = setup({ shots: [shot({ subject: '山门', action: '雾气翻涌', referenceAssetIds: ['scene'] })],
    sourceStoryContent: '女师傅、男徒弟、未出场人物贯穿整本书。' });
  draft.prompt = '山门前雾气翻涌。'; draft.references = [{ assetId: 'scene', role: 'scene' }];
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, []);
  assert.match(result.notices?.join('') || '', /未默认选中普通人物参考图/u);
  assert.equal(result.draft.prompt, draft.prompt);
});

test('defaults do not automatically select prop/style/end-frame/private pictures and never type-gate the mode', () => {
  for (const [id, patch, role] of [
    ['prop', { type: 'prop', role: 'prop' }, 'prop'],
    ['style', { type: 'reference', role: 'style' }, 'style'],
    ['end', { type: 'last-frame', role: 'last-frame' }, 'last-frame'],
    ['private', { referenceScope: 'nsfw-private-profile' }, 'character'],
  ] as const) {
    const { project, draft } = setup();
    project.assets.push(image(id, patch)); draft.references.push({ assetId: id, role });
    const before = JSON.stringify(draft);
    const result = prepareVideoTailCharacterDraft(project, draft);
    assert.equal(result.issue, undefined, id);
    assert.deepEqual(result.draft.references.map((reference) => reference.assetId), ['master', 'pupil']);
    assert.match(result.notices?.join('') || '', new RegExp(`默认未选“${id}”`, 'u'));
    assert.equal(JSON.stringify(draft), before);
  }
});

test('missing, private-only and previous-video-derived defaults are skipped without requiring a character image', () => {
  for (const patch of [{ missing: true }, { referenceScope: 'nsfw-private-profile' as const }, { sourceVideoAssetId: 'old-video' }, { sourceStoryboardId: 'old-board' }]) {
    const { project, draft } = setup();
    Object.assign(project.assets[0], patch); draft.references = [{ assetId: 'scene', role: 'scene' }];
    const result = prepareVideoTailCharacterDraft(project, draft);
    assert.equal(result.issue, undefined);
    assert.match(result.notices?.join('') || '', /女师傅.*没有可用的普通身份/u);
    assert.deepEqual(result.draft.references.map((reference) => reference.assetId), ['pupil']);
  }
});

test('text-only incidental cast does not require a photo or occupy slots in integrated H3', () => {
  for (const name of ['摊主', '路人', '陈远']) {
    const { project, draft, board } = setup({ inputMode: 'text', shots: [shot({
      subject: `女师傅、男徒弟、同伴与${name}`, action: `${name}将药草递给男徒弟`, referenceAssetIds: [],
    })], globalReferenceAssetIds: [] });
    project.characters.push(character('companion', '同伴', ['companion']), character('incidental', name, []));
    project.assets.push(image('companion', { sourceEntityId: 'companion', sourceEntityKind: 'character' }));
    draft.references = [{ assetId: 'master', role: 'character' }, { assetId: 'pupil', role: 'character' }];
    draft.prompt = `integrated_multimodal_description: [Shot 1] 女师傅、男徒弟、同伴在摊前。${name}将药草递给男徒弟，说：“请拿好。”`;
    board.officialPromptZh = draft.prompt; board.targetOutput!.prompt = draft.prompt;
    const before = JSON.stringify({ project, draft });
    const result = prepareVideoTailCharacterDraft(project, draft);
    assert.equal(result.issue, undefined, name);
    assert.deepEqual(result.characterLabels, ['女师傅', '男徒弟', '同伴']);
    assert.deepEqual(result.draft.references.map((reference) => reference.assetId), ['master', 'pupil', 'companion']);
    assert.equal(result.draft.prompt, draft.prompt, 'all authored plot, dialogue and H3 remain verbatim');
    assert.doesNotMatch(result.draft.prompt, /<Picture 5>/u);
    assert.equal(JSON.stringify({ project, draft }), before);
  }
});

test('explicitly selected incidental identity remains even without a character-card binding', () => {
  const { project, draft, board } = setup();
  project.characters.push(character('vendor', '摊主', []));
  project.assets.push(image('vendor-photo', { sourceEntityId: 'vendor', sourceEntityKind: 'character' }));
  board.shots[0].subject += '与摊主';
  draft.references.push({ assetId: 'vendor-photo', role: 'character' });
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.characterLabels, ['女师傅', '男徒弟', '摊主']);
  assert.ok(result.draft.references.some((reference) => reference.assetId === 'vendor-photo'));
});

test('shot-bound identity is explicit even when its character card has no assets', () => {
  const { project, draft, board } = setup();
  project.characters.push(character('vendor', '摊主', []));
  project.assets.push(image('vendor-photo', { sourceEntityId: 'vendor', sourceEntityKind: 'character' }));
  board.shots[0].subject += '与摊主'; board.shots[0].referenceAssetIds.push('vendor-photo');
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.ok(result.draft.references.some((reference) => reference.assetId === 'vendor-photo'));
  project.assets.at(-1)!.missing = true;
  const missing = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(missing.issue, undefined);
  assert.match(missing.notices?.join('') || '', /摊主.*没有可用的普通身份/u);
});

test('missing character-card bindings warn without preventing local-tail generation', () => {
  const { project, draft } = setup();
  project.characters[0].assetIds = ['deleted-master'];
  project.assets = project.assets.filter((asset) => asset.id !== 'master');
  draft.references = [{ assetId: 'scene', role: 'scene' }];
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(result.notices?.join('') || '', /女师傅.*没有可用的普通身份/u);
  assert.deepEqual(result.draft.references.map((reference) => reference.assetId), ['pupil']);
});

test('incidental H3 Subjects use their authored descriptions, not the previous frame as identity', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const prefix of ['', '参考说明：', '<Subject 77> keep original; ']) {
      const { project, draft, board } = setup();
      project.characters.push(character('vendor', '摊主', []));
      board.shots[0].subject += '与摊主';
      const description = '摊主，普通布衣，将药草递给男徒弟。';
      const zh = draft.prompt.replace('summary:', `<Subject 9> is 摊主 referenced from <Picture 2>: ${description}\nsummary:`)
        .replace('detailed_description:', `${prefix}<Subject 9> reference <Picture 2>; <Subject 1> reference <Picture 3>.\ndetailed_description:`);
      board.officialPromptZh = zh; board.targetOutput!.prompt = zh;
      board.officialPromptEn = zh.replaceAll('is 摊主 ', 'is Vendor '); board.officialPromptEnSource = zh;
      draft.prompt = language === 'zh' ? zh : board.officialPromptEn; draft.source!.language = language;
      const before = JSON.stringify({ project, draft });
      const result = prepareVideoTailCharacterDraft(project, draft);
      assert.equal(result.issue, undefined);
      assert.equal(definition(result.draft.prompt, 9), `<Subject 9> is ${language === 'zh' ? '摊主' : 'Vendor'} defined by the canonical prompt: ${description}`);
      assert.match(result.draft.prompt, /<Subject 9>\s*; <Subject 1> reference <Picture 2>/u);
      assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.sections, readH3PromptProtocol(draft.prompt)?.sections);
      assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.shots, readH3PromptProtocol(draft.prompt)?.shots);
      assert.equal(sound(result.draft.prompt), sound(draft.prompt));
      assert.equal(JSON.stringify({ project, draft }), before);
    }
  }
});

test('a changed saved H3 draft does not guess that editor slot order equals old compiler order', () => {
  const { project, draft } = setup(); draft.prompt += '\n手动修改';
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(result.notices?.join('') || '', /当前H3正文已不同于保存的交付稿/u);
  assert.equal(result.draft.prompt, draft.prompt);
});

test('unmapped old Picture/manifest warnings do not gate generation; duplicate selected IDs remain structural errors', () => {
  const { project, draft, board } = setup();
  for (const mutate of [
    () => { board.targetOutput!.referenceManifest[0].token = '<Picture 9>'; },
    () => { board.targetOutput!.referenceManifest.push({ ...board.targetOutput!.referenceManifest[0] }); },
    () => { draft.references.push({ ...draft.references[0] }); },
  ]) {
    const savedProject = structuredClone(project); const savedDraft = structuredClone(draft);
    mutate();
    const result = prepareVideoTailCharacterDraft(project, draft);
    if (draft.references.length > savedDraft.references.length) {
      assert.ok(result.issue); assert.equal(result.draft, draft);
    } else {
      assert.equal(result.issue, undefined); assert.ok(result.notices?.length);
      assert.equal(result.draft.prompt, draft.prompt);
    }
    Object.assign(project, savedProject); Object.assign(draft, savedDraft);
    // The local board alias is restored separately after replacing project arrays.
    Object.assign(board, savedProject.storyboards[0]); project.storyboards[0] = board;
  }
});

test('missing storyboard is structural, while uncertain standalone picture bindings warn without rewriting', () => {
  const { project, draft } = setup();
  draft.source!.storyboardId = 'deleted';
  assert.match(prepareVideoTailCharacterDraft(project, draft).issue || '', /原分镜已不存在/u);
  draft.source = undefined; draft.prompt = '[Pic99]';
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(result.notices?.join('') || '', /图片99.*只有3张/u);
  assert.equal(result.draft.prompt, draft.prompt);
});

test('ordinary generated five-view character card is allowed without importing its generation prompt or private profile', () => {
  const { project, draft } = setup();
  project.assets[0].source = 'generated'; project.assets[0].imageVariant = 'five-view';
  project.assets[0].prompt = 'PRIVATE_GENERATION_PROMPT'; project.assets[0].visualAnchor = 'PRIVATE_VISUAL_ANCHOR';
  project.characters[0].nsfwProfile = { fullBody: 'PRIVATE_DOSSIER' };
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.doesNotMatch(result.draft.prompt, /PRIVATE_/u);
});

test('saved custom H3 without a manifest preserves original text rather than reconstructing image ownership', () => {
  const { project, draft, board } = setup({ shots: [shot({ referenceAssetIds: ['master', 'pupil', 'scene'] })] });
  board.targetOutput = undefined; board.targetModelId = 'custom';
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.equal(result.draft.prompt, draft.prompt);
  assert.match(result.notices?.join('') || '', /缺少可信/u);
});

test('missing saved manifest cannot hide conflicting compiler and original editor source orders', () => {
  const { project, draft, board } = setup();
  board.targetOutput = undefined; board.officialPromptSource = undefined; board.targetModelId = 'custom';
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(result.notices?.join('') || '', /已保存提示词缺少原图片编号清单/u);
  assert.doesNotMatch(result.notices?.join('') || '', /正文已不同/u);
});

test('substring names do not pull an absent character into a longer named character segment', () => {
  const { project, draft, board } = setup({ shots: [shot({ subject: '林峰', action: '林峰走进山门', referenceAssetIds: [] })] });
  project.characters = [character('short', '林', []), character('long', '林峰', ['master'])];
  project.assets[0].sourceEntityId = 'long';
  draft.prompt = '林峰走进山门。'; board.finalPrompt = draft.prompt; draft.references = [];
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.characterLabels, ['林峰']);
});

test('unfamiliar Subject prose is not locally gated, re-authored or passed to text AI', () => {
  const { project, draft, board } = setup({ shots: [shot({ referenceAssetIds: ['scene'] })], globalReferenceAssetIds: ['scene'] });
  draft.prompt = draft.prompt.replace('<Subject 1> is 女师傅 referenced from', '<Subject 1> represents an unbound person from');
  board.officialPromptZh = draft.prompt; board.targetOutput!.prompt = draft.prompt;
  draft.references = [{ assetId: 'scene', role: 'scene' }];
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.equal(definition(result.draft.prompt, 1), definition(draft.prompt, 1));
  assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('detailed_description:')), draft.prompt.slice(draft.prompt.indexOf('detailed_description:')));
});

test('authored opening overlap remains untouched instead of appending local narrative guidance', () => {
  const { project, draft } = setup();
  const zh = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(zh.issue, undefined);
  assert.equal(zh.draft.prompt.slice(zh.draft.prompt.indexOf('detailed_description:')), draft.prompt.slice(draft.prompt.indexOf('detailed_description:')));
  assert.doesNotMatch(zh.draft.prompt, /已经写明的开场动作接续或有意短视觉重合/u);
  assert.doesNotMatch(zh.draft.prompt, /不重演上一段动作/u);
  const en = prepareVideoTailCharacterDraft(project, { ...draft, source: { ...draft.source, language: 'en' } });
  assert.equal(en.issue, undefined);
  assert.equal(en.draft.prompt, zh.draft.prompt, 'language never triggers new text, rules or translation');
  assert.doesNotMatch(en.draft.prompt, /intentional brief visual overlap already written/u);
  assert.doesNotMatch(en.draft.prompt, /without replaying the previous action/u);
});

test('identity references do not append local performance rules or override authored shots', () => {
  const { project, draft } = setup();
  const zh = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(zh.issue, undefined);
  assert.doesNotMatch(zh.draft.prompt, /不把静态表情或视线锁到每一镜/u);
  assert.doesNotMatch(zh.draft.prompt, /表演与反应遵循已写好的逐镜提示词/u);
  const en = prepareVideoTailCharacterDraft(project, { ...draft, source: { ...draft.source, language: 'en' } });
  assert.equal(en.issue, undefined);
  assert.doesNotMatch(en.draft.prompt, /Do not lock its still facial expression or gaze across shots/u);
  assert.doesNotMatch(en.draft.prompt, /follow the acting and reactions authored in each shot/u);
});

test('selected character slot gaps keep H3 Picture numbers and never refill an explicitly deselected identity', () => {
  const { project, draft, board } = setup();
  const originalPrompt = draft.prompt; const originalBoard = structuredClone(board);
  draft.references = [{ assetId: 'pupil', role: 'character', slotIndex: 1 }];
  draft.referenceSlotRoles = ['character', 'character'];
  const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, draft.references);
  assert.deepEqual(result.draft.referenceSlotRoles, draft.referenceSlotRoles);
  assert.match(definition(result.draft.prompt, 1), /女师傅 defined by the canonical prompt/u);
  assert.doesNotMatch(definition(result.draft.prompt, 1), /<Picture/u);
  assert.match(definition(result.draft.prompt, 2), /男徒弟 referenced from <Picture 3>/u);
  assert.doesNotMatch(result.draft.prompt, /仅确定人物身份、脸部特征/u);
  assert.doesNotMatch(result.draft.prompt, /<Picture 2>|undefined|null/u);
  assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.sections, readH3PromptProtocol(originalPrompt)?.sections);
  assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.shots, readH3PromptProtocol(originalPrompt)?.shots);
  assert.equal(sound(result.draft.prompt), sound(originalPrompt));
  assert.equal(draft.prompt, originalPrompt); assert.deepEqual(board, originalBoard);
});

test('manual scene and character references keep their own uses and holes instead of replacing the scene with the tail', () => {
  const { project, draft, board } = setup();
  draft.references = [{ assetId: 'scene', role: 'scene' }, { assetId: 'pupil', role: 'character', slotIndex: 3 }];
  draft.referenceSlotRoles = ['scene', 'prop', 'style', 'character'];
  const before = JSON.stringify({ project, draft });
  const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, draft.references);
  assert.deepEqual(result.draft.referenceSlotRoles, draft.referenceSlotRoles);
  assert.match(definition(result.draft.prompt, 1), /女师傅 defined by the canonical prompt/u);
  assert.match(definition(result.draft.prompt, 2), /男徒弟 referenced from <Picture 5>/u);
  assert.match(definition(result.draft.prompt, 3), /山门 referenced from <Picture 2>/u);
  assert.doesNotMatch(definition(result.draft.prompt, 3), /<Picture 1>/u);
  assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.sections, readH3PromptProtocol(draft.prompt)?.sections);
  assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('detailed_description:')), draft.prompt.slice(draft.prompt.indexOf('detailed_description:')));
  assert.equal(sound(result.draft.prompt), sound(draft.prompt));
  assert.equal(JSON.stringify({ project, draft }), before);
  assert.equal(board.officialPromptZh, draft.prompt);
});

test('manual arbitrary image types and mismatched uses remain selected without type gates or additional default characters', () => {
  for (const [id, patch, role] of [
    ['prop', { type: 'prop', role: 'prop' }, 'prop'],
    ['style', { type: 'reference', role: 'style' }, 'style'],
    ['end', { type: 'last-frame', role: 'last-frame' }, 'last-frame'],
    ['private', { referenceScope: 'nsfw-private-profile' }, 'character'],
    ['general', { type: 'reference', role: 'style', referenceRole: 'general' }, 'general'],
    ['composition', { type: 'location', role: 'scene' }, 'composition'],
    ['mismatch', { type: 'prop', role: 'prop' }, 'scene'],
    ['previous-video-frame', { type: 'first-frame', sourceVideoAssetId: 'old-video' }, 'general'],
  ] as const) {
    const { project, draft } = setup();
    project.assets.push(image(id, patch));
    draft.references = [{ assetId: id, role, slotIndex: 2, characterIds: [] }];
    draft.referenceSlotRoles = ['character', 'scene', role];
    const before = JSON.stringify({ project, draft });
    const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
    assert.equal(result.issue, undefined, id);
    assert.deepEqual(result.draft.references, draft.references, id);
    assert.deepEqual(result.draft.referenceSlotRoles, draft.referenceSlotRoles, id);
    assert.equal(result.draft.references.length, 1, id);
    assert.equal(JSON.stringify({ project, draft }), before, id);
    assert.equal(sound(result.draft.prompt), sound(draft.prompt), id);
  }
});

test('manual scene use of a character-owned image is not silently changed back to a character use', () => {
  const { project, draft } = setup();
  draft.references = [{ assetId: 'master', role: 'scene' }, { assetId: 'pupil', role: 'prop', slotIndex: 2 }];
  const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, draft.references);
  assert.match(definition(result.draft.prompt, 1), /女师傅 defined by the canonical prompt/u);
  assert.match(definition(result.draft.prompt, 2), /男徒弟 defined by the canonical prompt/u);
});

test('legacy H3 scene replacement uses a unique explicit location instead of the continuity tail', () => {
  for (const provenance of ['entity', 'assetIds'] as const) {
    const { project, draft } = setup();
    project.assets.push(image('scene-new', { type: 'location', role: 'scene',
      ...(provenance === 'entity' ? { sourceEntityKind: 'location', sourceEntityId: 'location' } : {}) }));
    if (provenance === 'assetIds') project.locations[0].assetIds.push('scene-new');
    draft.references = [{ assetId: 'scene', role: 'scene', slotIndex: 2 }, { assetId: 'pupil', role: 'character', slotIndex: 4 }];
    const retained = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
    draft.references[0].assetId = 'scene-new';
    const before = JSON.stringify({ project, draft });
    const replacement = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
    assert.equal(replacement.issue, undefined);
    assert.match(definition(replacement.draft.prompt, 3), /山门 referenced from <Picture 4>/u);
    assert.equal(replacement.draft.prompt, retained.draft.prompt, 'same proven scene and physical slots yield identical binding-only text');
    assert.equal(JSON.stringify({ project, draft }), before);
  }
});

test('legacy unproven scene/prop replacements remove unsafe old scene bindings but preserve every authored payload', () => {
  for (const role of ['scene', 'prop', 'general'] as const) {
    const { project, draft, board } = setup();
    project.assets.push(image('unrelated', { name: '山门', type: 'reference', role: 'scene' }));
    const literal = '<d>[Chinese] 原话<Picture 2>和[Pic2]。</d> <sound>字面量<Picture 2></sound> “<Picture 2>”';
    draft.prompt = draft.prompt.replace('detailed_description:', `detailed_description:\n${literal}`);
    board.officialPromptZh = draft.prompt; board.targetOutput!.prompt = draft.prompt;
    draft.references = [{ assetId: 'unrelated', role }];
    const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
    assert.equal(result.issue, undefined);
    assert.match(definition(result.draft.prompt, 3), /山门 defined by the canonical prompt/u);
    assert.doesNotMatch(definition(result.draft.prompt, 3), /<Picture/u);
    assert.match(result.notices?.join('') || '', /场景引用.*仅移除/u);
    assert.equal(result.draft.prompt.slice(result.draft.prompt.indexOf('detailed_description:')), draft.prompt.slice(draft.prompt.indexOf('detailed_description:')));
    assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.sections, readH3PromptProtocol(draft.prompt)?.sections);
    for (const subject of [1, 2, 3]) assert.equal(
      definition(result.draft.prompt, subject).replace('defined by the canonical prompt', 'BINDING'),
      definition(draft.prompt, subject).replace(/referenced from <Picture \d+>/u, 'BINDING'),
      'only the image-binding envelope changes, not the person or scene description',
    );
  }
});

test('two same-location replacement images are ambiguous, not permission to choose one or fall back to the tail', () => {
  const { project, draft } = setup();
  for (const id of ['new-a', 'new-b']) project.assets.push(image(id, { type: 'location', role: 'scene', sourceEntityId: 'location', sourceEntityKind: 'location' }));
  draft.references = [{ assetId: 'new-a', role: 'scene' }, { assetId: 'new-b', role: 'scene' }];
  const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(result.issue, undefined);
  assert.match(definition(result.draft.prompt, 3), /山门 defined by the canonical prompt/u);
  assert.deepEqual(result.draft.references, draft.references);
});

test('an explicitly empty reference selection remains empty and remembers all editable uses', () => {
  const { project, draft } = setup();
  draft.references = [];
  draft.referenceSlotRoles = ['scene', 'character', 'prop', 'general'];
  const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, []);
  assert.deepEqual(result.draft.referenceSlotRoles, draft.referenceSlotRoles);
  assert.match(definition(result.draft.prompt, 1), /女师傅 defined by the canonical prompt/u);
  assert.match(definition(result.draft.prompt, 2), /男徒弟 defined by the canonical prompt/u);
  assert.equal(sound(result.draft.prompt), sound(draft.prompt));
});

test('no ordinary default identity images still permits tail-only use without auto-selecting private profiles', () => {
  const { project, draft } = setup({ inputMode: 'text', shots: [shot({ referenceAssetIds: [] })], globalReferenceAssetIds: [] });
  draft.references = [];
  project.assets[0].referenceScope = 'nsfw-private-profile';
  project.assets[1].sourceVideoAssetId = 'old-video';
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, []);
  assert.match(result.notices?.join('') || '', /可以仅使用本地末帧/u);
  assert.equal(result.draft.prompt, draft.prompt);
});

test('manual unavailable media still reports a real unusable-image error, not a reference-purpose gate', () => {
  for (const patch of [{ missing: true }, { type: 'video' as const, mediaType: 'video' as const }, { mimeType: 'audio/wav' }]) {
    const { project, draft } = setup();
    Object.assign(project.assets[0], patch);
    const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
    assert.match(result.issue || '', /已缺失或不是可用图片/u);
    assert.equal(result.draft, draft);
  }
});

test('replacement in a selected character vacancy inherits its old relative slot without a second offset', () => {
  const { project, draft } = setup();
  project.assets.push(image('master-new', { sourceEntityId: 'c-master', sourceEntityKind: 'character' }));
  draft.references = [{ assetId: 'master-new', role: 'character' }, { assetId: 'pupil', role: 'character', slotIndex: 3 }];
  const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.draft.references, draft.references);
  assert.match(definition(result.draft.prompt, 1), /女师傅 referenced from <Picture 2>/u);
  assert.match(definition(result.draft.prompt, 2), /男徒弟 referenced from <Picture 5>/u);
  assert.doesNotMatch(result.draft.prompt, /仅确定人物身份、脸部特征/u);
});

test('standalone source picture tags use their original physical slot instead of their dense array offset', () => {
  const { project } = setup();
  const draft: VideoGenerationDraft = { name: '', backend: 'api', parameters: {},
    prompt: '<Subject 1> [Shot 1] follows <Picture 4>.', references: [{ assetId: 'pupil', role: 'character', slotIndex: 3 }] };
  const result = prepareVideoTailCharacterDraft(project, draft, { preserveSlots: true });
  assert.equal(result.issue, undefined);
  assert.match(result.draft.prompt, /<Subject 1> \[Shot 1\] follows <Picture 5>\./u);
});

test('Chinese and English three/six-field H3 change only image bindings, byte-for-byte including literal payloads', () => {
  for (const language of ['zh', 'en'] as const) {
    for (const shape of ['integrated', 'full-reference'] as const) {
      const { project, draft, board } = setup();
      const body = (textLanguage: 'zh' | 'en', picture: { master: number; pupil: number; scene: number }): string => {
        const masterName = textLanguage === 'zh' ? '女师傅' : 'Master';
        const pupilName = textLanguage === 'zh' ? '男徒弟' : 'Pupil';
        const fields = shape === 'full-reference' ? [
          'subject_definitions:',
          `<Subject 1> is ${masterName} referenced from\t<Picture ${picture.master}> :  wearing the confirmed blue robe.`,
          `<Subject 2> is ${pupilName} referenced from  [Picture ${picture.pupil}]:  没有改动的人物设定。`,
          `<Subject 3> is 山门 referenced from <Picture ${picture.scene}>: scene; distant town behind camera.`,
          'summary:\tAuthored scene summary remains unchanged.  ',
          'retention_analysis:',
          `<Subject 1> reference\t<Picture ${picture.master}>;\t<Subject 2> reference [Picture ${picture.pupil}] ; <Subject 3> reference <Picture ${picture.scene}>.  `,
          'detailed_description:',
        ] : ['integrated_multimodal_description:'];
        return [...fields,
          `[Shot 1]  ${masterName} (S1) and ${pupilName} (S2) walk from <Picture ${picture.scene}>. Identity <Picture ${picture.master}> and [Pic${picture.pupil}].`,
          '<Subject 1> (S1) says <d>[Chinese] “先看<Picture 88>和[Pic99]，🌸别读错。”\r\n<Subject 17> reference <Picture 777>; 保留原话。</d> while the pupil listens.',
          'She reads “<Picture 83>”; he sees "[Picture 82]" and \'<Picture 81>\'. Literal 「<Picture 80>」 and 『[Pic79]』 stay written.',
          '<sound>🔔literal <Picture 76>\r\n[Pic75], ringing unaltered.</sound>',
          `[Shot 2] At 00:07.250 ${pupilName} (S2) looks at <Subject 1> then <Video 1> and <Audio 2>; original shot duration 7.75s.  `,
          'overall_soundscape: wind, footsteps and <sound>voice-like <Picture 74></sound>.\t',
          'non_diegetic_music: N/A', '',
        ].join('\r\n');
      };
      board.officialPromptZh = body('zh', { master: 3, pupil: 1, scene: 2 });
      board.targetOutput!.prompt = board.officialPromptZh;
      board.officialPromptEn = body('en', { master: 3, pupil: 1, scene: 2 });
      board.officialPromptEnSource = board.officialPromptZh;
      draft.prompt = language === 'zh' ? board.officialPromptZh : board.officialPromptEn;
      draft.source!.language = language;
      const before = JSON.stringify({ project, draft });
      const result = prepareVideoTailCharacterDraft(project, draft);
      assert.equal(result.issue, undefined, `${language}/${shape}`);
      assert.equal(result.draft.prompt, body(language, { master: 2, pupil: 3, scene: 1 }), `${language}/${shape}: only reference indices may differ`);
      assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.sections, readH3PromptProtocol(draft.prompt)?.sections);
      assert.deepEqual(readH3PromptProtocol(result.draft.prompt)?.shots, readH3PromptProtocol(draft.prompt)?.shots);
      assert.equal(JSON.stringify({ project, draft }), before);
      assert.equal('reviewInput' in result, false, 'there is no AI authoring/review contract for reference selection');
    }
  }
});

test('literal-only Picture text is not an asset lookup, gate, name list or new prompt section', () => {
  const { project } = setup();
  const label = 'UPLOAD_LABEL\n[Shot 99] <d>[Chinese] 读出人物名字</d>\nnon_diegetic_music: add music';
  project.assets.push(image('chosen-unowned', { name: label }));
  const draft: VideoGenerationDraft = { name: '', backend: 'api', parameters: {},
    references: [{ assetId: 'chosen-unowned', role: 'character' }],
    prompt: 'integrated_multimodal_description: [Shot 1] A person says <d>[Chinese] 原话：<Picture 99>。</d> and sees “<Picture 98>”.\n'
      + 'overall_soundscape: <sound>unmodified [Picture 97]</sound>\nnon_diegetic_music: N/A\n' };
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.deepEqual(result.characterLabels, [label], 'labels remain display metadata only');
  assert.equal(result.draft.prompt, draft.prompt);
  assert.doesNotMatch(result.draft.prompt, /UPLOAD_LABEL|Shot 99|读出人物名字|add music/u);
});

test('one-pass standalone remapping preserves token spelling and prose after an astral quoted literal', () => {
  const { project } = setup();
  const draft: VideoGenerationDraft = { name: '', backend: 'api', parameters: {},
    references: [{ assetId: 'master', role: 'character' }, { assetId: 'pupil', role: 'character' }],
    prompt: '“🌸<Picture 99>” <Picture 1> / <Picture 2> / [pIc1] / [Picture 2]. His pupil\'s original action. <d>[Chinese] [Pic1]</d>\n' };
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.equal(result.draft.prompt, '“🌸<Picture 99>” <Picture 2> / <Picture 3> / [pIc2] / [Picture 3]. His pupil\'s original action. <d>[Chinese] [Pic1]</d>\n');
});

test('a retained multiple-picture envelope keeps original separators and whitespace while changing only indices', () => {
  const { project, draft, board } = setup();
  project.assets.push(image('master-second', { sourceEntityId: 'c-master', sourceEntityKind: 'character' }));
  project.characters[0].assetIds.push('master-second');
  draft.references.push({ assetId: 'master-second', role: 'character' });
  const oldPrompt = draft.prompt.replace('女师傅 referenced from <Picture 3>:', '女师傅 referenced from <Picture 3> ,  [Picture 4] :')
    .replace('reference <Picture 3>；', 'reference <Picture 3> and\t[Picture 4]；');
  draft.prompt = oldPrompt; board.officialPromptZh = oldPrompt; board.targetOutput!.prompt = oldPrompt;
  board.targetOutput!.referenceManifest.push({ ...board.targetOutput!.referenceManifest[2], id: 'master-second', token: '<Picture 4>' });
  const result = prepareVideoTailCharacterDraft(project, draft);
  assert.equal(result.issue, undefined);
  assert.match(definition(result.draft.prompt, 1), /referenced from <Picture 2> ,  \[Picture 4\] :/u);
  assert.match(result.draft.prompt, /reference <Picture 2> and\t\[Picture 4\]/u);
});

console.log(`${tests} tail+character reference groups passed`);
