import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { directorLookSource, type DirectorLookSourceInput } from '../src/directorLookSource';
import { createInitialState, normalizeState, serializeStateForStorage } from '../src/storage';

const source: DirectorLookSourceInput = {
  productionMode: 'single', sequenceSettingsOpen: false,
  sourceScenes: [{ title: '开场', content: '开场剧情。' }, { title: '收尾', content: '收尾剧情。' }],
  storyInput: '编辑区完整剧情。', storyName: '故事标题', sceneTitle: '单场标题',
  plan: { id: 'plan-a', sourceStoryTitle: '全片标题', sourceStoryContent: '全片开头，中段与结尾。' },
  segment: { id: 'segment-a', title: '第一段', content: '仅第一段剧情。' },
};
assert.deepEqual(directorLookSource(source), { title: '故事标题', story: '【开场】\n开场剧情。\n\n【收尾】\n收尾剧情。', scope: 'single' });
assert.equal(directorLookSource({ ...source, sourceScenes: [] }).story, source.storyInput);
assert.deepEqual(directorLookSource({ ...source, productionMode: 'sequence' }), { title: '第一段', story: '仅第一段剧情。', scope: 'segment:plan-a:segment-a' });
assert.deepEqual(directorLookSource({ ...source, productionMode: 'sequence', sequenceSettingsOpen: true }), { title: '全片标题', story: '全片开头，中段与结尾。', scope: 'film:plan-a' });
assert.equal(directorLookSource({ ...source, productionMode: 'sequence', segment: undefined }).story, source.plan!.sourceStoryContent);
assert.equal(directorLookSource({ ...source, productionMode: 'sequence', sequenceSettingsOpen: true, plan: undefined }).scope, 'film:new');
assert.equal(directorLookSource({ ...source, storyName: ' ', sceneTitle: '' }).title, '当前剧情');

const state = createInitialState();
const requirement = '偏水墨电影感\n镜头克制，不改人物关系';
state.project.directorLookRequirement = requirement;
const other = { ...structuredClone(state.project), id: 'other-project', name: '项目B', directorLookRequirement: '清透动漫' };
state.projects = [state.project, other]; state.activeProjectId = state.project.id;
const reloaded = normalizeState(JSON.parse(serializeStateForStorage(state).serialized));
assert.equal(reloaded.project.directorLookRequirement, requirement);
assert.equal(reloaded.projects?.find((project) => project.id === other.id)?.directorLookRequirement, '清透动漫');
const legacy = structuredClone(state);
delete legacy.project.directorLookRequirement;
legacy.projects = [legacy.project];
assert.equal(normalizeState(legacy).project.directorLookRequirement, undefined, 'old projects default to the original no-custom behavior');
for (const malformed of [true, 123, { text: 'must not become a textbox value' }, null]) {
  const invalid = JSON.parse(JSON.stringify(state)); invalid.project.directorLookRequirement = malformed; invalid.projects = [invalid.project];
  assert.equal(normalizeState(invalid).project.directorLookRequirement, undefined);
}
const cleared = structuredClone(state); cleared.project.directorLookRequirement = ''; cleared.projects = [cleared.project];
assert.equal(normalizeState(cleared).project.directorLookRequirement, '');

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const fingerprint = app.slice(app.indexOf('const directorSettingsFingerprint ='), app.indexOf('type DirectorSettingsSnapshot'));
assert.doesNotMatch(fingerprint, /directorLookRequirement/u, 'typing an unexecuted autofill request must not invalidate confirmed film settings');
const action = app.slice(app.indexOf('const analyzeDirectorLookSettings ='), app.indexOf('const toggleAsset =', app.indexOf('const analyzeDirectorLookSettings =')));
assert.match(action, /customRequirement: directorLookRequirement/u);
assert.match(action, /extraRequirement,/u, 'generic generation requirements remain independent');
assert.match(action, /request\.controller\.signal/u);
assert.match(action, /workspaceEpoch === request\.workspaceEpoch/u);
assert.match(action, /if \(!isCurrent\(\)\) return/u);
assert.match(app, /state\.project\.id, productionMode, sequenceStage, sequenceSettingsOpen, lookSource/u, 'leaving single-segment directing for whole-film planning invalidates pending look analysis');
assert.match(app, /aria-label="导演与视觉自定义要求"/u);
const requirementControl = app.match(/<textarea\s+className="director-look-requirement"[\s\S]*?\/>/u)?.[0] || '';
assert.ok(requirementControl);
assert.doesNotMatch(requirementControl, /disabled=|readOnly=/u, 'the unexecuted requirement draft stays editable while unrelated AI work is busy');
assert.match(action, /if \(busy \|\| directorLookRequestRef\.current/u, 'the analysis action itself must not apply settings during another foreground job');
assert.match(app, /disabled=\{busy \|\| directorLookAutofillBusy\}[\s\S]*?onClick=\{analyzeDirectorLookSettings\}/u, 'applying AI settings still waits for the current job to finish');
console.log('Director look requirements: scope, project persistence, empty defaults and stale-result wiring passed.');
