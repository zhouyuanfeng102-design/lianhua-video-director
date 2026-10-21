import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as effects from '../src/appEffects';
import * as entities from '../src/chapterEntities';
import * as chapters from '../src/chapters';
import * as references from '../src/storyReferences';
import { createInitialState } from '../src/storage';
import { sourceContentHash } from '../src/sourceIntegrity';
import type { AppState, Character, Location } from '../src/types';

// Execute the actual handler with isolated state and an offline response.
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration: ts.VariableDeclaration | undefined;
const visit = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleAnalyzeStory') declaration = node;
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(declaration);
const compiled = ts.transpileModule(`const ${declaration.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

for (const mode of ['short', 'long', 'structured']) {
  const structured = mode === 'structured';
  let state = createInitialState();
  const content = mode === 'long' ? '夏娃和吴小观来到庭院。\n'.repeat(1800) : '夏娃和吴小观来到庭院，女仆在门边候着。';
  const chapterId = 'dossier-chapter';
  const makeCharacter = (id: string, name: string): Character => ({
    id, name, gender: '', apparentAge: '', race: '', appearance: '', outfit: '', signatureProps: '',
    personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [`${id}-portrait`],
  });
  const eve = { ...makeCharacter('eve', '夏娃'), dossier: { confirmedFields: ['outfit'] } };
  const wu = { ...makeCharacter('wu', '吴小观'), appearance: '用户保留的黑色短发', dossier: { fieldSources: { appearance: 'manual' as const } } };
  const dragon = { ...makeCharacter('dragon', '龙娘'), dossier: { useStory: false } };
  const courtyard: Location = { id: 'yard', name: '庭院', description: '', timeWeather: '', lighting: '',
    palette: '用户指定的暖灰色', fixedProps: '', anchor: '', assetIds: ['yard-reference'] };
  state.project = { ...state.project, id: 'dossier-project', activeChapterId: chapterId,
    sourceDocuments: [{ id: chapterId, name: '第一章', content, createdAt: 1, updatedAt: 1 }],
    characters: [eve, wu, dragon], locations: [courtyard], props: [], scenes: [], storyboards: [], sequencePlans: [],
  };
  state.projects = [state.project];
  state.activeProjectId = state.project.id;
  state.settings.textApi = { ...state.settings.textApi, enabled: true, provider: 'openai_compatible',
    baseUrl: 'https://dossier-writeback.invalid', apiKey: 'offline', model: 'offline' };
  const previous = structuredClone(state.project);
  const stateRef = { current: state };
  const notices: string[] = [];
  let calls = 0;
  const noop = () => {};
  const dependencies = {
    ...effects, ...entities, ...chapters, ...references, sourceContentHash,
    comicGenerationRef: { current: null }, busy: false, storyInput: content, storyName: '第一章', stateRef,
    workspaceEpochRef: { current: 1 }, storyAnalysisOperationRef: { current: 0 }, storyAnalysisAbortRef: { current: null },
    storyAnalysisIdentityRef: { current: '' }, storyAnalysisRequestIdentityRef: { current: '' }, storyExpansionAbortRef: { current: null },
    storyDraftRef: { current: { storyName: '第一章', storyInput: content } }, storyDraftOwnerRef: { current: state.project.id },
    storyImportOperationRef: { current: 0 }, setBusy: noop, setView: noop, setActiveSceneId: noop,
    setSelectedDirectorSceneIds: noop, setStoryInputInternal: noop, setStoryNameInternal: noop,
    matchingStoryVisualConversion: () => structured ? { actionPlan: { scenes: [{ id: 'authored-scene' }] } } : undefined,
    notify: (message: string) => notices.push(message), isAbortError: () => false,
    reportRuntimeError: (_kind: string, error: unknown) => { throw error; },
    createId: (() => { let next = 0; return (kind: string) => `${kind}-${++next}`; })(),
    setState: (update: (current: AppState) => AppState) => { state = update(stateRef.current); stateRef.current = state; },
    requestStoryAnalysis: async (_config: unknown, source: string, _signal: unknown, options: { entityCatalog: entities.ChapterEntityCatalog }) => {
      calls += 1;
      assert.equal(source, content);
      assert.equal(options.entityCatalog.characters.find((item) => item.id === 'eve')?.details?.appearance, '');
      assert.deepEqual(options.entityCatalog.characters.find((item) => item.id === 'eve')?.lockedFields, ['outfit']);
      assert.equal(options.entityCatalog.locations[0].details?.palette, courtyard.palette);
      return { characters: [{ name: '夏娃', existingEntityId: 'eve' }, { name: '吴小观', existingEntityId: 'wu', appearance: '顶层返回的新设计' },
        { name: '龙娘', existingEntityId: 'dragon' }, { name: '女仆' }], locations: [{ name: '庭院', existingEntityId: 'yard' }], props: [],
      scenes: [{ title: '庭院', content, characters: [
        { name: '夏娃', existingEntityId: 'eve', appearance: '浅色短发与清晰的机械关节', race: '机械生命', outfit: 'AI服装',
          nsfwProfile: { fullBody: '场景对象不得写入独立私密资料' } },
        { name: '吴小观', existingEntityId: 'wu', appearance: '场景临时外观', personality: '沉静' },
        { name: '龙娘', existingEntityId: 'dragon', appearance: '不可写入的剧情补充' },
        { name: '女仆', appearance: '黑发挽髻，穿深色长裙', gender: '女', race: '人类', anchor: '黑发长裙' },
      ], location: { name: '庭院', existingEntityId: 'yard', description: '青石地面与木制回廊', lighting: '廊下柔和侧光', palette: 'AI冷色' },
      props: [{ name: '托盘', material: '木质', appearance: '长方形深棕托盘' }] }] };
    },
    requestStoryBibleEnrichment: async () => assert.fail('this fix must not introduce supplemental requests'),
  };
  const run = new Function('d', `with(d){${compiled};return handleAnalyzeStory;}`)(dependencies) as () => Promise<void>;
  await run();
  assert.equal(calls, 1);
  const result = stateRef.current.project;
  assert.equal(result.characters.find((item) => item.id === 'eve')?.appearance, '浅色短发与清晰的机械关节');
  assert.equal(result.characters.find((item) => item.id === 'eve')?.outfit, '', 'confirmed empty fields stay empty');
  assert.equal(result.characters.find((item) => item.id === 'eve')?.nsfwProfile, undefined);
  assert.deepEqual(result.characters.find((item) => item.id === 'eve')?.assetIds, ['eve-portrait']);
  assert.equal(result.characters.find((item) => item.id === 'wu')?.appearance, wu.appearance);
  assert.equal(result.characters.find((item) => item.id === 'wu')?.personality, '沉静');
  assert.equal(result.characters.find((item) => item.id === 'dragon')?.appearance, '', 'disabled story completion remains disabled');
  assert.equal(result.characters.find((item) => item.name === '女仆')?.appearance, '黑发挽髻，穿深色长裙');
  assert.equal(result.locations[0].description, '青石地面与木制回廊');
  assert.equal(result.locations[0].lighting, '廊下柔和侧光');
  assert.equal(result.locations[0].palette, courtyard.palette);
  assert.deepEqual(result.locations[0].assetIds, ['yard-reference']);
  assert.equal(result.props[0].appearance, '长方形深棕托盘');
  assert.equal(result.scenes[0].locationId, 'yard');
  assert.ok(result.scenes[0].characterIds.includes('eve'));
  assert.equal(result.sourceDocuments[0].content, content);
  assert.equal(previous.characters[0].appearance, '', 'previous snapshots remain unchanged');
  assert.ok(notices.some((notice) => notice.includes('共用资料已复用')));
}
console.log('PASS dossier App writeback: short, long and structured chapters, scene details, stable IDs/assets, protected fields, no extra requests');
