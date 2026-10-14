import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createQaProcessHarness, findAvailableTcpPort, waitForCondition } from './qaProcessHarness.mjs';

// Built UI only, synthetic saved prompts, empty API profiles and ephemeral
// storage. Every non-loopback request and every POST is denied. No generation
// action is clicked. Before mode records the prior delivered layout once.
const root = path.resolve(import.meta.dirname, '..');
const before = process.env.QA_HEADER_BASELINE === '1';
const topOnly = process.env.QA_HEADER_TOP_ONLY === '1';
const outputBase = path.join(root, 'output', 'playwright');
const output = path.resolve(process.env.QA_OUTPUT || path.join(outputBase, `prompt-header-${before ? 'baseline' : 'after'}-${Date.now()}`));
const relative = path.relative(outputBase, output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA output must be below output/playwright');
for (let current = output; current !== root; current = path.dirname(current)) {
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('QA output cannot traverse links');
}
fs.mkdirSync(output, { recursive: true });
const baselinePath = process.env.QA_BASELINE_REPORT;
const baseline = baselinePath ? JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8')) : undefined;
const topBaselinePath = process.env.QA_TOP_BASELINE_REPORT;
const topBaseline = topBaselinePath ? JSON.parse(fs.readFileSync(path.resolve(topBaselinePath), 'utf8')) : undefined;
const port = await findAvailableTcpPort();
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'lianhua_video_director_state_v22';
const chapterId = 'prompt-header-chapter';
const planId = 'prompt-header-plan';
const projectId = 'prompt-header-project';
const parts = Array.from({ length: 19 }, (_, index) => `师傅与徒弟沿山道继续前行，第${index + 1}段清晨的药草交接动作自然延续，左右站位和衣着保持连续。`);
const story = parts.join('\n');

// Reuse the sequence entry QA's real canonical parser/compiler fixture rather
// than inventing a result shape that can silently become stale after restore.
const fixtureScript = fs.readFileSync(path.join(root, 'scripts', 'seedanceSequenceEntryUiQa.mjs'), 'utf8');
const fixtureLiteral = fixtureScript.match(/const fixtureCode = (`[\s\S]*?`);\r?\nconst builtFixture/u)?.[1];
assert.ok(fixtureLiteral, 'sequence fixture builder exists');
let fixtureCode = new Function('origin', 'chapterId', 'planId', 'projectId', 'parts', 'story', `return ${fixtureLiteral};`)(origin, chapterId, planId, projectId, parts, story);
fixtureCode = "import {buildOfficialSeedanceInput} from './src/seedanceSource.ts';\nimport {getOfficialSeedanceSourceFingerprint} from './src/seedancePrompt.ts';\n" + fixtureCode;
fixtureCode = fixtureCode.replaceAll('totalDuration:30', 'totalDuration:285')
  .replaceAll('requestedTotalDurationSec:30', 'requestedTotalDurationSec:285')
  .replaceAll('segmentCount:2', 'segmentCount:19')
  .replace("state.settings.uiFontScalePercent=100;", "state.settings.uiFontScalePercent=100;state.settings.textApi.enabled=false;state.settings.textApiProfiles=[];state.settings.activeTextApiProfileId=null;");
const decorate = `
const details=Array.from({length:80},(_,i)=>'动作细节'+(i+1)+'：师傅与徒弟保持左右关系，药草叶片与手掌接触位置连续，晨光沿山道照亮衣料与石阶，动作始终自然推进，不增加对白。').join('\\n');
const seedZh='视频规格：时长15秒，画面比例16:9，分辨率2K。\\n\\n主体连续性：师傅与徒弟沿同一条山道前行。\\n\\n连续时间轴（覆盖0–15秒）：\\n【0s-15s】师傅递出药草，徒弟接稳药草，二人继续沿山道前行。\\n'+details+'\\n全局约束：衣着、晨光与空间关系连续。';
const seedEn='Video specification: 15 seconds, aspect ratio 16:9, resolution 2K.\\n\\nContinuous timeline: [0s-15s] The teacher hands over herbs and they continue along the same mountain path.\\n'+Array.from({length:28},(_,i)=>'Detail '+(i+1)+': The teacher remains on the left and the student on the right. Keep hand contact, herb leaves, morning light and clothing continuous.').join('\\n');
for(const board of project.storyboards){
 board.officialPromptZh=board.officialPromptZh.replace(/\\noverall_soundscape:/u,'\\n'+details+'\\noverall_soundscape:');
 board.targetOutput={...board.targetOutput,prompt:board.officialPromptZh};
 board.officialPromptEn='integrated_multimodal_description: [Shot 1] The teacher and student hand over herbs.\\n'+Array.from({length:28},(_,i)=>'Detail '+(i+1)+': Keep left and right positions, accurate herb handoff, morning light and fabric movement continuous.').join('\\n')+'\\noverall_soundscape: Wind.\\nnon_diegetic_music: N/A';
 board.officialPromptEnSource=board.officialPromptZh;
 const fingerprint=getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(project,board));
 board.seedance25Output={targetId:'seedance-2.5',promptZh:seedZh,promptEn:seedEn,durationSec:15,sourceFingerprint:fingerprint,englishSourceFingerprint:fingerprint,referenceManifest:[],warnings:[],generatedAt:now};
}
for(let index=1;index<plan.segments.length;index++){
 const next=buildSequencePromptHandoff(project,plan.id,plan.segments[index].id);
 if(next.issue||!next.context)throw new Error(next.issue||'Missing layout fixture handoff');
 project.storyboards[index]=stampSequencePromptHandoff(project.storyboards[index],next.context);
}
`;
const handoffBlock = /const handoff=buildSequencePromptHandoff\(project,plan\.id,plan\.segments\[1\]\.id\);[\s\S]*?project\.storyboards\[1\]=stampSequencePromptHandoff\(project\.storyboards\[1\],handoff\.context\);/u;
assert.match(fixtureCode, handoffBlock);
fixtureCode = fixtureCode.replace(handoffBlock, decorate);
fixtureCode = fixtureCode.replace('process.stdout.write(JSON.stringify(normalized));', `
for(const board of normalized.project.storyboards){const fingerprint=getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(normalized.project,board));board.seedance25Output={...board.seedance25Output,sourceFingerprint:fingerprint,englishSourceFingerprint:fingerprint};}
normalized.projects=[normalized.project];process.stdout.write(JSON.stringify(normalized));`);
const builtFixture = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixtureCode], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 40 * 1024 * 1024 });
if (builtFixture.status !== 0) throw new Error(`Layout fixture failed: ${builtFixture.stderr}`);
const sequenceFixture = JSON.parse(builtFixture.stdout);
const singleFixture = structuredClone(sequenceFixture);
{
  const project = singleFixture.project; const board = project.storyboards[0];
  for (const key of ['sequencePlanId', 'segmentId', 'segmentIndex', 'segmentCount', 'sequencePromptHandoff', 'globalStartSec', 'globalEndSec']) delete board[key];
  project.sequencePlans = []; project.storyboards = [board];
  project.scenes[0].storyboardIds = [board.id];
  project.chapterWorkspaces[chapterId].directorControls = { ...project.chapterWorkspaces[chapterId].directorControls, productionMode: 'single', activePlanId: '', activeSegmentId: '', activeStoryboardId: board.id };
  singleFixture.projects = [project];
}
// Removing a sequence binding changes target source identity; rebuild the
// singleton target seal with the real helper before browser normalization.
const singleSealCode = `import {normalizeState} from './src/storage.ts';import {applyOfficialH3Prompt} from './src/officialPrompt.ts';import {officialH3ContextForStoryboard} from './src/officialH3Context.ts';import {buildOfficialSeedanceInput} from './src/seedanceSource.ts';import {getOfficialSeedanceSourceFingerprint} from './src/seedancePrompt.ts';const state=${JSON.stringify(singleFixture)};const previous=state.project.storyboards[0];let board=applyOfficialH3Prompt(previous,officialH3ContextForStoryboard(state.project,previous));board.officialPromptZh=previous.officialPromptZh;board.officialPromptEn=previous.officialPromptEn;board.officialPromptEnSource=board.officialPromptZh;board.targetOutput={...board.targetOutput,prompt:board.officialPromptZh};state.project.storyboards=[board];const fingerprint=getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(state.project,board));board.seedance25Output={...previous.seedance25Output,sourceFingerprint:fingerprint,englishSourceFingerprint:fingerprint};state.projects=[state.project];process.stdout.write(JSON.stringify(normalizeState(state)));`;
const normalizedSingleCode = singleSealCode.replace('process.stdout.write(JSON.stringify(normalizeState(state)));', 'const normalized=normalizeState(state);const current=normalized.project.storyboards[0];const finalFingerprint=getOfficialSeedanceSourceFingerprint(buildOfficialSeedanceInput(normalized.project,current));current.seedance25Output={...current.seedance25Output,sourceFingerprint:finalFingerprint,englishSourceFingerprint:finalFingerprint};normalized.projects=[normalized.project];process.stdout.write(JSON.stringify(normalized));');
const sealedSingle = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module'], { cwd: root, windowsHide: true, encoding: 'utf8', input: normalizedSingleCode, timeout: 30_000, maxBuffer: 40 * 1024 * 1024 });
if (sealedSingle.status !== 0) throw new Error(`Single fixture failed: ${sealedSingle.stderr}`);
const normalizedSingleFixture = JSON.parse(sealedSingle.stdout);

const bootstrap = `import {preview} from 'vite';const server=await preview({preview:{host:'127.0.0.1',port:${port},strictPort:true,open:false}});console.log('Prompt header QA ready');`;
const preview = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const harness = createQaProcessHarness({ electron: preview, qaLabel: 'prompt header built UI QA', runTimeoutMs: 240_000, closeTimeoutMs: 10_000 });
let browser; let context; let page; let failure;
const errors = []; const blockedRequests = []; const records = []; const topRecords = []; const screenshots = []; const violations = [];
const dimensions = [{width:1996,height:1248},{width:1366,height:900},{width:1120,height:720}];
const settle = () => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); });
const capture = async name => { await page.screenshot({ path:path.join(output,`${name}.png`),fullPage:false }); screenshots.push(`${name}.png`); };
const recordTop = async (scenario, viewport, scale) => {
  const record = await page.evaluate(() => {
    const box=element=>{if(!element?.getClientRects().length)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const chapter=document.querySelector('.chapter-toolbar');const source=document.querySelector('.director-source-card');const stage=document.querySelector('.director-stage');const main=chapter.parentElement;
    const roots=[chapter,document.querySelector('.director-generation-format-card'),document.querySelector('.prompt-video-links'),source].filter(Boolean);
    const controls=roots.flatMap(root=>[...root.querySelectorAll('button,select')]).filter(element=>element.getClientRects().length).map(element=>{
      const rect=box(element);const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      return {text:element.tagName==='SELECT'?(element.selectedOptions[0]?.textContent||''):element.textContent.trim(),rect,fontSize:parseFloat(getComputedStyle(element).fontSize),clipped:element.tagName!=='SELECT'&&element.scrollWidth>element.clientWidth+2,hit:hit===element||element.contains(hit)};
    });
    return {chapter:box(chapter),source:box(source),stage:box(stage),main:box(main),height:box(stage).y-box(chapter).y,controls};
  });
  record.key=`${scenario}-${viewport.width}x${viewport.height}-font${scale}`;topRecords.push(record);
  if(!before){
    const old=topBaseline?.topRecords.find(item=>item.key===record.key);
    if(old){record.beforeHeight=old.height;record.ratio=record.height/old.height;if(record.ratio>0.65)violations.push(`${record.key}: top cards should be approximately halved (${record.height}/${old.height})`);}
    for(const control of record.controls)if(control.clipped||control.rect.right>record.main.right+1||control.rect.x<record.main.x-1||!control.hit)violations.push(`${record.key}: top control clipped or obscured: ${control.text}`);
    for(let i=0;i<record.controls.length;i++)for(let j=i+1;j<record.controls.length;j++){
      const a=record.controls[i].rect,b=record.controls[j].rect;
      if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>2)violations.push(`${record.key}: overlapping top controls: ${record.controls[i].text}/${record.controls[j].text}`);
    }
  }
  if(topOnly||scenario==='planning')await capture(`top-${record.key}`);
  return record;
};
const recordLayout = async (scenario, viewport, scale, format='h3') => {
  const record = await page.evaluate(() => {
    const box=element=>{if(!element?.getClientRects().length)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const panel=document.querySelector('.director-side-panel'); const copy=document.querySelector('.director-result-copy');
    const scroller=copy?.querySelector('.h3-prompt-display-body')||copy;
    const controls=[...panel.querySelectorAll('button, summary')].filter(element=>element.getClientRects().length&&box(element).bottom<=box(copy).y+1).map(element=>{
      const rect=box(element);const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      return {text:element.textContent.trim(),rect,fontSize:parseFloat(getComputedStyle(element).fontSize),clipped:element.scrollWidth>element.clientWidth+2,hit:hit===element||element.contains(hit)};
    });
    return {panel:box(panel),copy:box(copy),headerHeight:box(copy).y-box(panel).y,scrollHeight:scroller?.scrollHeight,clientHeight:scroller?.clientHeight,controls,outerScroll:document.documentElement.scrollHeight>innerHeight+2,panelScroll:panel.scrollHeight>panel.clientHeight+2};
  });
  record.key=`${scenario}-${viewport.width}x${viewport.height}-font${scale}-${format}`; records.push(record);
  if (!before) {
    if (record.copy.height<200) violations.push(`${record.key}: prompt body too short: ${record.copy.height}`);
    if (record.outerScroll||record.panelScroll) violations.push(`${record.key}: outer panel scroll displaced controls`);
    for (const control of record.controls) {
      if(control.clipped||control.rect.right>record.panel.right+1||control.rect.x<record.panel.x-1||!control.hit) violations.push(`${record.key}: header control clipped or obscured: ${control.text}`);
    }
    for(let i=0;i<record.controls.length;i++)for(let j=i+1;j<record.controls.length;j++){
      const a=record.controls[i].rect,b=record.controls[j].rect;
      if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>2)violations.push(`${record.key}: overlapping controls: ${record.controls[i].text}/${record.controls[j].text}`);
    }
    const old=baseline?.records.find(item=>item.key===record.key);
    if(old){record.beforeHeaderHeight=old.headerHeight;record.headerRatio=record.headerHeight/old.headerHeight;record.bodyIncrease=record.copy.height-old.copy.height;
      if(format==='h3'&&viewport.width===1996&&(record.headerRatio>0.65||record.bodyIncrease<70))violations.push(`${record.key}: header should be approximately halved and reclaimed by prompt body`);
    }
  }
  await capture(record.key);
  return record;
};
const readState=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'{}'),storageKey);
const run=async()=>{
  await waitForCondition({label:'prompt header built preview',timeoutMs:40_000,intervalMs:100,check:async()=>{try{return(await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}}});
  browser=await chromium.launch({headless:true});
  context=await browser.newContext({viewport:dimensions[0],serviceWorkers:'block'});page=await context.newPage();page.setDefaultTimeout(18_000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{const request=route.request();const url=new URL(request.url());if(!/^https?:$/u.test(url.protocol)){await route.continue();return;}if(url.origin!==origin||!['GET','HEAD'].includes(request.method())){blockedRequests.push({method:request.method(),path:url.pathname});await route.abort('blockedbyclient');return;}await route.continue();});
  await page.goto(origin,{waitUntil:'networkidle'});await page.waitForFunction(key=>Boolean(localStorage.getItem(key)),storageKey);
  await page.addInitScript(()=>{window.__headerCopied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__headerCopied.push(value);}}});});
  for(const scenario of ['single','sequence','planning'])for(const viewport of dimensions)for(const scale of [100,125]){
    await page.setViewportSize(viewport);const fixture=structuredClone(scenario==='single'?normalizedSingleFixture:sequenceFixture);fixture.settings.uiFontScalePercent=scale;
    if(scenario==='planning')fixture.project.chapterWorkspaces[chapterId].directorControls.sequenceStage='plan';
    await page.evaluate(({key,fixture})=>{localStorage.clear();sessionStorage.clear();localStorage.setItem(key,JSON.stringify(fixture));},{key:storageKey,fixture});
    await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar').getByRole('button',{name:'提示词导演台',exact:true}).click();await page.locator(scenario==='planning'?'.sequence-planner-panel':'.director-result-copy').waitFor();await settle();
    await recordTop(scenario,viewport,scale);
    if(topOnly||scenario==='planning')continue;
    const snapshot=JSON.stringify((await readState()).project.storyboards);
    await recordLayout(scenario,viewport,scale);
    if(before)continue;
    if(viewport.width===1366&&scale===100){
      const more=page.locator('.director-side-panel').getByRole('button',{name:'更多',exact:true});await more.click();
      await page.getByRole('menu').waitFor();assert.ok(await page.getByRole('menuitem',{name:'修复对白与排时',exact:true}).count(),'more preserves the repair entry');
      if(scenario==='sequence')assert.ok(await page.getByRole('menuitem',{name:'导出全部分段提示词',exact:true}).count(),'sequence export remains available');
      await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),0,'escape closes the overflow menu');
    }
    const formats=page.getByRole('group',{name:'官方提示词格式',exact:true});
    const initial=await page.locator('.director-result-copy').innerText();
    const language=page.getByRole('group',{name:'提示词语言',exact:true});await language.getByRole('button',{name:'English',exact:true}).click();await settle();
    const english=await page.locator('.director-result-copy').innerText();assert.notEqual(english,initial,'H3 language switch works');
    await page.locator('.director-side-panel').getByRole('button',{name:'复制',exact:true}).click();assert.equal((await page.evaluate(()=>window.__headerCopied)).at(-1).trim(),english.trim(),'copy contains full selected saved text');
    await language.getByRole('button',{name:'中文',exact:true}).click();assert.equal((await page.locator('.director-result-copy').innerText()).trim(),initial.trim());
    await formats.getByRole('button',{name:'Seedance 2.5',exact:true}).click();await settle();
    assert.match(await page.locator('.director-result-copy').innerText(),/视频规格/u,'saved Seedance displays without generating');
    await recordLayout(scenario,viewport,scale,'seedance');
    await page.getByRole('group',{name:'Seedance 提示词语言',exact:true}).getByRole('button',{name:'English',exact:true}).click();assert.match(await page.locator('.director-result-copy').innerText(),/Video specification/u);
    await formats.getByRole('button',{name:'普通原稿',exact:true}).click();assert.match(await page.locator('.director-result-copy').innerText(),/主体：/u);
    await formats.getByRole('button',{name:'MiniMax H3',exact:true}).click();
    await page.locator('.director-panel-tabs').getByRole('button',{name:'参考图',exact:true}).click();await settle();assert.equal(await page.locator('.director-result-copy').count(),0,'reference tab owns its panel');
    await page.locator('.director-panel-tabs').getByRole('button',{name:'提示词结果',exact:true}).click();await page.locator('.director-result-copy').waitFor();await settle();
    const independent=await page.evaluate(()=>{const panel=document.querySelector('.director-side-panel');const box=document.querySelector('.director-result-copy');const scroller=box.querySelector('.h3-prompt-display-body')||box;const y=panel.getBoundingClientRect().y;scroller.scrollTop=scroller.scrollHeight;return {scrollTop:scroller.scrollTop,panelScroll:panel.scrollTop,panelY:panel.getBoundingClientRect().y,y};});
    assert.ok(independent.scrollTop>0,'long prompt scrolls inside text body');assert.equal(independent.panelScroll,0,'header does not scroll with prompt');assert.equal(independent.panelY,independent.y);
    assert.equal(JSON.stringify((await readState()).project.storyboards),snapshot,'view/layout/copy controls do not rewrite saved prompts');
    assert.deepEqual((await readState()).project.generationTasks,[],'no media task created');
  }
  assert.deepEqual(errors,[],'no browser runtime errors');assert.deepEqual(blockedRequests,[],'no upstream or generation requests attempted');
  if(!before)assert.deepEqual(violations,[],'focused header layout checks');
  const report={before,baselinePath,topBaselinePath,records,topRecords,screenshots,errors,blockedRequests,violations};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,records:records.length,topRecords:topRecords.length,violations,measurements:records.map(({key,headerHeight,copy,headerRatio,bodyIncrease})=>({key,headerHeight,bodyHeight:copy.height,headerRatio,bodyIncrease})),topMeasurements:topRecords.map(({key,height,ratio})=>({key,height,ratio})),screenshots},null,2));
};
try{await Promise.race([run(),harness.qaFailure]);}catch(error){failure=error;fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,errors,blockedRequests,records,topRecords,violations},null,2));await capture('failure').catch(()=>{});}finally{harness.markElectronStopping();await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await harness.stopAll().catch(error=>{failure||=error;});fs.writeFileSync(path.join(output,'preview-process.log'),harness.readElectronLog());}
if(failure)throw failure;
