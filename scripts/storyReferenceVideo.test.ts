import assert from 'node:assert/strict';
import { buildOfficialH3References, buildOfficialH3SourceFingerprint, buildOfficialH3SubjectDefinitions } from '../src/officialPrompt';
import { applyVideoPromptChoice } from '../src/videoDirectorDraft';
import { prepareVideoH3ReferenceDraft } from '../src/videoH3ReferenceBinding';
import { VideoGenerationEngine } from '../src/videoGeneration';
import { createInitialState } from '../src/storage';
import type { Character, ReferenceAsset, Storyboard, StoryReferenceAnalysis, StoryReferenceContext, VideoGenerationTask, VideoTaskApiConfig } from '../src/types';
import type { VideoGenerationDesktop } from '../src/videoGenerationTypes';

const character = (id: string, name: string): Character => ({ id, name, assetIds: [], gender: '', race: '人类', apparentAge: '成年',
  appearance: '稳定外貌', outfit: '蓝衣', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '' });
const pixels = ['data:image/png;base64,aVBORw0KGgo=', 'data:image/png;base64,bVBORw0KGgo='];
const asset = (id: string, index: number): ReferenceAsset => ({ id, name: id, type: 'reference', role: 'composition', referenceRole: 'general',
  source: 'upload', mediaType: 'image', dataUrl: pixels[index], checksum: `checksum-${id}`, tags: [], createdAt: 1, updatedAt: 1 });
const analysis: StoryReferenceAnalysis = {
  description: `${'完整画面细节'.repeat(1600)}最后一项不可丢失`,
  characters: [{ id: 'left', label: '左侧人物', description: '黑发', fields: { clothing: '蓝衣' } }, { id: 'right', label: '右侧人物', description: '白发', fields: { clothing: '白衣' } }],
  locations: [], props: [], events: ['两人坐着'], relationships: ['隔桌相对'], readableText: ['图中文字'], uncertainties: ['背景不清晰'],
  style: '写实', lighting: '侧光', colors: '蓝白', composition: '双人中景', model: 'saved-vision', revision: 2, analyzedAt: 1,
  structuredData: { extras: { details: ['画面边缘细节'] } }, rawResponse: '完整原始识图结果',
};
const references: StoryReferenceContext = { mode: 'image', chapterId: 'chapter', fingerprint: 'input-fingerprint', text: 'UI mirror',
  references: [
    { referenceId: 'ref-group', number: 9, assetId: 'group', analysis, notes: '用户修改：让两人站起来', fullDescription: '人工修订完整描述', subjectBindings: [
      { subjectId: 'left', kind: 'character', entityId: 'a', name: '甲' }, { subjectId: 'right', kind: 'character', entityId: 'b', name: '乙' },
    ] },
    { referenceId: 'ref-a', number: 3, assetId: 'portrait', analysis: { ...analysis, characters: [analysis.characters[0]] }, subjectBindings: [
      { subjectId: 'left', kind: 'character', entityId: 'a', name: '甲' },
    ] },
  ],
};
const anchorA = 'Identity: 甲 (S1), black hair and blue robe.';
const anchorB = 'Identity: 乙 (S2), white hair and white robe.';
const prompt = `integrated_multimodal_description:\n[Shot 1] ${anchorA} ${anchorB}\n甲站起，乙随后起身。<d>[Chinese] 一起走。</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
const board: Storyboard = {
  id: 'board', sceneId: 'scene', chapterId: 'chapter', workflow: 'drama', inputMode: 'text_reference',
  durationSec: 5, durationPreset: '5s', shotMode: 'exact', shotCount: 1, pace: 'standard', aspectRatio: '16:9', resolution: '1080p', audioMode: 'stereo',
  stylePresetId: '', ruleSetId: '', converterPresetId: '', globalLock: '', globalReferenceAssetIds: ['portrait', 'group'],
  shots: [{ id: 'shot', index: 1, startSec: 0, endSec: 5, purpose: '互动', subject: '甲与乙', action: '甲站起，乙起身', camera: '中景', transition: '切', lighting: '侧光', sound: '脚步', result: '两人并肩', prompt: '', referenceAssetIds: [], locked: false }],
  finalPrompt: '【0s-5s】主体：甲与乙；动作：两人起身；空间：室内；光影：侧光；镜头：中景；台词：一起走；音效：脚步。',
  officialPromptZh: prompt, storyReferenceContext: structuredClone(references),
  h3IdentityBindings: { version: 1, characters: [
    { characterId: 'a', name: '甲', speakerToken: '(S1)', referenceAnchor: anchorA },
    { characterId: 'b', name: '乙', speakerToken: '(S2)', referenceAnchor: anchorB },
  ] }, createdAt: 1, updatedAt: 1,
};
let state = createInitialState();
state.projects = [];
state.project.id = 'reference-video-project';
state.project.characters = [character('a', '甲'), character('b', '乙'), character('other', '其他人物')];
state.project.assets = [asset('group', 0), asset('portrait', 1)];
state.project.storyboards = [board]; state.project.locations = []; state.project.props = []; state.project.scenes = []; state.project.generationTasks = [];
const context = { assets: state.project.assets, characters: state.project.characters };
const inputs = buildOfficialH3References(board, context.assets, context.characters);
assert.deepEqual(inputs.map((input) => input.id), ['portrait', 'group']);
const group = inputs.find((input) => input.id === 'group')!;
assert.ok(group.responsibility?.includes(analysis.description), 'complete evidence must survive into the converter');
assert.match(group.responsibility!, /人工修订完整描述/u);
assert.match(group.responsibility!, /它不是 <Picture N>/u);
assert.match(group.responsibility!, /不重演原图静态动作/u);
assert.deepEqual((group.storyReferenceSubjects as Array<{ entityId: string }>).map((subject) => subject.entityId), ['a', 'b']);
const definitions = buildOfficialH3SubjectDefinitions(board, context, inputs);
assert.deepEqual(definitions.find((definition) => definition.name === '甲')?.referenceAssetIds, ['portrait', 'group']);
assert.deepEqual(definitions.find((definition) => definition.name === '乙')?.referenceAssetIds, ['group']);
const originalFingerprint = buildOfficialH3SourceFingerprint(board, context);
state.project.assets[0].storyReferenceSubjects = [{ chapterId: 'chapter', referenceId: 'ref-group', subjectId: 'left', kind: 'character', entityId: 'other', label: '后来关联' }];
assert.equal(buildOfficialH3SourceFingerprint(board, context), originalFingerprint, 'same-ID live subject metadata must not rewrite the frozen board');
const edited = structuredClone(board); edited.storyReferenceContext!.references[0].notes = '新的人工修订';
assert.notEqual(buildOfficialH3SourceFingerprint(edited, context), originalFingerprint, 'hash full frozen content even if the input fingerprint string was unchanged');

const draft = applyVideoPromptChoice({ name: '', prompt: '', backend: 'api', references: [], parameters: {} }, {
  id: 'board:zh', storyboardId: board.id, label: '参考图章节', language: 'zh', prompt, durationSec: 5, updatedAt: 1, version: '当前',
}, state.project, true);
assert.deepEqual(draft.references.map((reference) => reference.assetId), ['portrait', 'group']);
assert.deepEqual(draft.references.map((reference) => reference.characterIds), [['a'], ['a', 'b']]);
assert.deepEqual(draft.references.map((reference) => reference.role), ['general', 'general'], 'preserve actual image purposes');
const api: VideoTaskApiConfig = { enabled: true, provider: 'generic', endpoint: 'https://reference-video.invalid/generate',
  statusEndpointTemplate: 'https://reference-video.invalid/task/{id}', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer',
  taskIdPath: 'id', statusPath: 'status', resultUrlPath: 'url', model: 'mock-model' };
const prepared = prepareVideoH3ReferenceDraft(state.project, draft, { backend: 'api', api }).draft;
assert.match(prepared.prompt, /甲 \(S1\): <Picture 1>, <Picture 2>/u);
assert.match(prepared.prompt, /乙 \(S2\): <Picture 2>/u);
assert.doesNotMatch(prepared.prompt, /<Picture [39]>/u, 'chapter labels must not become submitted picture slots');

state.settings.videoTaskApi = api;
const posts: Record<string, unknown>[] = [];
const desktop = {
  videoRequest: async (request: Parameters<VideoGenerationDesktop['videoRequest']>[0]) => {
    if (request.method === 'POST') { posts.push(JSON.parse(request.body!)); return { status: 200, body: JSON.stringify({ id: 'mock-reference-task', status: 'queued' }) }; }
    return { status: 200, body: JSON.stringify({ status: 'processing' }) };
  },
  setVideoTaskCredential: async () => ({ persisted: true }), getVideoTaskCredential: async () => null,
  saveVideoTaskCheckpoint: async () => ({ persisted: true }), onVideoProgress: () => () => undefined,
} as unknown as VideoGenerationDesktop;
const engine = new VideoGenerationEngine({ getState: () => state, setState: (update) => { state = update(state); }, desktop, onRuntime: () => undefined, pollIntervalMs: 100000 });
try {
  const taskId = await engine.start(prepared);
  const task = state.project.generationTasks.find((entry) => entry.id === taskId) as VideoGenerationTask;
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].images, [pixels[1], pixels[0]], 'both real image payloads reach the existing request in bound order');
  assert.equal(posts[0].prompt, prepared.prompt);
  assert.deepEqual(task.videoJob!.snapshot.draft.references.map((reference) => reference.characterIds), [['a'], ['a', 'b']]);
  assert.deepEqual(task.videoJob!.snapshot.images.map((image) => image.assetId), ['portrait', 'group']);
  assert.deepEqual(task.videoJob!.snapshot.images.map((image) => image.dataUrl), [pixels[1], pixels[0]]);
  prepared.references[1].characterIds!.reverse(); state.project.assets[0].dataUrl = 'changed';
  assert.deepEqual(task.videoJob!.snapshot.draft.references[1].characterIds, ['a', 'b']);
  assert.equal(task.videoJob!.snapshot.images[1].dataUrl, pixels[0], 'task keeps its original frozen pixels');
} finally { engine.dispose(); }
console.log('Story reference video: complete frozen evidence, multi-character IDs, slot mapping and real image request snapshots passed with a mock transport.');
