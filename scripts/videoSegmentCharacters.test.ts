import assert from 'node:assert/strict';
import { videoSegmentCharacterHints } from '../src/videoSegmentCharacters';
import type { Character, Project, VideoSegment, VideoSequencePlan } from '../src/types';

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

console.log('videoSegmentCharacters tests passed');
