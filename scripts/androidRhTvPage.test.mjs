import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// All URLs below are fulfilled locally. No login, model or paid request.
const source=fs.readFileSync(new URL('../android/app/src/main/assets/rh-tv.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true});
const scenarios=[];
const fixture=`<!doctype html><meta charset="utf-8"><button>Minimax H3 RH Enhanced</button>
<div class="home-agent-input-bar--landing"><textarea class="composer-input"></textarea><input type="file" multiple></div>
<button class="video-mode-tab active">文生视频</button><button class="video-mode-tab">首帧</button><button class="video-mode-tab">首尾帧</button><button class="video-mode-tab">全能参考</button>
<button id="params">自适应 / 768p / 5秒</button><div id="options"></div><div id="images"></div><button id="run">开始创作</button>
<script>
const values={aspect_ratio:'自适应',resolution:'768p',duration:5};
const summary=document.querySelector('#params');
function refresh(){summary.textContent=values.aspect_ratio+' / '+values.resolution+' / '+values.duration+'秒';}
summary.onclick=()=>{document.querySelector('#options').innerHTML='<div role="tooltip"><button>自适应</button><button>9:16</button><button>16:9</button><button>480p</button><button>768p</button><button>1080p</button><input aria-label="生成时长"></div>';for(const b of document.querySelectorAll('[role=tooltip] button'))b.onclick=()=>{if(b.textContent.endsWith('p'))values.resolution=b.textContent;else values.aspect_ratio=b.textContent;refresh();};const n=document.querySelector('[aria-label="生成时长"]');n.oninput=()=>{values.duration=Number(n.value);refresh();};};
for(const b of document.querySelectorAll('.video-mode-tab'))b.onclick=()=>{document.querySelector('.video-mode-tab.active').classList.remove('active');b.classList.add('active');};
document.querySelector('input[type=file]').onchange=event=>{const root=document.querySelector('#images');root.innerHTML='';for(const file of event.target.files){const item=document.createElement('div');item.className='home-att-stack-item';const img=document.createElement('img');img.className='home-att-stack-thumb';img.alt=file.name;img.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';item.append(img);root.append(item);}};
window.testReady=fetch('https://www.runninghub.ai/canvas/model/list',{method:'POST',headers:{authorization:'Bearer fake-account','Content-Type':'application/json'},body:'{}'}).then(r=>r.json());
document.querySelector('#run').onclick=()=>{const images=[...document.querySelectorAll('img.home-att-stack-thumb')];const mode=document.querySelector('.video-mode-tab.active').textContent;const sub={'文生视频':'text-video','首帧':'start-video','首尾帧':'start-end-video','全能参考':'multimodal-video'}[mode];const nodes=images.map((img,i)=>({id:'img-'+i,type:'rh-image',data:{title:img.alt,sourceObjects:[{url:'https://cdn.runninghub.ai/ref-'+i+'.png'}]}}));nodes.push({id:'target',type:'rh-video',data:{modelCode:'h3',subType:sub,params:{prompt:document.querySelector('.composer-input').value+(window.mismatch?' changed':''),duration:values.duration,resolution:values.resolution,aspectRatio:values.aspect_ratio,generateNum:1}}});const body={canvasId:'canvas-1',targetType:'NODE',targetId:'target',canvas:{nodes,edges:images.map((img,i)=>({source:'img-'+i,target:'target'}))}};if(window.xhrMode){const xhr=new XMLHttpRequest();xhr.open('POST','https://www.runninghub.ai/canvas/task/run');xhr.setRequestHeader('authorization','Bearer fake-account');xhr.setRequestHeader('Content-Type','application/json');xhr.send(JSON.stringify(body));}else fetch('https://www.runninghub.ai/canvas/task/run',{method:'POST',headers:{authorization:'Bearer fake-account','Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>{});};
</script>`;

async function runCase(name,{price=0,lost=false,xhr=false,mismatch=false,refs=false}={}){
  const context=await browser.newContext();const page=await context.newPage();const counts={run:0,quote:0,poll:0};
  await page.addInitScript({content:source});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.host==='rhtv.runninghub.ai'){await route.fulfill({contentType:'text/html',body:fixture});return;}
    if(url.host==='www.runninghub.ai'&&url.pathname==='/canvas/model/list'){
      await route.fulfill({json:{code:0,data:[{modelCode:'h3',modelName:'Minimax H3 RH Enhanced',skuId:'sku-h3',config:[{paramName:'prompt',type:'prompt'},{paramName:'duration',type:'duration',paramDataType:'int'},{paramName:'resolution',type:'resolution'},{paramName:'aspectRatio',type:'aspectRatio'}]}]}});return;
    }
    if(url.pathname==='/canvas/price/calculate'){counts.quote++;await route.fulfill({json:{code:0,data:{totalPrice:price,discountTotalPrice:price,currency:'RH',freeRemaining:2}}});return;}
    if(url.pathname==='/canvas/task/run'){counts.run++;await route.fulfill(lost?{status:503,json:{message:'receipt lost'}}:{json:{code:0,data:{taskId:'upstream-1'}}});return;}
    if(url.pathname==='/canvas/task/batchStatus'){counts.poll++;await route.fulfill({json:{code:0,data:{tasks:[{taskId:'upstream-1',plans:[{nodeId:'target',status:'finished',outputs:[{url:'https://cdn.runninghub.ai/result.mp4',outputType:'video'}]}]}]}}});return;}
    throw new Error('Unexpected external request '+url.href);
  });
  await page.goto('https://rhtv.runninghub.ai/projects?model=476');await page.evaluate(()=>window.testReady);
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const checksum=createHash('sha256').update(image).digest('hex');
  const references=refs?[{upload_id:checksum+'_png',asset_id:'last',slot_index:1,role:'last-frame'},{upload_id:checksum+'_png',asset_id:'first',slot_index:0,role:'first-frame'}]:[];
  const job={id:'job-'+name,client_id:'client-'+name,request:{mode:refs?'first_last':'text',prompt:'林青保持站立，缓缓回头。',parameters:{duration:10,resolution:'768p',aspect_ratio:'9:16'},references}};
  const prepared=await page.evaluate(async({job,files,xhr,mismatch})=>{window.xhrMode=xhr;window.mismatch=mismatch;return window.__lianhuaRhTv.operations.prepare({job,files,manual:false});},{job,files:refs?[{upload_id:checksum+'_png',base64:image.toString('base64')}]:[],xhr,mismatch});
  assert.match(prepared.message,/已准备/);
  await page.evaluate(job=>{window.submission=window.__lianhuaRhTv.operations.submit({job}).then(value=>({value}),error=>({error:error.message}));},job);
  if(price||mismatch){const failed=await page.evaluate(()=>window.submission);assert.match(failed.error,price?/报价非零/:/提示词/);assert.equal(counts.run,0);}
  else{
    await page.waitForFunction(()=>window.__lianhuaRhTv.boundary);
    assert.equal(counts.run,0,'No generation POST before the native durable acknowledgment');
    const boundary=await page.evaluate(()=>window.__lianhuaRhTv.boundary);assert.equal(boundary.quote.total,0);assert.equal(boundary.upstream.canvas_id,'canvas-1');
    if(refs)assert.deepEqual(boundary.reference_receipt.map(ref=>ref.role),['first-frame','last-frame']);
    await page.evaluate(token=>window.__lianhuaRhTv.operations.acknowledge({token,allowed:true}),boundary.token);
    const result=await page.evaluate(()=>window.submission);assert.equal(counts.run,1);
    if(lost){assert.match(result.error,/回执/);const recovery=await page.evaluate(job=>window.__lianhuaRhTv.operations.recover({job}),job);assert.equal(recovery.status,'submission_unknown');}
    else{assert.equal(result.value.upstream.task_id,'upstream-1');const polled=await page.evaluate(job=>window.__lianhuaRhTv.operations.poll({job}),{...job,upstream:result.value.upstream});assert.equal(polled.status,'succeeded');assert.match(polled.url,/result.mp4$/);}
    await page.evaluate(job=>window.__lianhuaRhTv.operations.submit({job}),job);assert.equal(counts.run,1,'Recovery never issues a second run POST');
  }
  scenarios.push({name,...counts});await context.close();
}
try{
  await runCase('free-fetch');await runCase('free-xhr',{xhr:true});await runCase('paid-pauses',{price:5});await runCase('lost-receipt',{lost:true});await runCase('changed-prompt',{mismatch:true});await runCase('first-last-original-order',{refs:true});
  const output=path.resolve('output','android-rhtv-page');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({mockOnly:true,liveSiteVerified:false,scenarios},null,2));
  console.log(JSON.stringify({passed:scenarios.length,mockOnly:true,liveSiteVerified:false,scenarios},null,2));
}finally{await browser.close();}
