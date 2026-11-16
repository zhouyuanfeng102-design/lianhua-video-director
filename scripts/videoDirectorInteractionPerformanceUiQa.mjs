import ts from 'typescript';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {installSeedanceCharacterBindingFixture} from '../scripts/videoSeedanceCharacterBindingUiQa.mjs';
const root=path.resolve(import.meta.dirname,'..');
const output=path.join(root,'output','diagnostics','director-performance-4.6.9');
await fs.mkdir(output,{recursive:true});
const targets=new Map([
 ['src/videoBatch.ts',['buildVideoBatchRows','videoBatchReferenceFingerprint','videoBatchRequestFingerprint','findVideoBatchDuplicate']],
 ['src/videoH3ReferenceBinding.ts',['prepareVideoH3ReferenceDraft']],
 ['src/videoAudioReferences.ts',['videoAudioSpeakingCharacterIds']],
 ['src/components/VideoAudioReferences.tsx',['VideoAudioReferenceEditor']],
 ['src/components/VideoMotionReferences.tsx',['VideoMotionReferenceEditor']],
]);
const instrumentation = { name: 'diagnostic-only-counters', enforce: 'pre', transform(source, id) {
 const clean = id.replaceAll(String.fromCharCode(92), '/').split('?')[0];
 const names = [...targets].find(([suffix]) => clean.endsWith('/'+suffix))?.[1];
 if (!names) return;
 const parsed = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, clean.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
 const edits = [];
 const inject = (name, body) => {
  let counter = 'globalThis.__videoPerformanceCounters ||= {}; globalThis.__videoPerformanceCounters.'+name+'=(globalThis.__videoPerformanceCounters.'+name+'||0)+1;';
  if (name === 'prepareVideoH3ReferenceDraft') counter += 'globalThis.__videoPreparedSegments ||= {}; globalThis.__videoPreparedSegments[draft.source?.segmentId || '+JSON.stringify('manual')+']=(globalThis.__videoPreparedSegments[draft.source?.segmentId || '+JSON.stringify('manual')+']||0)+1;';
  if (ts.isBlock(body)) edits.push({ start: body.getStart(parsed)+1, end: body.getStart(parsed)+1, text: counter });
  else edits.push({ start: body.getStart(parsed), end: body.end, text: '{'+counter+'return ('+source.slice(body.getStart(parsed),body.end)+');}' });
 };
 const visit = node => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text) && node.initializer && ts.isArrowFunction(node.initializer)) inject(node.name.text,node.initializer.body);
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && names.includes(node.name.text) && node.body) inject(node.name.text,node.body);
  ts.forEachChild(node,visit);
 };
 visit(parsed);
 for (const edit of edits.sort((left,right) => right.start-left.start)) source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
 return source;
} };
const server=await createServer({root,plugins:[instrumentation],server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
let browser;
try {
 await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.setDefaultTimeout(60000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 console.log('Server and browser ready');const fixture=await installSeedanceCharacterBindingFixture(page,origin);console.log('Fixture loaded');
 await page.evaluate(async()=>{
  const qa=window.__seedanceCharacterBindingQa;const React=(await import('/node_modules/.vite/deps/react.js')).default;
  const {VideoDirectorView}=await import('/src/components/VideoDirectorView.tsx');
  const {withChapterWorkspace,chapterWorkspace}=await import('/src/chapters.ts');
  const {applyAiAuthoredOfficialH3Prompt}=await import('/src/officialPrompt.ts');
  const {officialH3ContextForStoryboard}=await import('/src/officialH3Context.ts');
  const {createRunningHubTutorialVideoWorkflow,defaultRunningHubVideoConfig}=await import('/src/runningHubVideo.ts');
  const project=structuredClone(qa.project);project.id='isolated-h3-perf';
  const chapterId='perf-chapter';project.activeChapterId=chapterId;project.sourceDocuments=[{id:chapterId,name:'合成章节',content:'众人在庭院中准备出发。',createdAt:1,updatedAt:1}];
  project.characters.push(...project.characters.map((c,i)=>({...c,id:'other-char-'+i,name:['周远','贺晨','梁安','程嘉'][i],assetIds:[]})));
  const imageTemplate=project.assets[0];while(project.assets.length<320){const i=project.assets.length;project.assets.push({...imageTemplate,id:'unused-image-'+i,name:'隔离图片'+i,sourceEntityId:undefined,sourceEntityKind:undefined});}
  const plan=project.sequencePlans[0], segment=plan.segments[0],board=project.storyboards[0];plan.chapterId=chapterId;plan.segments=Array.from({length:34},(_,i)=>({...segment,id:'perf-segment-'+(i+1),index:i+1,storyboardId:'perf-board-'+(i+1),title:'庭院同行'+(i+1)}));
  const makePrompt=en=>['Subject: '+project.characters.map(c=>c.name+'为三十岁人物，穿普通外套。').join(''),'Scene: 庭院，自然光，稳定中景。','Performance: '+(en?'The group walks through the courtyard. The camera follows with small amplitude at slow speed. ':'众人缓慢走过庭院，镜头小幅度慢速跟随，身份衣着和动作保持连续。').repeat(30)+'陈宁说：“我们现在出发。”'].join(String.fromCharCode(10));
  project.storyboards=plan.segments.map((s,i)=>{let b={...structuredClone(board),id:s.storyboardId,chapterId,sequencePlanId:plan.id,segmentId:s.id,segmentIndex:s.index,segmentCount:34,seedance25Output:undefined,finalPrompt:makePrompt(false),targetModelId:'minimax-h3'};b=applyAiAuthoredOfficialH3Prompt(b,makePrompt(false),officialH3ContextForStoryboard(project,b),1);b.officialPromptEn=makePrompt(true);b.officialPromptEnSource=b.officialPromptZh;return b;});
  const workflow=createRunningHubTutorialVideoWorkflow();workflow.id='local-h3-workflow';workflow.name='隔离H3云端工作流';
  const settings={...qa.settings,videoBackend:'api',videoSource:'runninghub',runningHubVideo:{...defaultRunningHubVideoConfig,enabled:true,apiKey:'',baseUrl:location.origin,workflows:[workflow],activeWorkflowId:workflow.id}};
  const draft={name:'',backend:'api',runningHubWorkflowId:workflow.id,prompt:'',references:[],parameters:{}};
  const batch={planId:plan.id,backend:'api',workflowId:'',runningHubWorkflowId:workflow.id,apiProfileId:'',parameterText:'{}',parameterDrafts:[],selectedKeys:[],languages:{},promptFormat:'h3',promptFormats:{},referenceOverrides:{},referenceRoleOverrides:{},automaticTails:{},tailCharacterModes:{},previewSegmentId:'perf-segment-1',previewPane:'prompt',settingsCollapsed:false,query:''};
  project.chapterWorkspaces={[chapterId]:{videoDirector:{draft,parameterText:'{}',parameterDrafts:[],generationMode:'batch',batch}}};
  const metric=window.__directorMetric={persisted:0,commits:[],longTasks:[],feedback:true};
  new PerformanceObserver(list=>list.getEntries().forEach(e=>metric.longTasks.push({at:e.startTime,ms:e.duration}))).observe({type:'longtask',buffered:true});
  function Harness(){const [current,setProject]=React.useState(project);window.__diagProject=current;window.__diagSettings=settings;return React.createElement(VideoDirectorView,{project:current,settings,controller:qa.controller,onChapterDraftChange:(_,id,next)=>{metric.persisted++;if(metric.feedback)setProject(old=>JSON.stringify(chapterWorkspace(old,id).videoDirector)===JSON.stringify(next)?old:withChapterWorkspace(old,{videoDirector:next},id));}});}
  window.__videoPerformanceCounters={};qa.root.render(React.createElement(React.Profiler,{id:'director',onRender:(_,phase,actualDuration,baseDuration)=>metric.commits.push({phase,actualDuration,baseDuration})},React.createElement(Harness)));
 });
 await page.locator('[data-segment-id=perf-segment-34]').waitFor();await page.waitForTimeout(300);
 const mount=await page.evaluate(()=>({rows:document.querySelectorAll('.vd-batch-row').length,languageButtons:document.querySelectorAll('.vd-batch-language button:not(:disabled)').length,audioEditors:document.querySelectorAll('.video-audio-reference-editor').length,dom:document.querySelectorAll('*').length,counters:window.__videoPerformanceCounters,commits:window.__directorMetric.commits,promptChars:window.__diagProject.storyboards.reduce((s,b)=>s+b.officialPromptZh.length+b.officialPromptEn.length,0)}));
 if(mount.rows!==34 || mount.languageButtons!==0 || mount.audioEditors!==0)throw Error('Expected bilingual H3 candidates: '+JSON.stringify(mount));
 const first=page.locator('[data-segment-id=perf-segment-1]');
 async function measure(label,locator,mode='click'){
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(()=>{const m=window.__directorMetric;m.persisted=0;m.commits=[];m.longTasks=[];window.__videoPerformanceCounters={};window.__videoPreparedSegments={};});
  await locator.evaluate((node,mode)=>{const m=window.__directorMetric;m.at=performance.now();if(mode==='toggle')node.open=!node.open;else node.click();requestAnimationFrame(()=>requestAnimationFrame(()=>m.paint=performance.now()));},mode);
  await page.waitForTimeout(400);
  const value=await page.evaluate(()=>{const m=window.__directorMetric;return{counters:window.__videoPerformanceCounters,preparedSegments:window.__videoPreparedSegments,persisted:m.persisted,commits:m.commits,twoRafMs:m.paint-m.at,longTasks:m.longTasks.filter(e=>e.at>=m.at).map(e=>({at:e.at-m.at,ms:e.ms})),dom:document.querySelectorAll('*').length};});
  await fs.writeFile(path.join(output,label+'.json'),JSON.stringify(value,null,2));console.log(label,JSON.stringify(value));return{label,...value};
 }
 const measurements=[];
 measurements.push(await measure('native-row-settings-open',first.locator('.vd-batch-row-settings'),'toggle'));
 measurements.push(await measure('language-en-project-feedback',first.getByRole('button',{name:'英文',exact:true})));
 measurements.push(await measure('row-selection-project-feedback',first.getByRole('checkbox')));
 measurements.push(await measure('image-picker-open',first.getByRole('button',{name:'第 1 段选择参考图',exact:true})));
 await page.screenshot({path:path.join(output,'picker.png')});
 const dialog=page.getByRole('dialog');
 const grid=dialog.locator('.vd-windowed-image-grid');
 if(await grid.getAttribute('data-image-total')!=='320')throw Error('Image result count was truncated');
 if(await grid.locator('.vd-image-choice').count()>=320)throw Error('All image cards were mounted');
 const imageScroll=dialog.locator('.vd-batch-dialog-body').first();
 await imageScroll.evaluate(root=>root.scrollTop=root.scrollHeight);
 await dialog.getByRole('button',{name:'选择图片 隔离图片319',exact:true}).waitFor();
 await dialog.getByRole('searchbox',{name:'批量参考图搜索',exact:true}).fill('隔离图片219');
 await dialog.getByRole('button',{name:'选择图片 隔离图片219',exact:true}).waitFor();
 await dialog.getByRole('searchbox',{name:'批量参考图搜索',exact:true}).fill('');
 await dialog.getByRole('button',{name:'选择图片 隔离图片9',exact:true}).waitFor();

 await dialog.getByRole('button',{name:'选择图片 隔离图片9',exact:true}).evaluate(node=>node.click());
 measurements.push(await measure('apply-one-segment-image',dialog.getByRole('button',{name:'使用本段图片',exact:true})));
 if(await dialog.count())throw Error('Image choice did not apply');
 await first.getByRole('button',{name:'第 1 段选择参考图',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'取消选择图片 隔离图片9',exact:true}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'槽位用途',exact:true}).count();
 await page.keyboard.press('Escape');
 for(const item of measurements.filter(item=>item.label==='language-en-project-feedback'||item.label==='row-selection-project-feedback')) {
   if(item.counters.prepareVideoH3ReferenceDraft||item.counters.videoBatchRequestFingerprint)throw Error('Option click rebuilt candidates: '+JSON.stringify(item));
   if((item.counters.VideoAudioReferenceEditor||0)>1)throw Error('Unrelated row editors rerendered');
 }
 const applied=measurements.find(item=>item.label==='apply-one-segment-image');
 if(Object.keys(applied.preparedSegments||{}).some(id=>id!=='perf-segment-1'))throw Error('Image choice rebuilt unrelated segments');
 if(measurements.find(item=>item.label==='image-picker-open').counters.VideoAudioReferenceEditor)throw Error('Opening picker rerendered background editors');
 await page.evaluate(()=>window.__directorMetric.feedback=false);
 measurements.push(await measure('language-zh-without-project-feedback',first.getByRole('button',{name:'中文',exact:true})));
 const persisted = await page.evaluate(async()=>{
  const qa=window.__seedanceCharacterBindingQa;const React=(await import('/node_modules/.vite/deps/react.js')).default;
  const {VideoDirectorView}=await import('/src/components/VideoDirectorView.tsx');
  const project=JSON.parse(JSON.stringify(window.__diagProject));
  const saved=project.chapterWorkspaces['perf-chapter'].videoDirector.batch;
  qa.root.render(React.createElement(VideoDirectorView,{key:'restored-form',project,settings:window.__diagSettings,controller:qa.controller}));
  return {language:saved.languages['perf-segment-1'],selected:saved.selectedKeys,submitted:qa.submissions.length};
 });
 await first.waitFor();
 await first.locator('.vd-batch-row-settings > summary').click();
 await first.getByRole('button',{name:persisted.language==='en'?'英文':'中文',exact:true}).waitFor();
 const restoredLanguage=await first.getByRole('button',{name:persisted.language==='en'?'英文':'中文',exact:true}).getAttribute('aria-pressed');
 if(restoredLanguage!=='true')throw Error('Saved language did not restore');
 await page.setViewportSize({width:390,height:844});
 await first.getByRole('button',{name:'第 1 段选择参考图',exact:true}).click();
 const mobileDialog=page.getByRole('dialog');
 await mobileDialog.getByRole('button',{name:'取消选择图片 隔离图片9',exact:true}).waitFor();
 await mobileDialog.getByRole('tab',{name:'槽位用途',exact:true}).click();
 await mobileDialog.getByRole('tab',{name:'图片选择',exact:true}).click();
 const mobile=await mobileDialog.evaluate(node=>{const box=node.getBoundingClientRect();return{left:box.left,right:box.right,width:innerWidth,overflow:node.scrollWidth>node.clientWidth+1,backgroundOverflow:document.documentElement.scrollWidth>innerWidth};});
 if(mobile.left<0||mobile.right>mobile.width+1||mobile.overflow)throw Error('Mobile picker overflow: '+JSON.stringify(mobile));
 await page.screenshot({path:path.join(output,'mobile-picker.png')});
 if(persisted.submitted)throw Error('UI diagnosis submitted a generation request');
 const report={passed:true,persisted,mobile,version:'4.6.9',mode:'Current source, React development Profiler; isolated synthetic data, no user project data or generation requests. Timings exclude module loading and fixture setup.',fixture:{segments:34,bilingualCandidates:68,assets:320,characters:8,dom:mount.dom,promptChars:mount.promptChars,audioEditors:mount.audioEditors},mount,measurements,errors,blockedRequests:fixture.blockedRequests};
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
 console.log('REPORT '+path.join(output,'report.json'));
 if(errors.length||fixture.blockedRequests.length)throw Error(JSON.stringify({errors,blockedRequests:fixture.blockedRequests}));
}finally{await browser?.close();await server.close();}

