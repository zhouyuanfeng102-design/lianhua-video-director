import assert from 'node:assert/strict';
import { videoSegmentCharacterHints } from '../src/videoSegmentCharacters';
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

console.log('videoSegmentCharacters tests passed: final prompt, names, later shots, English, mentions, forms, immutability');
