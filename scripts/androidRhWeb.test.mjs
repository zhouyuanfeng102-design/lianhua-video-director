import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';

const script=fs.readFileSync(new URL('../android/app/src/main/assets/rh-web.js',import.meta.url),'utf8');
const selectOptionsOnly=process.argv.includes('--select-options-only');
let submissions=0;
const html=`<!doctype html><html><head><title>手机适配测试 - RunningHub</title></head><body>
<header class="header-right"><span class="user-name">测试用户</span><a title="积分">积分</a><span title="积分 1037"></span><span title="过渡 RH 币 208691"></span><span title="RH币 9"></span><span title="钱包: 0"></span></header><h1 class="ai-title">H3 测试应用</h1>
<div class="ai-side"><div class="item-plane"><div class="plane-top"><span class="title">提示词</span></div><textarea>网页示例</textarea></div>
<div class="item-plane"><div class="plane-top"><span class="title">时长</span></div><input type="number" value="30"></div>
<div class="item-plane"><div class="plane-top"><span class="title">自动提示词</span></div><button role="switch" aria-checked="true" onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')==='true'?'false':'true')">开关</button></div></div>
<div class="run-mode-current">标准</div><div>≈ 0.6 RH币</div><button class="run-cell-main" onclick="fetch('/task',{method:'POST'}).then(r=>r.json())">立即运行</button>
</body></html>`;
const selectsHtml=`<!doctype html><meta charset="utf-8"><title>多下拉读取假站</title>
<header class="header-right"><span class="user-name">测试用户</span></header><h1 class="ai-title">多下拉应用</h1>
<div class="ai-side">
<div class="item-plane" data-field="LLM"><div class="plane-top"><span class="title" title="LLM">LLM</span></div><button class="ant-select"><span class="ant-select-selection-item">旧模型</span></button></div>
<div class="item-plane" data-field="aspect_ratio"><div class="plane-top"><span class="title">aspect_ratio</span></div><button class="ant-select"><span class="ant-select-selection-item">16:9</span></button></div>
<div class="side-plane" data-field="采样器"><div class="plane-top"><span class="title">采样器</span></div><button class="ant-select"><span class="ant-select-selection-item">Euler</span></button></div>
<div class="item-plane" data-field="lora_name"><div class="plane-top"><span class="title">lora_name</span></div><button class="ant-select"><span class="ant-select-selection-item">原 LoRA</span></button><input type="number" value="0.65"></div>
</div><div class="run-mode-current">标准</div><div>≈ 0.6 RH币</div>
<button class="run-cell-main" onclick="fetch('/task',{method:'POST'})">立即运行</button>
<script>
window.selectWrites=0;window.openedSelects=[];
const lists={LLM:Array.from({length:25},(_,i)=>'LLM 模型 '+(i+1)),aspect_ratio:['9:16','16:9','1:1'],采样器:['Euler','DPM++ 2M'],lora_name:['原 LoRA','其他 LoRA']};
function closeDropdown(){document.querySelector('.ant-select-dropdown')?.remove();}
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDropdown();});
for(const trigger of document.querySelectorAll('.ant-select'))trigger.onclick=()=>{
const field=trigger.closest('[data-field]').dataset.field;
const old=document.querySelector('.ant-select-dropdown');if(old?.dataset.field===field){closeDropdown();return;}closeDropdown();window.openedSelects.push(field);
const popup=document.createElement('div');popup.className='ant-select-dropdown';popup.dataset.field=field;
const holder=document.createElement('div');holder.className='rc-virtual-list-holder';holder.style.cssText='height:60px;overflow:auto;position:relative';
const inner=document.createElement('div');inner.style.cssText='height:'+(lists[field].length*20)+'px;position:relative';holder.append(inner);popup.append(holder);document.body.append(popup);
function render(){const start=Math.floor(holder.scrollTop/20);inner.innerHTML='';for(let i=start;i<Math.min(start+3,lists[field].length);i++){const option=document.createElement('div');option.className='ant-select-item-option-content';option.textContent=lists[field][i];option.style.cssText='position:absolute;height:20px;top:'+(i*20)+'px';option.onclick=()=>{window.selectWrites++;trigger.querySelector('span').textContent=option.textContent;closeDropdown();};inner.append(option);}}
holder.onscroll=()=>requestAnimationFrame(render);render();};
</script>`;
const pointsHtml=html.replace('≈ 0.6 RH币','费用以实际用量结算').replace('H3 测试应用','积分测试应用');
const emptyHtml=html.replace('<div>≈ 0.6 RH币</div>','<div>每秒消耗0.2个RH币</div>');
const server=http.createServer((req,res)=>{
  if(req.url==='/task'){submissions++;res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{taskId:'native-test-task-123'}}));return;}
  if(req.url==='/api/output/v2/history'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{records:[{taskId:'native-test-task-123',taskStatus:'SUCCESS',fileUrl:'https://example.invalid/test.mp4'}]}}));return;}
  res.setHeader('content-type','text/html;charset=utf-8');
  const path=req.url.split('?')[0];
  res.end(path==='/selects'?selectsHtml:path==='/points'?pointsHtml:path==='/empty'?emptyHtml:html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage();
  if(selectOptionsOnly){
    await page.goto(`http://127.0.0.1:${server.address().port}/selects`);
    await page.evaluate(script);
    const form=await page.evaluate(()=>window.__lianhuaRh.operations.read());
    const selects=form.fields.filter(field=>field.kind==='select');
    assert.deepEqual(selects.map(field=>field.key),['select:LLM','select:aspect','select:采样器']);
    assert.equal(new Set(selects.map(field=>field.key)).size,3,'generic selects must not all become select:aspect');
    assert.deepEqual(selects.find(field=>field.key==='select:LLM').options,['旧模型',...Array.from({length:25},(_,i)=>'LLM 模型 '+(i+1))],'virtual scrolling reads every available LLM option and preserves the current value');
    assert.deepEqual(selects.find(field=>field.key==='select:aspect').options,['9:16','16:9','1:1']);
    assert.deepEqual(selects.find(field=>field.key==='select:采样器').options,['Euler','DPM++ 2M']);
    assert.equal(form.fields.find(field=>field.key==='lora:1:name').value,'原 LoRA');
    assert.equal(form.fields.find(field=>field.key==='lora:1:strength').value,'0.65');
    assert.deepEqual(await page.evaluate(()=>window.openedSelects),['LLM','aspect_ratio','采样器'],'each select reads only its own plane; the dedicated LoRA picker is untouched');
    assert.equal(await page.evaluate(()=>window.selectWrites),0,'reading options must not change the selected values');
    assert.equal(await page.locator('.ant-select-dropdown').count(),0,'read operation closes its dropdown');
    assert.equal(submissions,0,'reading multiple selects must not submit a model job');
    console.log('Android RH multiple-select read passed: stable LLM/aspect/sampler keys, 25 virtual LLM options plus current value, separate option lists, unchanged LoRA and selections, 0 model submissions (local mock only).');
  }else{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(script);
  const session=await page.evaluate(()=>window.__lianhuaRh.operations.session());
  assert.equal(session.coins,'积分 1037 · 过渡 RH 币 208691');
  assert.equal(session.wallet,'钱包: 0');
  await page.evaluate(()=>{document.querySelector('.header-right').innerHTML='<span class="user-name">测试用户</span><span title="RH币 88"></span><span title="钱包: $1.5"></span>';});
  const legacy=await page.evaluate(()=>window.__lianhuaRh.operations.session());
  assert.equal(legacy.coins,'RH币 88');
  assert.equal(legacy.wallet,'钱包: $1.5');
  const form=await page.evaluate(()=>window.__lianhuaRh.operations.read());
  assert.equal(form.name,'H3 测试应用');
  assert.equal(form.fields.find(f=>f.key==='number:duration').value,30);
  const body={client_id:'one-user-submission',instance:'标准',fields:[
    {key:'text:prompt',label:'提示词',kind:'text',value:'The camera tilts down with small amplitude at slow speed toward the letter.'},
    {key:'number:duration',label:'时长',kind:'number',value:30},
    {key:'boolean:auto-prompt',label:'自动提示词',kind:'boolean',value:false},
  ]};
  await page.evaluate(body=>window.__lianhuaRh.operations.prepare(body),body);
  assert.equal(await page.locator('textarea').inputValue(),body.fields[0].value);
  assert.equal(await page.locator('[role=switch]').getAttribute('aria-checked'),'false');
  assert.equal(submissions,0,'reading/preparing must not submit a model job');
  const result=await page.evaluate(body=>window.__lianhuaRh.operations.submit(body),body);
  assert.equal(result.upstream_task_id,'native-test-task-123');
  await page.evaluate(body=>window.__lianhuaRh.operations.submit(body),body);
  assert.equal(submissions,1,'same client must not click run a second time');
  await page.reload();await page.evaluate(script);
  const recovered=await page.evaluate(body=>window.__lianhuaRh.operations.recover(body),body);
  assert.equal(recovered.upstream_task_id,'native-test-task-123');
  assert.equal(submissions,1,'reload/recovery must not submit');
  const output=await page.evaluate(()=>window.__lianhuaRh.operations.output({webappId:'test-app',taskId:'native-test-task-123'}));
  assert.equal(output.done,true);assert.equal(output.fileUrl,'https://example.invalid/test.mp4');
  await page.goto(`http://127.0.0.1:${server.address().port}/points`);
  await page.evaluate(script);
  const pointsQuote=await page.evaluate(body=>window.__lianhuaRh.operations.prepare(body),{...body,client_id:'points-page'});
  assert.equal(pointsQuote.quote,'');
  assert.equal(submissions,1,'a new points page can be prepared without clicking run');
  await page.goto(`http://127.0.0.1:${server.address().port}/empty`);
  await page.evaluate(script);
  await assert.rejects(page.evaluate(body=>window.__lianhuaRh.operations.prepare(body),body),/没有读到预估 RH 币/);
  assert.equal(submissions,1,'an old page without the RH coin quote still does not run');
  console.log('Android RH page adapter: read, prepare, one submission, reload recovery and existing-task output passed (mock website only).');
  }
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
