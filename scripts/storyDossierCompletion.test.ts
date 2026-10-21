import assert from 'node:assert/strict';
import { buildChapterEntityCatalog, splitChapterAnalysisSource } from '../src/chapterEntities';
import { requestStoryAnalysis } from '../src/services/llm';
import { assembleStoryVisualSceneParagraphs, type StoryVisualActionPlan } from '../src/storyVisualAction';
import type { Character, Location, StoryAnalysisCharacter, StoryAnalysisLocation, StoryVisualConversionSnapshot, TextApiConfig } from '../src/types';

// Offline request/response fixtures exercise the existing analysis calls. They
// do not make a claim about the quality of a live model's generated dossiers.
const config: TextApiConfig = { enabled: true, provider: 'openai_compatible', baseUrl: 'https://dossier.mock.invalid/v1',
  apiKey: 'synthetic-only', model: 'offline-dossier', temperature: 0, maxTokens: 8192, vision: false };
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
type Request = { system: string; data: Record<string, any> };
let requests: Request[] = [];
const install = (reply: (request: Request, index: number) => unknown): void => {
  requests = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { lianhuaDesktop: {
    request: async ({ body }: { body: string }) => {
      const messages = JSON.parse(body).messages as Array<{ role: string; content: string }>;
      const user = messages.find((message) => message.role === 'user')!.content;
      const request = { system: messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
        data: JSON.parse(user.split('<story_analysis_data>\n')[1].split('\n</story_analysis_data>')[0]) };
      requests.push(request);
      return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify(reply(request, requests.length - 1)),
      } }] }) };
    },
  } } });
};
const character = (id: string, name: string, appearance = ''): Character => ({
  id, name, aliases: [], gender: '女', apparentAge: '', actualAge: '', height: '', race: '', morphology: '', bodyPlan: '',
  appearance, outfit: '', signatureProps: '', personality: '', motionHabits: '', anchor: '', negativeContinuity: '', assetIds: [],
});
const eve = { ...character('eve', '夏娃'), dossier: { confirmedFields: ['outfit'] } };
const known = { ...character('wu', '吴小观', '已保存的稳定外貌。'.repeat(40)), gender: '男' };
const disabled = { ...character('dragon', '龙娘'), dossier: { useStory: false } };
const clearing: Location = { id: 'clearing', name: '森林空地', description: '', timeWeather: '', lighting: '树冠间隙透下的日光',
  palette: '', fixedProps: '', anchor: '', assetIds: [] };
const catalog = buildChapterEntityCatalog({ characters: [known, eve, disabled], locations: [clearing], props: [] });
const catalogBefore = JSON.stringify(catalog);

try {
  globalThis.fetch = async () => { throw new Error('Dossier fixtures must not contact a model provider'); };
  install(({ system, data }, index) => {
    assert.equal(index, 0, 'a short analysis still makes one request');
    const entries = data.existingEntityCatalog.characters;
    assert.equal(entries.find((entry: any) => entry.id === 'eve').details.appearance, '');
    assert.deepEqual(entries.find((entry: any) => entry.id === 'eve').lockedFields, ['outfit']);
    assert.equal(entries.find((entry: any) => entry.id === 'dragon').useStory, false);
    assert.equal(entries.find((entry: any) => entry.id === 'wu').details.appearance, known.appearance, 'full saved facts survive the old 220-character catalog summary');
    assert.equal(data.existingEntityCatalog.locations[0].details.description, '');
    assert.equal(data.existingEntityCatalog.locations[0].details.lighting, clearing.lighting);
    assert.match(system, /existingEntityId 只表示已确定身份，不表示资料已经完整/u);
    assert.match(system, /lockedFields.*确认留空/u);
    assert.match(system, /useStory=false/u);
    assert.match(system, /所有在本部分 scenes 中引用的人物、地点和道具/u);
    return { characters: [{ name: '吴小观', existingEntityId: 'wu', appearance: known.appearance }, { name: '夏娃', existingEntityId: 'eve' }],
      locations: [{ name: '森林空地', existingEntityId: 'clearing', lighting: clearing.lighting }], props: [],
      scenes: [{ title: '林中重逢', content: data.sourceStory,
        characters: [{ name: '夏娃', existingEntityId: 'eve', appearance: '银色短发，精密的金属关节', anchor: '银色短发机械少女',
          nsfwProfile: { fullBody: 'scene-only private data must remain excluded' } }, '吴小观'],
        location: { name: '森林空地', existingEntityId: 'clearing', description: '高树环绕的圆形空地，中央露出灰色岩面', palette: '深绿树冠与灰白岩面' },
        props: [{ name: '水壶', material: '不锈钢', appearance: '圆筒壶身与折叠把手' }] }] };
  });
  const short = await requestStoryAnalysis(config, '夏娃在森林空地把水壶交给吴小观。', undefined, { entityCatalog: catalog });
  assert.equal(requests.length, 1);
  assert.deepEqual(short.characters?.map((item) => typeof item === 'string' ? item : item.name), ['吴小观', '夏娃'], 'top-level dossier ordering stays stable');
  const completedEve = short.characters?.find((item) => typeof item === 'object' && item.name === '夏娃') as StoryAnalysisCharacter;
  assert.equal(completedEve.appearance, '银色短发，精密的金属关节', 'scene-supplied ordinary fields reach the dossier');
  assert.equal(completedEve.existingEntityId, 'eve');
  assert.equal(completedEve.nsfwProfile, undefined, 'scene references do not become a private-dossier path');
  assert.equal((short.locations?.[0] as StoryAnalysisLocation).description, '高树环绕的圆形空地，中央露出灰色岩面');
  assert.equal((short.locations?.[0] as StoryAnalysisLocation).lighting, clearing.lighting);
  assert.equal(typeof short.props?.[0] === 'object' && short.props[0].material, '不锈钢');

  const plan: StoryVisualActionPlan = { version: 1, summary: '夏娃与吴小观重逢，女仆在门外回应。',
    sourceParagraphs: [{ id: 'p1', text: '夏娃抱住吴小观，女仆在门外回应。' }],
    events: [{ id: 'meet', sceneId: 'ship', sourceParagraphIds: ['p1'], evidence: '夏娃抱住吴小观', actor: '夏娃', target: '吴小观',
      action: '抱住吴小观', result: '两人相拥', uncertainties: [] }],
    scenes: [{ id: 'ship', title: '战舰外重逢', time: '白天', timeRelation: '', location: '异界森林深处空地与停泊战舰外', setting: '停泊的战舰与树木',
      sourceParagraphIds: ['p1'], eventIds: ['meet'], participants: [
        { id: 'eve', name: '夏娃', existingEntityId: 'eve', presence: 'present' },
        { id: 'wu', name: '吴小观', existingEntityId: 'wu', presence: 'present' },
        { id: 'maid', name: '女仆', presence: 'offscreen' },
      ] }],
  };
  const paragraphs = assembleStoryVisualSceneParagraphs(plan, []);
  const snapshot: StoryVisualConversionSnapshot = { id: 'adopted', chapterId: 'chapter', sourceName: '重逢',
    sourceText: plan.sourceParagraphs[0].text, resultText: paragraphs.map((paragraph) => paragraph.text).join('\n\n'),
    actionPlan: plan, paragraphs, createdAt: 1 };
  install(({ system, data }, index) => {
    assert.equal(index, 0, 'structured source adds no dossier request');
    assert.deepEqual(data.visualConversion.actionPlan.scenes[0].participants.map((participant: any) => participant.name), ['夏娃', '吴小观', '女仆']);
    assert.deepEqual(data.dossierTargets, [{ sceneId: 'ship', location: plan.scenes![0].location, characters: [
      { name: '夏娃', presence: 'present', existingEntityId: 'eve' },
      { name: '吴小观', presence: 'present', existingEntityId: 'wu' },
      { name: '女仆', presence: 'offscreen' },
    ] }], 'the existing adopted cast and exact location label are directly exposed as completion targets');
    assert.match(system, /每个present\/offscreen人物以及每个location/u);
    assert.match(system, /场所标签原样放入该地点对象的aliases数组/u);
    return { characters: [
      { name: '吴小观', existingEntityId: 'wu', appearance: known.appearance },
      { name: '夏娃', existingEntityId: 'eve', appearance: '银色短发与金属关节' },
      { name: '女仆', appearance: '黑发盘起，佩白色发饰' },
    ], locations: [{ name: '战舰外空地', aliases: [plan.scenes![0].location], description: '钢铁战舰停在高树环绕的岩地上' }], props: [],
    scenes: [{ title: '战舰外重逢', content: data.sourceStory, characters: ['吴小观'], location: '战舰外空地' }] };
  });
  const structured = await requestStoryAnalysis(config, snapshot.resultText, undefined, { entityCatalog: catalog, visualConversion: snapshot });
  assert.equal(requests.length, 1);
  assert.equal(structured.characters?.length, 3);
  assert.ok(structured.characters?.every((item) => typeof item === 'object' && item.appearance));
  assert.equal(structured.locations?.length, 1, 'explicit location alias reuses its detailed record instead of adding an empty long-label location');
  assert.equal((structured.scenes[0].location as StoryAnalysisLocation).description, '钢铁战舰停在高树环绕的岩地上');
  assert.equal(structured.scenes[0].characters?.length, 3, 'the adopted present/offscreen cast keeps each supplied dossier');

  const longSource = '夏娃与吴小观沿森林空地前行。'.repeat(1300) + '\n龙娘与女仆在古塔旁等候。';
  const chunks = splitChapterAnalysisSource(longSource);
  assert.ok(chunks.length > 1);
  install(({ data }, index) => {
    assert.ok(index < chunks.length, 'only the existing source chunks may request analysis');
    assert.equal(data.sourceStory, chunks[index].content);
    const currentCatalog = data.existingEntityCatalog;
    if (index > 0) {
      assert.equal(currentCatalog.characters.find((entry: any) => entry.id === 'eve').details.appearance, '银色短发与金属关节');
      assert.equal(currentCatalog.characters.find((entry: any) => entry.id === 'eve').details.outfit, '', 'confirmed empty stays empty in later requests');
      assert.equal(currentCatalog.characters.find((entry: any) => entry.id === 'wu').details.appearance, known.appearance, 'saved populated details are not replaced by a chunk');
      assert.equal(currentCatalog.characters.find((entry: any) => entry.id === 'dragon').details.appearance, '', 'story-disabled cards are not filled in later request context');
      assert.equal(currentCatalog.characters.find((entry: any) => entry.name === '女仆').details.appearance, '黑发盘起，佩白色发饰');
      assert.equal(currentCatalog.locations.find((entry: any) => entry.name === '古塔').details.description, '青灰砖砌的方形石塔');
      assert.equal(currentCatalog.locations.find((entry: any) => entry.id === 'clearing').details.description, '高树环绕的空地');
    }
    const maidId = currentCatalog.characters.find((entry: any) => entry.name === '女仆')?.id;
    const towerId = currentCatalog.locations.find((entry: any) => entry.name === '古塔')?.id;
    return { characters: [
      { name: '夏娃', existingEntityId: 'eve', ...(index === 0 ? { appearance: '银色短发与金属关节', outfit: '模型尝试改写已确认空值' } : {}) },
      { name: '吴小观', existingEntityId: 'wu', appearance: '模型尝试重画已有外貌' },
      { name: '龙娘', existingEntityId: 'dragon', appearance: '模型尝试补写停用剧情资料' },
    ], locations: [{ name: '森林空地', existingEntityId: 'clearing', ...(index === 0 ? { description: '高树环绕的空地' } : {}) }], props: [],
    scenes: [{ title: `连续场景${index}`, content: data.sourceStory,
      characters: [{ name: '女仆', ...(maidId ? { existingEntityId: maidId } : {}), ...(index === 0 ? { appearance: '黑发盘起，佩白色发饰' } : {}) }],
      location: { name: '古塔', ...(towerId ? { existingEntityId: towerId } : {}), ...(index === 0 ? { description: '青灰砖砌的方形石塔' } : {}) } }] };
  });
  const long = await requestStoryAnalysis(config, longSource, undefined, { entityCatalog: catalog });
  assert.equal(requests.length, chunks.length, 'dossier completion does not increase analysis or repair requests');
  assert.equal((long.characters?.find((item) => typeof item === 'object' && item.name === '女仆') as StoryAnalysisCharacter).appearance, '黑发盘起，佩白色发饰');
  assert.equal((long.locations?.find((item) => typeof item === 'object' && item.name === '古塔') as StoryAnalysisLocation).description, '青灰砖砌的方形石塔');
  assert.equal(JSON.stringify(catalog), catalogBefore, 'analysis never mutates the caller’s shared catalog');
  console.log('story dossier completion: existing blanks, scene details, structured aliases and chunk continuity passed with unchanged request counts');
} finally {
  globalThis.fetch = savedFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: savedWindow });
}
