import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as entities from '../src/chapterEntities';
import * as effects from '../src/appEffects';
import * as chapters from '../src/chapters';
import { createInitialState } from '../src/storage';
import { sourceContentHash } from '../src/sourceIntegrity';
import { requestStoryAnalysis } from '../src/services/llm';
import { buildImagePromptIdentityContext } from '../src/imagePromptIdentityContext';
import type { AppState, Character, Scene, Storyboard, TextApiConfig } from '../src/types';

const character = (id = 'lin', name = '林舟'): Character => ({ id, name, aliases: id === 'lin' ? ['林师兄'] : [], gender: '男', apparentAge: '成年', race: '人类',
  appearance: '手工设定的黑发', outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '黑发长衣', negativeContinuity: '', assetIds: ['portrait'],
  dossier: { confirmedFields: ['outfit'], fieldSources: { appearance: 'manual' } }, sourceChapterIds: ['chapter-a'],
});
const shared = { characters: [character(), character('unseen', '未出场角色')], locations: [], props: [] };
const catalog = entities.buildChapterEntityCatalog(shared);
assert.equal(entities.matchChapterEntity({ name: '林师兄' }, catalog.characters, 'character').match?.id, 'lin');
assert.equal(entities.matchChapterEntity({ name: '林舟二' }, catalog.characters, 'character').match, undefined, 'similar names are never fuzzy-merged');
const ambiguous = entities.matchChapterEntity({ name: '林师兄' }, [...catalog.characters, { id: 'other', name: '别的人', aliases: ['林师兄'] }], 'character');
assert.deepEqual(ambiguous.conflict?.candidateIds, ['lin', 'other']);
const ordinary = character();
const incoming: Character & { existingEntityId: string } = { ...character('fresh'), existingEntityId: 'lin',
  appearance: 'AI重新设计外貌', outfit: 'AI新服装', personality: '温和', assetIds: [], aliases: ['阿林'] };
const merged = entities.reconcileChapterEntities([ordinary, character('absent', '另一个人')], [incoming], { kind: 'character', chapterId: 'chapter-b' });
assert.equal(merged.records.length, 2);
assert.deepEqual(merged.removedIds, []);
assert.equal(merged.records[0].id, 'lin');
assert.equal(merged.records[0].appearance, ordinary.appearance);
assert.equal(merged.records[0].outfit, '', 'confirmed blank remains blank');
assert.equal(merged.records[0].personality, '温和', 'unlocked blank may be enriched');
assert.deepEqual(merged.records[0].assetIds, ['portrait']);
assert.deepEqual(merged.records[0].sourceChapterIds, ['chapter-a', 'chapter-b']);
assert.ok(merged.records[0].aliases?.includes('阿林'));
const privateDossier = { ...ordinary, gender: '', dossier: { useStory: false } };
const incomingPrivate = { ...ordinary, existingEntityId: ordinary.id };
assert.equal(entities.reconcileChapterEntities<Character>([privateDossier], [incomingPrivate], { kind: 'character', chapterId: 'chapter-b' }).records[0].gender, '');
const form = { ...character('wolf', '林舟·兽化形态'), baseName: '林舟', formLabel: '兽化形态', baseCharacterId: 'lin' };
assert.equal(entities.reconcileChapterEntities([ordinary], [form], { kind: 'character', chapterId: 'chapter-b' }).records.length, 2);
assert.ok(entities.matchChapterEntity({ ...form, existingEntityId: 'lin' }, catalog.characters, 'character').conflict, 'a new form cannot overwrite its base via a bad ID');
const resolved = entities.resolveChapterAnalysisEntities({ characters: [{ name: '阿林', existingEntityId: 'lin' }], scenes: [{ content: '阿林进门。', characters: ['阿林'] }] }, shared);
assert.equal(resolved.analysis.characters?.[0] && (resolved.analysis.characters[0] as { name: string }).name, '林舟');
assert.equal((resolved.analysis.scenes[0].characters?.[0] as { name: string }).name, '林舟');

const longSource = ('林舟走进院子。\r\n' + '山路。'.repeat(640) + '🌲\n').repeat(17);
const chunks = entities.splitChapterAnalysisSource(longSource);
assert.equal(chunks.map((chunk) => chunk.content).join(''), longSource, 'long chapters are never truncated, trimmed or rewritten');
chunks.forEach((chunk, index) => { assert.equal(chunk.sourceStart, index ? chunks[index - 1].sourceEnd : 0); assert.equal(longSource.slice(chunk.sourceStart, chunk.sourceEnd), chunk.content); });

const originalWindow = globalThis.window;
let calls = 0;
let seenSource = '';
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: { request: async ({ body }: { body: string }) => {
  calls += 1;
  const payload = JSON.parse(body);
  const user = payload.messages[payload.messages.length - 1].content as string;
  const data = JSON.parse(user.match(/<story_analysis_data>\n([\s\S]*)\n<\/story_analysis_data>/)![1]);
  seenSource += data.sourceStory;
  assert.ok(data.existingEntityCatalog.characters.some((item: { id: string }) => item.id === 'lin'));
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ characters: [{ name: '林师兄', existingEntityId: 'lin', aliases: ['林师兄'], appearance: '黑发' }],
    locations: [{ name: '老宅', aliases: ['旧院'], existingEntityId: 'home' }], props: [], scenes: [{ title: `片段${calls}`, content: data.sourceStory, characters: ['林师兄'], location: '老宅' }] }) } }] }) };
} } } });
try {
  const config = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://chapter-fixture.invalid/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096 } as TextApiConfig;
  const response = await requestStoryAnalysis(config, longSource, undefined, { entityCatalog: { ...catalog, locations: [{ id: 'home', name: '老宅', aliases: ['旧院'] }] }, chapterId: 'chapter-a' });
  assert.equal(calls, chunks.length, 'one analysis per lossless part, no repeated full-chapter call');
  assert.equal(seenSource, longSource);
  assert.equal(response.characters?.length, 1);
  assert.equal((response.characters?.[0] as { existingEntityId: string }).existingEntityId, 'lin');
  assert.equal((response.locations?.[0] as { existingEntityId: string }).existingEntityId, 'home');
  assert.equal(response.scenes.at(-1)?.sourceEnd, longSource.trimEnd().length, 'scene offsets locate the exact returned excerpt, excluding normalized trailing whitespace');
} finally { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); }

// Exercise the production App handler's writeback after the selected chapter
// changes. This fixture has no persistence bridge or real network.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration: ts.VariableDeclaration | undefined;
const visit = (node: ts.Node): void => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleAnalyzeStory') declaration = node; ts.forEachChild(node, visit); };
visit(ast); assert.ok(declaration);
const compiled = ts.transpileModule(`const ${declaration!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const fixture = () => {
  let state = createInitialState();
  const content = '林师兄在院子里检查药草。';
  const source = (id: string, name: string, value: string) => ({ id, name, content: value, createdAt: 1, updatedAt: 1 });
  const otherScene: Scene = { id: 'b-scene', chapterId: 'chapter-b', title: '另一章', content: '另一章原文', summary: '', characterIds: [], propIds: [], storyboardIds: [], createdAt: 1, updatedAt: 1 };
  state.project = { ...state.project, id: 'chapter-test-project', activeChapterId: 'chapter-a', sourceDocuments: [source('chapter-a', '第一章', content), source('chapter-b', '第二章', '另一章原文')],
    characters: [character()], locations: [], props: [], scenes: [otherScene], storyboards: [{ id: 'b-board', chapterId: 'chapter-b', sceneId: otherScene.id, finalPrompt: '另一章提示词' } as Storyboard], sequencePlans: [], chapterWorkspaces: {} };
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible', baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture' };
  state.projects = [state.project]; state.activeProjectId = state.project.id;
  const stateRef = { current: state };
  const storyDraftRef = { current: { storyName: '第一章', storyInput: content } };
  const notices: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const noop = () => {};
  const dependencies = { ...effects, ...entities, ...chapters, sourceContentHash, busy: false, storyInput: content, storyName: '第一章',
    stateRef, workspaceEpochRef: { current: 1 }, storyAnalysisOperationRef: { current: 0 }, storyAnalysisAbortRef: { current: null },
    storyAnalysisIdentityRef: { current: '' }, storyAnalysisRequestIdentityRef: { current: '' }, storyExpansionAbortRef: { current: null },
    storyDraftRef, storyDraftOwnerRef: { current: state.project.id }, storyImportOperationRef: { current: 0 },
    storyAnalysisChapterRef: { current: null }, backgroundTextOwnerRef: { current: null },
    setBusy: noop, setView: noop, setActiveSceneId: noop, setSelectedDirectorSceneIds: noop,
    setStoryInputInternal: noop, setStoryNameInternal: noop, notify: (message: string) => notices.push(message),
    reportRuntimeError: (_kind: string, error: unknown) => { throw error; }, isAbortError: () => false,
    createId: (() => { let next = 0; return (kind: string) => `${kind}-${++next}`; })(),
    setState: (update: (current: AppState) => AppState) => { state = update(stateRef.current); stateRef.current = state; },
    requestStoryAnalysis: async () => { await gate; return { characters: [{ ...character(), name: '林师兄', existingEntityId: 'lin' }], locations: [], props: [],
      scenes: [{ title: '检查药草', content, characters: ['林师兄'] }] }; },
    requestStoryBibleEnrichment: async () => { assert.fail('complete shared dossiers must not be redesigned'); },
  };
  const run = new Function('d', `with(d){${compiled};return handleAnalyzeStory;}`)(dependencies) as () => Promise<void>;
  return { stateRef, storyDraftRef, notices, release, run };
};
const scenario = fixture();
const pending = scenario.run();
const otherBoard = structuredClone(scenario.stateRef.current.project.storyboards[0]);
scenario.stateRef.current.project = chapters.withChapterSelection(scenario.stateRef.current.project, 'chapter-b');
scenario.storyDraftRef.current = { storyName: '第二章', storyInput: '另一章原文' };
scenario.stateRef.current.project.scenes[0].summary = '用户正在修改第二章';
scenario.release(); await pending;
assert.equal(scenario.stateRef.current.project.activeChapterId, 'chapter-b');
assert.equal(scenario.stateRef.current.project.scenes.find((scene) => scene.chapterId === 'chapter-a')?.characterIds[0], 'lin');
assert.equal(scenario.stateRef.current.project.scenes.find((scene) => scene.id === 'b-scene')?.summary, '用户正在修改第二章');
assert.deepEqual(scenario.stateRef.current.project.storyboards[0], otherBoard);
assert.equal(scenario.stateRef.current.project.characters[0].appearance, '手工设定的黑发');
const stale = fixture(); const staleRequest = stale.run();
stale.storyDraftRef.current.storyInput = '用户改写了当前章节'; stale.release(); await staleRequest;
assert.equal(stale.stateRef.current.project.scenes.length, 1, 'late analysis never overwrites changed source');
const imageProject = fixture().stateRef.current.project;
imageProject.characters[0].sourceChapterIds = ['chapter-a'];
imageProject.sourceDocuments[0].content = '林舟出自山林故事。CHAPTER_A_ONLY';
imageProject.sourceDocuments[1].content = 'OTHER_CHAPTER_MUST_NOT_LEAK';
imageProject.activeChapterId = 'chapter-b';
assert.equal(chapters.chapterContentForEntity(imageProject, 'character', 'lin'), imageProject.sourceDocuments[0].content);
const imageContext = buildImagePromptIdentityContext(imageProject, ['林舟']);
assert.match(imageContext, /CHAPTER_A_ONLY/);
assert.doesNotMatch(imageContext, /OTHER_CHAPTER_MUST_NOT_LEAK/);
imageProject.characters[0].dossier = { useStory: false };
assert.equal(buildImagePromptIdentityContext(imageProject, ['林舟']), '', 'story-disabled dossiers do not receive story identity context');
console.log('chapter entities: shared IDs, manual blanks, variants, exact chunking, mock transport and owner-chapter App writeback passed');
