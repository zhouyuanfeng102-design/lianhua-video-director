import assert from 'node:assert/strict';
import { videoSegmentCharacterHints } from '../src/videoSegmentCharacters';
import { resolveSeedanceCharacterParticipation } from '../src/characterParticipation';
import type { Character, Project, Storyboard, VideoSegment, VideoSequencePlan } from '../src/types';

const character = (id: string, name: string, aliases: string[] = [], assetIds: string[] = []): Character => ({
  id, name, aliases, assetIds, gender: '', apparentAge: '', race: '', appearance: '', outfit: '',
  signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '',
});

const segment = (patch: Partial<VideoSegment> = {}): VideoSegment => ({
  id: 'segment-1', index: 1, title: '冲锋', globalStartSec: 0, globalEndSec: 10,
  durationSec: 10, content: '', summary: '', sourceSceneIds: [], sourceBeatIds: [],
  narrativePurpose: '', entryState: '', exitState: '', transitionHint: '', status: 'planned',
  ...patch,
});

const baseProject = (characters: Character[]): Project => ({
  id: 'project-1', name: '测试', characters, locations: [], props: [], scenes: [], storyboards: [],
  sequencePlans: [], assets: [], generationTasks: [], settings: {},
} as unknown as Project);

const plan = (segments: VideoSegment[]): VideoSequencePlan => ({
  id: 'plan-1', title: '测试计划', sourceStoryTitle: '测试', sourceStoryContent: '', durationMode: 'ai-estimated',
  totalDurationSec: 10, segmentDurationSec: 10, segmentationMode: 'natural', fitStatus: 'comfortable',
  segments, createdAt: 0, updatedAt: 0,
} as unknown as VideoSequencePlan);

const shalltear = character('shalltear', '夏提雅', ['夏提雅·血天使'], ['shalltear-ref']);
const enemies = character('enemies', '兽人军团', ['敌人', '敌军'], ['enemy-ref']);
const scene = { id: 'scene-1', title: '战场', content: '', summary: '', characterIds: ['shalltear.id', 'enemies'], propIds: [], storyboardIds: [], createdAt: 0, updatedAt: 0 };

{
  const current = segment({ sourceSceneIds: ['scene-1'], content: '一群敌人从远处冲向夏提雅。' });
  const project = { ...baseProject([shalltear, enemies]), scenes: [{ ...scene, characterIds: ['shalltear', 'enemies'] }], assets: [
    { id: 'shalltear-ref', name: '夏提雅参考图', type: 'character', role: 'character', mediaType: 'image', tags: [], missing: false },
  ] } as unknown as Project;
  const result = videoSegmentCharacterHints(project, plan([current]), current);
  assert.deepEqual(result.characters.map((item) => item.id), ['shalltear', 'enemies']);
  assert.equal(result.characters.find((item) => item.id === 'shalltear')?.referenceImageCount, 1);
}

{
  const current = segment({ content: '敌军向夏提雅冲锋。' });
  const project = baseProject([shalltear, enemies]);
  const result = videoSegmentCharacterHints(project, plan([current]), current);
  assert.deepEqual(result.characters.map((item) => item.id), ['shalltear', 'enemies']);
  assert.equal(result.usedFallback, true);
}

{
  const current = segment({ content: '战场上只有烟尘和碎石。' });
  const result = videoSegmentCharacterHints(baseProject([shalltear, enemies]), plan([current]), current);
  assert.deepEqual(result.characters, []);
}

const fullShalltear = character('shalltear', '夏提雅·布拉德弗伦', [], ['shalltear-ref']);
const aura = character('aura', '亚乌菈·贝拉·菲欧拉', [], ['aura-ref']);
const king = character('king', '贝·里尤洛');
const shotPrompt = (body: string) => `integrated_multimodal_description: ${body}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`;
const boardWith = (prompt: string, patch: Partial<Storyboard> = {}): Storyboard => ({
  id: 'board-1', shots: [], finalPrompt: prompt, officialPromptZh: prompt, ...patch,
} as unknown as Storyboard);

{
  const project = baseProject([fullShalltear, aura, king]);
  const current = segment({ content: '贝·里尤洛等待敌人。' });
  const prompt = shotPrompt('[Shot 1] 贝·里尤洛站在前景。远景王都通道口，夏提雅与亚乌菈并肩走出。');
  const board = boardWith(prompt);
  const before = JSON.stringify({ project, current, board });
  const result = videoSegmentCharacterHints(project, plan([current]), current, board, prompt);
  assert.deepEqual(new Set(result.characters.map((item) => item.id)), new Set(['shalltear', 'aura', 'king']), 'first segment includes distant short-name characters present only in final prompt');
  assert.equal(JSON.stringify({ project, current, board }), before, 'reading the hint does not mutate source data');
}

{
  const project = baseProject([fullShalltear, aura, king]);
  const prompt = shotPrompt('[Shot 1] 贝·里尤洛站在高台。\n[Shot 6] 镜头越过高台向远方战场，远景中的夏提雅挥动长枪。');
  const current = segment({ content: '贝·里尤洛说：“夏提雅绝不可能获胜。”' });
  const result = videoSegmentCharacterHints(project, plan([current]), current, boardWith(prompt));
  assert.deepEqual(result.characters.find((item) => item.id === 'shalltear')?.shotIndexes, [6], 'fifth segment uses later shot instead of only first-shot cast');
  assert.ok(!result.characters.some((item) => item.id === 'aura'), 'characters from other segments do not leak into this shot');
}

{
  const project = baseProject([fullShalltear, aura]);
  const chinese = shotPrompt('[Shot 1] 夏提雅与亚乌菈并肩走出，站在洞口。');
  const english = shotPrompt('[Shot 1] Shalltear and Aura walk out and stand at the cavern entrance.');
  const board = boardWith(chinese, { officialPromptEn: english, officialPromptEnSource: chinese });
  const result = videoSegmentCharacterHints(project, undefined, segment(), board, english);
  assert.deepEqual(new Set(result.characters.map((item) => item.id)), new Set(['shalltear', 'aura']), 'verified Chinese-English pairing preserves identity when English aliases were not stored');
  const aliased = baseProject([{ ...fullShalltear, aliases: ['Shalltear Bloodfallen'] }]);
  assert.equal(videoSegmentCharacterHints(aliased, undefined, segment(), undefined, shotPrompt('[Shot 1] shalltear bloodfallen stands at the gate.')).characters[0]?.id, 'shalltear');
}

{
  const project = baseProject([fullShalltear, king]);
  const prompt = shotPrompt('[Shot 1] 贝·里尤洛站在高台，低声说道：<d>[Chinese]夏提雅一定还活着。</d>');
  const result = videoSegmentCharacterHints(project, undefined, segment(), boardWith(prompt));
  assert.deepEqual(result.characters.map((item) => item.id), ['king']);
  assert.deepEqual(result.mentionedCharacters.map((item) => item.id), ['shalltear'], 'dialogue-only name stays separate from visible cast');
}

{
  const formA = { ...fullShalltear, id: 'form-a', name: '夏提雅·女武神形态', baseName: '夏提雅', formLabel: '女武神形态' };
  const formB = { ...fullShalltear, id: 'form-b', name: '夏提雅·普通形态', baseName: '夏提雅', formLabel: '普通形态' };
  const result = videoSegmentCharacterHints(baseProject([formA, formB]), undefined, segment(), undefined, shotPrompt('[Shot 1] 夏提雅站在门口。'));
  assert.deepEqual(result.characters, [], 'a bare name cannot select both forms');
  assert.ok(result.ambiguousNames.includes('夏提雅'));
}

{
  const current = segment();
  const frozen = { ...plan([current]), planningMode: 'semantic-segments', semanticPlanningSnapshot: {
    version: 1, characterContinuity: [fullShalltear],
  } } as unknown as VideoSequencePlan;
  const project = { ...baseProject([{ ...fullShalltear, name: '后来改名', assetIds: ['live-ref'] }]), assets: [
    { id: 'live-ref', name: '当前人物图', type: 'character', mediaType: 'image', tags: [] },
  ] } as unknown as Project;
  const result = videoSegmentCharacterHints(project, frozen, current, undefined, shotPrompt('[Shot 1] 夏提雅站在门口。'));
  assert.equal(result.characters[0]?.name, fullShalltear.name, 'frozen identity remains unchanged');
  assert.equal(result.characters[0]?.referenceImageCount, 1, 'current same-ID assets remain available');
}

const seedancePrompt = (subjects: string, timeline: string, references = '无参考图片。') => [
  '视频规格：30秒，16:9。', `参考素材与职责：${references}`, `主体连续性：${subjects}`,
  '一句话概述：一行人安静汇合。', `连续时间轴：\n\n${timeline}`, '全局约束：保持人物身份连续。',
].join('\n\n');

{
  // Regression shape: a silent fourth actor is declared in continuity and
  // gestures later, with neither a H3 shot marker nor the legacy action verbs.
  const people = ['青舟', '银霁', '赤羽', '棠梨'].map((name, index) => character(`actor-${index}`, name, [], [`image-${index}`]));
  const prompt = seedancePrompt(
    '青舟为二十岁左右男性，黑色碎发，穿黑色西装；银霁为女性人造人，银白长发，动作轻盈；赤羽为高挑女性，穿皮衣，本段不显露龙角；棠梨为十九岁左右女性，穿短衣短裤。本段实际发话者为赤羽；其余人物在本段不说话。',
    '0秒至9秒，青舟站在空地中央，银霁走出舱门。\n\n9秒至17秒，青舟盘坐。\n\n17秒至22秒，赤羽抱胸而立，棠梨等人也摆手拒绝。\n\n22秒至30秒，青舟转身。',
  );
  const project = { ...baseProject(people), assets: people.map((person, index) => ({
    id: `image-${index}`, name: person.name, type: 'character', mediaType: 'image', tags: [],
  })) } as unknown as Project;
  const h3 = shotPrompt('[Shot 1] 青舟站在门口。');
  const board = boardWith(h3, { seedance25Output: { targetId: 'seedance-2.5', promptZh: prompt,
    promptEn: 'Video specs: 30 seconds.\nReferences and responsibilities: None.\nSubject continuity: Four adults keep their appearance.\nSummary: A quiet meeting.\nContinuous timeline: 0–30 seconds, they gather.\nGlobal constraints: Keep identities.',
    durationSec: 30, sourceFingerprint: 'current', englishSourceFingerprint: 'current', referenceManifest: [], warnings: [], generatedAt: 1 } });
  const before = JSON.stringify({ project, board });
  const result = videoSegmentCharacterHints(project, undefined, segment(), board, prompt);
  assert.deepEqual(new Set(result.characters.map((entry) => entry.id)), new Set(people.map((person) => person.id)), 'quiet named subjects do not depend on a short action-verb dictionary');
  assert.equal(result.mentionedCharacters.length, 0);
  assert.equal(result.characters.find((entry) => entry.id === 'actor-3')?.referenceImageCount, 1);
  const participation = resolveSeedanceCharacterParticipation(prompt, people);
  assert.equal(participation.characters.find((entry) => entry.characterId === 'actor-3')?.presence, 'visible');
  assert.ok(participation.characters.find((entry) => entry.characterId === 'actor-3')?.evidence.some((value) => value.startsWith('棠梨为')));
  assert.deepEqual(participation.characters.find((entry) => entry.characterId === 'actor-3')?.shotIndexes, [3], 'natural timeline paragraphs retain their real shot number');
  assert.deepEqual(new Set(videoSegmentCharacterHints(project, undefined, segment(), board, board.seedance25Output!.promptEn!).characters.map((entry) => entry.id)),
    new Set(people.map((person) => person.id)), 'the exact verified Seedance English pair uses its Chinese identities rather than unrelated H3');
  const stalePair = { ...board, seedance25Output: { ...board.seedance25Output!, englishSourceFingerprint: 'old' } };
  assert.deepEqual(videoSegmentCharacterHints(project, undefined, segment(), stalePair, board.seedance25Output!.promptEn!).characters, [], 'a stale English pair cannot borrow Chinese identities');
  assert.deepEqual(videoSegmentCharacterHints(project, undefined, segment(), board, `${board.seedance25Output!.promptEn}\nEdited.`).characters, [], 'edited English cannot silently borrow a saved identity pairing');
  assert.equal(JSON.stringify({ project, board }), before, 'the format adapter does not edit stored prompts or source data');
}

{
  const people = ['晨星', '暮云', '远川', '秋水', '映月', '文竹', '嘉木'].map((name) => character(name, name));
  const prompt = seedancePrompt(
    '晨星与暮云保持原有衣着；远川为画外发声者，穿旧披风；秋水为白发女性，本段不出场；映月仅被提及，穿蓝裙；文竹是否在场尚不确定。',
    '0秒至30秒，晨星站在门前说：“嘉木穿着银袍站在塔顶。”',
    '嘉木参考图：嘉木穿着银袍，站在塔顶。',
  );
  const participation = resolveSeedanceCharacterParticipation(prompt, people);
  const presence = Object.fromEntries(participation.characters.map((entry) => [entry.characterId, entry.presence]));
  assert.equal(presence.晨星, 'visible');
  assert.equal(presence.暮云, 'visible', 'a coordinated continuity declaration includes quiet companions');
  assert.equal(presence.远川, 'offscreen');
  for (const name of ['秋水', '映月', '文竹', '嘉木']) assert.equal(presence[name], 'mentioned', `${name} is not promoted by an exclusion, uncertain declaration, image description or dialogue quote`);
  const fallback = resolveSeedanceCharacterParticipation('主体连续性：嘉木为银发女性。', people);
  assert.equal(fallback.characters.find((entry) => entry.characterId === '嘉木')?.presence, 'mentioned', 'a heading-shaped fragment is not a verified Seedance section structure');
}

{
  for (const delimiter of ['，', ',', '；', '\n']) {
    const people = [character('a', '青岚'), character('b', '白榆')];
    const prompt = seedancePrompt(`青岚为青年穿黑衣${delimiter}白榆为青年穿白衣。`, '0秒至30秒，空地安静。');
    assert.deepEqual(new Set(resolveSeedanceCharacterParticipation(prompt, people).characters.filter((entry) => entry.presence === 'visible').map((entry) => entry.characterId)),
      new Set(['a', 'b']), `direct identity declarations survive ${JSON.stringify(delimiter)} separators`);
    const relative = seedancePrompt(`青岚为青年穿黑衣${delimiter}青岚的朋友白榆为青年穿白衣。`, '0秒至30秒，空地安静。');
    assert.equal(resolveSeedanceCharacterParticipation(relative, people).characters.find((entry) => entry.characterId === 'b')?.presence,
      'mentioned', 'a named relative inside another subject biography is not a direct segment subject declaration');
  }
  const english = ['Video specs: 30 seconds.', 'References and responsibilities: None.', 'Subject continuity: Rowan is a young man.\nLark is a woman.',
    'Summary: A meeting.', 'Continuous timeline:\n0 to 10 seconds, Rowan stands at the gate.\n10 to 30 seconds, Lark walks out.', 'Global constraints: Keep identities.'].join('\n');
  assert.deepEqual(resolveSeedanceCharacterParticipation(english, [character('rowan', 'Rowan'), character('lark', 'Lark')]).characters.find((entry) => entry.characterId === 'lark')?.visibleShotIndexes,
    [2], 'English natural timeline ranges also retain later-shot participation');
}

{
  const people = [character('form-a', '云歌·普通形态'), character('form-b', '云歌·战斗形态'),
    character('other', '旧友'), { ...character('archived', '退役者'), dossier: { archivedIntoCharacterId: 'other' } } as Character];
  const prompt = seedancePrompt('云歌为长发女性；旧友的姐姐穿红裙；退役者为短发女性。', '0–30秒，空地无人。');
  const result = resolveSeedanceCharacterParticipation(prompt, people);
  assert.deepEqual(result.characters.filter((entry) => entry.presence === 'visible'), [], 'an ambiguous visual form, relative or archived dossier is not guessed');
  assert.ok(result.ambiguousNames.includes('云歌'));
}

console.log('videoSegmentCharacters tests passed: H3 compatibility, Seedance declared quiet subjects, natural time ranges, verified English pairing, exclusions, names, forms and immutability');
