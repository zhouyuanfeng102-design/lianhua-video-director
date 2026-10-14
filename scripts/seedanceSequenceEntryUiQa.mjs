import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Built App + fresh browser storage. Only this loopback text-model double may
// accept POST; no desktop bridge, real profile, media task or upstream is used.
const root = path.resolve(import.meta.dirname, '..');
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `seedance-sequence-entry-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must remain below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const apiPath = '/mock-seedance-sequence/v1/chat/completions';
const storageKey = 'lianhua_video_director_state_v22';
const chapterId = 'seedance-sequence-chapter';
const planId = 'seedance-sequence-plan';
const projectId = 'seedance-sequence-ui-project';
const parts = ['师傅站在清晨山道上，把药草递向徒弟，药草仍在两人手指之间。', '徒弟接稳药草，师傅收回右手，二人沿同一条山道继续前行。'];
const story = parts.join('\n');

// Fixture construction uses the real semantic materializer, canonical parser,
// H3 artifact compiler, provenance sealer and startup normalization. Its sole
// purpose is to give the built UI a trustworthy public checkpoint and old H3.
const fixtureCode = `
import {createInitialState, normalizeState} from './src/storage.ts';
import {materializeSemanticSequencePlan, semanticSegmentStoryContent} from './src/semanticSequencePlan.ts';
import {buildVideoCreativeDirection} from './src/videoCreativeDirection.ts';
import {sequencePlanReviewFingerprint} from './src/sequencePlan.ts';
import {applyConvertedPromptToShots} from './src/masterTimeline.ts';
import {applyOfficialH3Prompt} from './src/officialPrompt.ts';
import {officialH3ContextForStoryboard} from './src/officialH3Context.ts';
import {buildSequencePromptHandoff, stampSequencePromptHandoff} from './src/sequencePromptHandoff.ts';
import {resolveSequenceSegmentPromptAction} from './src/appEffects.ts';
import {sourceContentHash} from './src/sourceIntegrity.ts';
const data=${JSON.stringify({ origin, chapterId, planId, projectId, parts, story })};
const state=createInitialState(); const now=Date.now();
const api={...state.settings.textApi,enabled:true,provider:'openai_compatible',baseUrl:data.origin+'/mock-seedance-sequence/v1',apiKey:'',model:'isolated-seedance-sequence',vision:false};
state.settings.textApi=api;
state.settings.textApiProfiles=[{...api,id:'sequence-text-api',name:'本地 mock',createdAt:now,updatedAt:now}];
state.settings.activeTextApiProfileId='sequence-text-api';
for(const name of ['imageApi','visionApi','videoTaskApi','runningHubVideo'])state.settings[name].enabled=false;
state.settings.uiFontScalePercent=100;
const converter=state.converterPresets.find(item=>item.id==='converter_unified_video')||state.converterPresets.find(item=>item.enabled&&item.scope==='video');
if(!converter)throw new Error('Missing public converter fixture');
const controls={productionMode:'sequence',sequenceStage:'direct',sequenceSettingsOpen:false,activePlanId:data.planId,activeSegmentId:data.planId+'_segment_1',generationPromptFormat:'h3',durationPreset:'15s',customDuration:15,planningSegmentDurationPreset:'15s',planningCustomSegmentDuration:15,durationMode:'fixed',totalDuration:30,totalDurationTouched:true,segmentationMode:'natural',directorWorkflow:'drama',directorInputMode:'text',shotMode:'exact',shotCount:1,pace:'standard',aspectRatio:'16:9',resolution:'2K',audioMode:'stereo',styleId:state.settings.defaultStylePresetId,ruleSetId:state.settings.defaultRuleSetId,converterId:converter.id,directorStyleId:'',directorCategory:'',directorStyleName:'',directorStyleSummary:'',cameraTerms:[],lightingTerms:[],visualStyle:'',extraRequirement:'',selectedAssetIds:[]};
const fp=JSON.stringify(['drama','text','exact',1,'standard','16:9','2K','stereo',controls.styleId,controls.ruleSetId,controls.converterId,'',[],[],'','',[],api.enabled,api.provider,api.baseUrl,api.model,api.temperature,api.maxTokens,api.vision,'','','']);
const direction=buildVideoCreativeDirection({cameraTerms:[],lightingTerms:[],extraRequirement:''});
const plan=materializeSemanticSequencePlan({title:'山道药草交接',story:data.story,segmentDurationSec:15,durationMode:'fixed',requestedTotalDurationSec:30,directorSettingsFingerprint:fp,creativeDirection:direction,characterContinuity:[],sourceSceneIds:['sequence-entry-scene'],shotMode:'exact',shotCount:1},{segmentCount:2,reason:'合成原文动作的两个固定十五秒阶段。',fitStatus:'balanced',segments:data.parts.map((content,index)=>({title:index===0?'递出药草':'接草前行',content,summary:content,narrativePurpose:'完成药草交接',entryState:index===0?'二人相对站立':'药草仍在两人手指之间',exitState:index===0?'师傅右手指仍触药草根部，徒弟双手正在接拢':'徒弟拿着药草，二人沿山道前行',transitionHint:'首镜前0.5秒延续双手交接，再推进本段动作。',boundaryReason:'原动作完整阶段',continuityPack:'师傅在左，徒弟在右，药草归属和山道方向不变。',semanticSource:{sourceEvidence:[{text:content}],events:[{id:'herb-handoff',description:content,phase:String(index+1)}],dialogues:[]}}))},{planId:data.planId,now});
plan.chapterId=data.chapterId;plan.generationPromptFormat='h3';
const scene={id:'sequence-entry-scene',chapterId:data.chapterId,title:'山道药草交接',content:data.story,summary:'药草交接后前行',characterIds:[],locationIds:[],propIds:[],storyboardIds:[],createdAt:now,updatedAt:now};
const project={...state.project,id:data.projectId,name:'Seedance 顺序入口隔离验收',activeChapterId:data.chapterId,sourceDocuments:[{id:data.chapterId,name:'山道药草交接',content:data.story,createdAt:now,updatedAt:now}],scenes:[scene],sequencePlans:[plan],storyboards:[],characters:[],locations:[],props:[],assets:[],generationTasks:[],storyDraft:undefined,storyReferenceWorkspace:undefined,directorSettingsConfirmedFingerprint:fp,directorSettingsConfirmedAt:now,chapterWorkspaces:{[data.chapterId]:{directorControls:controls,directorSettingsConfirmedFingerprint:fp,directorSettingsConfirmedAt:now}},createdAt:now,updatedAt:now};
project.storyboards=plan.segments.map((segment,index)=>{
 const canonical='【0s-15s】主体：@师傅与@徒弟（专注平静）[朝向：彼此双手] 正在 ['+segment.content+']（连贯药草交接）；空间：前景药草，中景师傅在左徒弟在右，背景山道石阶；光影：清晨柔和侧光；镜头：稳定中景侧拍；台词：无；音效：环境层-[风声] 动作层-[药草摩擦] 情绪层-[无配乐]';
 const id='sequence-public-board-'+(index+1);
 segment.storyboardId=id;segment.status='ready';
 const shot={id:'sequence-public-shot-'+(index+1),index:1,startSec:0,endSec:15,subject:'师傅与徒弟',action:segment.content,purpose:'连贯药草交接',camera:'稳定中景侧拍',lighting:'清晨柔和侧光',sound:'风声与药草摩擦',transition:'连续',result:segment.exitState,referenceAssetIds:[],prompt:canonical,locked:false,authoredBy:'text-api'};
 const board={id,chapterId:data.chapterId,sceneId:scene.id,sourceSceneIds:[scene.id],sourceStoryTitle:segment.title,sourceStoryContent:semanticSegmentStoryContent(segment),sequencePlanId:plan.id,segmentId:segment.id,segmentIndex:index+1,segmentCount:2,globalStartSec:index*15,globalEndSec:(index+1)*15,workflow:'drama',inputMode:'text',durationSec:15,durationPreset:'15s',shotMode:'exact',shotCount:1,pace:'standard',aspectRatio:'16:9',resolution:'2K',audioMode:'stereo',stylePresetId:controls.styleId,ruleSetId:controls.ruleSetId,converterPresetId:converter.id,globalLock:'师傅在左，徒弟在右；药草与山道方向保持连续。',globalReferenceAssetIds:[],shots:applyConvertedPromptToShots([shot],canonical,15),finalPrompt:canonical,createdAt:now,updatedAt:now,promptTrace:{mode:'text-api',convertedPromptFingerprint:sourceContentHash(canonical),shotPlanMode:'ai-complete',modelRuleSetId:controls.ruleSetId,converterPresetId:converter.id,sourceDocumentIds:[data.chapterId],referenceAssetIds:[],generatedAt:now}};
 const official=applyOfficialH3Prompt(board,officialH3ContextForStoryboard(project,board));
 official.officialPromptEn='integrated_multimodal_description: [Shot 1] OLD_H3_'+(index+1)+' The teacher and student hand over herbs.\\noverall_soundscape: Wind and herb rustle.\\nnon_diegetic_music: N/A';
 official.officialPromptEnSource=official.officialPromptZh;
 return official;
});
const handoff=buildSequencePromptHandoff(project,plan.id,plan.segments[1].id);
if(handoff.issue||!handoff.context)throw new Error(handoff.issue||'Missing fixture H3 handoff');
project.storyboards[1]=stampSequencePromptHandoff(project.storyboards[1],handoff.context);
plan.reviewConfirmedAt=now;plan.reviewConfirmedFingerprint=sequencePlanReviewFingerprint(plan);
state.project=project;state.projects=[project];state.activeProjectId=project.id;
const normalized=normalizeState(state);
for(const segment of normalized.project.sequencePlans[0].segments){const board=normalized.project.storyboards.find(item=>item.id===segment.storyboardId);const action=resolveSequenceSegmentPromptAction(segment,normalized.project.storyboards,plan.id,officialH3ContextForStoryboard(normalized.project,board));if(action.action!=='complete')throw new Error('Fixture H3 result is not current: '+action.action);}
process.stdout.write(JSON.stringify(normalized));
`;
const builtFixture = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixtureCode], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 30 * 1024 * 1024 });
if (builtFixture.status !== 0) throw new Error(`Isolated fixture construction failed: ${builtFixture.stderr}`);
const fixture = JSON.parse(builtFixture.stdout);

const bootstrap = `import {preview} from 'vite'; const server=await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true,open:false}}); console.log('Isolated built Seedance sequence QA ready');`;
const preview = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: preview, qaLabel: 'Seedance sequence entry built UI QA', runTimeoutMs: 180_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let failure; let failFirstEnglish = true;
const errors = []; const blockedRequests = []; const requests = []; const screenshots = [];
const textOf = (content) => typeof content === 'string' ? content : (content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
const tagged = (text, tag) => {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'u'));
  return match ? JSON.parse(match[1]) : undefined;
};
const chinese = (index) => [
  '视频规格：时长 15 秒；画面比例 16:9；分辨率 2K；声音模式 stereo。',
  '参考素材与职责：\n没有上传外部素材，按已确认的山道药草交接分镜呈现。',
  '主体连续性：\n师傅在左，徒弟在右，衣着、药草归属与山道方向保持连续。',
  `一句话概述：\n${parts[index - 1]}`,
  `连续时间轴（覆盖 0–15 秒）：\n【0s-15s】${index === 1 ? '稳定中景侧拍清晨山道，师傅的右手向徒弟递出药草；末端师傅指尖仍触着药草根部，徒弟双手正在接拢。' : '本段0.00–0.50秒延续前段相同交接画面：师傅右手指仍触着药草根部，徒弟双手正在接拢；从0.50秒起，徒弟接稳药草，师傅收手，二人沿山道继续前行。'}保留左右站位和自然风声。SEEDANCE_SEGMENT_${index}_FINAL`,
  '全局约束：\n保留原剧情、固定时长和已确认机位，不增加人物、对白或额外镜头。',
].join('\n\n');
const english = (index) => [
  'Video specification: duration 15 seconds; aspect ratio 16:9; resolution 2K; audio mode stereo.',
  'References and responsibilities:\nNo external materials.',
  'Subject continuity:\nThe teacher stays left and the pupil stays right; keep clothing, herbs and the path continuous.',
  `One-sentence summary:\n${index === 1 ? 'The teacher offers the herbs while both hands remain in contact.' : 'The pupil takes the herbs and they proceed along the same path.'}`,
  `Continuous timeline (covering 0–15 seconds):\n【0s-15s】${index === 1 ? 'Stable morning medium side shot: the teacher offers the herbs and her fingertips remain on the root while the pupil closes both hands.' : 'At 0.00–0.50 seconds retain the same handover pose; from 0.50 seconds the pupil grips the herbs, the teacher withdraws her hand and both walk along the path.'} Keep left/right positions and natural wind. SEEDANCE_SEGMENT_${index}_FINAL`,
  'Global constraints:\nPreserve the story, fixed duration and confirmed camera. Add no characters, dialogue or shots.',
].join('\n\n');
const preserved = (state) => state.project.storyboards.map((board) => ({
  id: board.id, shots: board.shots, finalPrompt: board.finalPrompt, promptPlan: board.promptPlan,
  officialPromptZh: board.officialPromptZh, officialPromptEn: board.officialPromptEn,
  officialPromptSource: board.officialPromptSource, officialPromptEnSource: board.officialPromptEnSource,
  targetOutput: board.targetOutput, sequencePromptHandoff: board.sequencePromptHandoff,
}));
const readState = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), storageKey);
const batchButton = () => page.locator('.director-generate-bar').getByRole('button', { name: '顺序生成未完成的Seedance', exact: true });
const capture = async (name) => { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false }); screenshots.push(`${name}.png`); };
const enterDirector = async () => {
  await page.locator('.sidebar').getByRole('button', { name: '提示词导演台', exact: true }).click();
  await page.getByRole('group', { name: '目标提示词格式', exact: true }).waitFor();
};
const run = async () => {
  await waitForCondition({ label: 'built Seedance sequence preview', timeoutMs: 40_000, intervalMs: 100, check: async () => {
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  } });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(18_000); page.setDefaultNavigationTimeout(40_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (!/^https?:$/u.test(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin || (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== apiPath)) {
      blockedRequests.push({ method: request.method(), path: url.pathname }); await route.abort('blockedbyclient'); return;
    }
    if (url.pathname !== apiPath) { await route.continue(); return; }
    try {
      const payload = request.postDataJSON();
      const system = (payload.messages || []).filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n');
      const user = (payload.messages || []).filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n');
      const seedance = tagged(user, 'seedance_source_data');
      const handoff = tagged(user, 'sequence_text_handoff_data')?.sequenceHandoff;
      let kind; let index; let response;
      if (seedance) {
        kind = 'seedance-writer'; index = seedance.sourceEvidence?.sequenceSegmentContext?.segmentIndex;
        assert.ok([1, 2].includes(index), 'writer receives its exact semantic segment');
        if (index === 2) {
          assert.equal(handoff?.previousPromptKind, 'seedance');
          assert.equal(handoff.previousFinalPrompt, chinese(1), 'second writer receives the confirmed Seedance predecessor');
          assert.ok(handoff.previousTargetSourceFingerprint);
          assert.equal(handoff.openingOverlapSec, 0.5);
          assert.equal(handoff.previousSegmentIndex, 1);
          assert.ok(!handoff.previousFinalPrompt.includes('integrated_multimodal_description'), 'H3 is not substituted for selected target');
        } else assert.equal(handoff, undefined);
        response = chinese(index);
      } else if (/Seedance/u.test(system) && /翻译|translator/iu.test(system)) {
        kind = 'seedance-english'; index = Number(/SEEDANCE_SEGMENT_(\d+)_FINAL/u.exec(user)?.[1]);
        assert.ok([1, 2].includes(index));
        if (index === 1 && failFirstEnglish) {
          failFirstEnglish = false; requests.push({ kind, segmentIndex: index, failed: true });
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"mock first Seedance English unavailable"}}' }); return;
        }
        response = english(index);
      } else throw new Error(`Unexpected planning/H3 request during checkpoint reuse: ${system.slice(0, 90)}`);
      requests.push({ kind, segmentIndex: index, ...(handoff ? { previousPromptKind: handoff.previousPromptKind, previousTargetSourceFingerprint: handoff.previousTargetSourceFingerprint } : {}) });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: response } }] }) });
    } catch (error) {
      errors.push(String(error)); await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"isolated sequence QA rejected request"}}' }).catch(() => {});
    }
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), storageKey);
  await page.evaluate(({ key, fixture }) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(fixture)); }, { key: storageKey, fixture });
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
  const oldH3 = preserved(await readState());
  assert.equal((await readState()).project.sequencePlans[0].planningMode, 'semantic-segments');
  await page.getByRole('group', { name: '目标提示词格式', exact: true }).getByRole('button', { name: 'Seedance', exact: true }).click();
  await page.waitForFunction(({ key, planId }) => JSON.parse(localStorage.getItem(key)).project.sequencePlans.find((plan) => plan.id === planId)?.generationPromptFormat === 'seedance', { key: storageKey, planId });
  assert.equal(requests.length, 0, 'selecting Seedance starts no generation');
  assert.equal(await batchButton().isEnabled(), true);
  await capture('seedance-selected-before-batch');
  await batchButton().click();
  await page.waitForFunction((key) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}'); const boards = state.project?.storyboards || [];
    return boards[0]?.seedance25Output?.englishError && boards[0].seedance25Output.promptZh
      && boards[1]?.seedance25Output?.promptEn && boards[1].seedance25Output.sequencePromptHandoff?.resultFingerprint;
  }, storageKey, { timeout: 50_000 });
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).waitFor({ state: 'hidden' });
  const firstRun = await readState();
  assert.deepEqual(requests.map((request) => [request.kind, request.segmentIndex]), [['seedance-writer', 1], ['seedance-english', 1], ['seedance-writer', 2], ['seedance-english', 2]]);
  assert.deepEqual(preserved(firstRun), oldH3, 'Seedance first batch retains all public/H3 results and H3 provenance');
  assert.equal(firstRun.project.storyboards[0].seedance25Output.promptZh, chinese(1));
  assert.equal(firstRun.project.storyboards[1].seedance25Output.sequencePromptHandoff.promptFormat, 'seedance');
  const chineseCheckpoints = firstRun.project.storyboards.map((board) => board.seedance25Output.promptZh);
  const secondStamp = firstRun.project.storyboards[1].seedance25Output.sequencePromptHandoff;
  await capture('two-chinese-saved-first-english-pending');
  await batchButton().click();
  await page.waitForFunction((key) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}');
    return state.project?.storyboards.every((board) => board.seedance25Output?.promptEn && !board.seedance25Output.englishError
      && board.seedance25Output.englishSourceFingerprint === board.seedance25Output.sourceFingerprint);
  }, storageKey, { timeout: 50_000 });
  await page.getByRole('button', { name: '取消顺序生成', exact: true }).waitFor({ state: 'hidden' });
  const final = await readState();
  assert.deepEqual(requests.slice(4).map((request) => [request.kind, request.segmentIndex]), [['seedance-english', 1]], 'continuing batch after English failure only translates that saved Chinese');
  assert.deepEqual(final.project.storyboards.map((board) => board.seedance25Output.promptZh), chineseCheckpoints);
  assert.deepEqual(final.project.storyboards[1].seedance25Output.sequencePromptHandoff, secondStamp);
  assert.deepEqual(preserved(final), oldH3, 'English-only retry leaves canonical and old H3 drafts intact');
  assert.deepEqual(final.project.generationTasks, []); assert.deepEqual(final.project.assets, []);
  await capture('sequence-seedance-complete');
  await page.reload({ waitUntil: 'networkidle' }); await enterDirector();
  const reloaded = await readState();
  assert.equal(reloaded.project.sequencePlans[0].generationPromptFormat, 'seedance');
  assert.deepEqual(reloaded.project.storyboards[1].seedance25Output.sequencePromptHandoff, secondStamp, 'reload preserves Seedance-specific continuity');
  assert.deepEqual(preserved(reloaded), oldH3, 'reload keeps independent H3 output');
  assert.equal(requests.length, 5, 'restoring target and saved outputs does not generate anything');
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, []);
  const report = { passed: true, builtApp: true, isolatedBrowserStorage: true, mockedTextApiOnly: true,
    semanticSegments: 2, independentH3AndSeedance: true, exactSeedancePredecessor: true, englishOnlyBatchRetry: true,
    requests, screenshots, errors, blockedRequests };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Seedance sequence entry built UI QA passed: ${path.join(output, 'report.json')}`);
};
try { await Promise.race([run(), harness.qaFailure]); }
catch (error) { failure = error; if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack, requests, errors, blockedRequests }, null, 2)); }
finally { harness.markElectronStopping(); await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await harness.stopAll().catch((error) => { failure ||= error; }); fs.writeFileSync(path.join(output, 'preview-process.log'), harness.readElectronLog()); }
if (failure) throw failure;
