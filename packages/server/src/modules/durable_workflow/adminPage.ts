/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { ServerResponse } from 'node:http';

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otto 耐久任务接管中心</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#12251f;background:#f3f7f5}*{box-sizing:border-box}body{margin:0}.top{padding:24px 32px;background:#123d31;color:#fff;display:flex;justify-content:space-between;align-items:center}.top h1{margin:0;font-size:24px}.top a{color:#d5f5e8}.shell{display:grid;grid-template-columns:minmax(480px,1.2fr) minmax(360px,.8fr);gap:18px;padding:24px}.card{background:#fff;border:1px solid #d9e4df;border-radius:12px;padding:18px;box-shadow:0 6px 20px #173b2e0d}.filters,.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}button{border:1px solid #8aa89d;background:#fff;color:#174c3b;border-radius:7px;padding:8px 12px;cursor:pointer}button.primary{background:#176b50;color:#fff;border-color:#176b50}button.danger{color:#9b2929;border-color:#d8a3a3}button:disabled{opacity:.5;cursor:not-allowed}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e6eeea}tr[data-id]{cursor:pointer}tr[data-id]:hover{background:#f1f8f5}.status{display:inline-block;padding:3px 8px;border-radius:999px;background:#e8f1ed}.status.unknown_outcome,.status.dead_letter{background:#fde8e8;color:#8b1d1d}.status.waiting_approval{background:#fff2cc;color:#765700}.muted{color:#60736c}.notice{padding:10px;border-radius:7px;background:#eef7f3;margin:10px 0;min-height:38px}.error{background:#fdeaea;color:#8b1d1d}.step{border:1px solid #e0e9e5;border-radius:8px;padding:10px;margin:8px 0}.step b{display:block;margin-bottom:4px}@media(max-width:900px){.shell{grid-template-columns:1fr}.top{padding:18px}.shell{padding:14px}}
</style></head><body>
<header class="top"><div><h1>耐久任务接管中心</h1><div>审批、未知结果、死信与补偿</div></div><a href="/enterprise/admin">返回企业管理</a></header>
<main class="shell"><section class="card"><h2>任务列表</h2><div class="filters"><button data-filter="">全部</button><button data-filter="waiting_approval">等待审批</button><button data-filter="unknown_outcome">结果未知</button><button data-filter="dead_letter">死信</button><button id="refresh">刷新</button></div><div id="listStatus" class="notice">正在读取任务</div><table><thead><tr><th>更新时间</th><th>流程</th><th>状态</th><th>失败代码</th></tr></thead><tbody id="runs"></tbody></table></section>
<aside class="card"><h2>任务详情</h2><div id="detail" class="muted">从左侧选择一个任务。</div></aside></main>
<script>
const KEY='otto.enterprise.admin.session';let filter='',selected='',timer=0;const q=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,options={}){const token=sessionStorage.getItem(KEY)||'';const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'请求失败');return body}
function status(value){return '<span class="status '+esc(value)+'">'+esc(value)+'</span>'}
async function load(){try{q('#listStatus').className='notice';q('#listStatus').textContent='正在读取任务';const suffix=filter?'?status='+encodeURIComponent(filter):'';const data=await api('/enterprise/workflows'+suffix);q('#runs').innerHTML=data.runs.length?data.runs.map(run=>'<tr data-id="'+esc(run.id)+'"><td>'+esc(new Date(run.updatedAt).toLocaleString())+'</td><td>'+esc(run.definitionId)+'</td><td>'+status(run.status)+'</td><td>'+esc(run.failureCode||'-')+'</td></tr>').join(''):'<tr><td colspan="4" class="muted">没有匹配的任务</td></tr>';q('#listStatus').textContent='共 '+data.runs.length+' 个任务';document.querySelectorAll('tr[data-id]').forEach(row=>row.onclick=()=>show(row.dataset.id))}catch(error){q('#listStatus').className='notice error';q('#listStatus').textContent=error.message}}
function askNote(label){const note=window.prompt(label);return note&&note.trim()?note.trim():null}
async function action(path,body){try{await api(path,{method:'POST',body:JSON.stringify(body)});await load();if(selected)await show(selected)}catch(error){window.alert(error.message)}}
async function show(id){
selected=id;
try{
const data=await api('/enterprise/workflows/'+encodeURIComponent(id)),run=data.run;
let html='<h3>'+esc(run.definitionId)+'</h3><p>'+status(run.status)+'<br><span class="muted">'+esc(run.id)+'</span></p><div class="actions">';
if(!['succeeded','compensated','cancelled'].includes(run.status))html+='<button class="danger" id="cancel">取消</button>';
if(['failed','cancelled','unknown_outcome','dead_letter'].includes(run.status))html+='<button id="compensate">执行补偿</button>';
html+='</div><h3>步骤</h3>'+run.steps.map(step=>'<div class="step"><b>'+esc(step.stepId)+' · '+status(step.status)+'</b><div>'+esc(step.taskType)+'；尝试 '+esc(step.attempt)+'/'+esc(step.maxAttempts)+'</div><div class="muted">'+esc(step.errorSummary||'无错误摘要')+'</div><div class="actions">'+(step.status==='waiting_approval'?'<button class="primary" data-approve="'+esc(step.stepId)+'" data-approval="'+esc(step.approvalId)+'">批准</button>':'')+(step.status==='unknown_outcome'?'<button data-resolve="'+esc(step.stepId)+'" data-resolution="mark_succeeded">确认已成功</button><button data-resolve="'+esc(step.stepId)+'" data-resolution="mark_failed">确认失败</button><button data-resolve="'+esc(step.stepId)+'" data-resolution="cancel">人工取消</button>':'')+(step.status==='dead_letter'?'<button data-retry="'+esc(step.stepId)+'" data-mode="forward" data-external="'+esc(step.sideEffect==='external')+'">重试</button>':'')+'</div></div>').join('');
if(run.compensations&&run.compensations.length)html+='<h3>补偿步骤</h3>'+run.compensations.map(item=>'<div class="step"><b>'+esc(item.stepId)+' · '+status(item.status)+'</b><div>'+esc(item.taskType)+'；尝试 '+esc(item.attempt)+'/'+esc(item.maxAttempts)+'</div><div class="muted">'+esc(item.errorSummary||'无错误摘要')+'</div>'+(item.status==='dead_letter'?'<div class="actions"><button data-retry="'+esc(item.stepId)+'" data-mode="compensation" data-external="false">重试补偿</button></div>':'')+'</div>').join('');
q('#detail').innerHTML=html;
const cancel=q('#cancel');if(cancel)cancel.onclick=()=>{const note=askNote('请输入取消理由');if(note)action('/enterprise/workflows/'+encodeURIComponent(id)+'/cancel',{note})};
const compensate=q('#compensate');if(compensate)compensate.onclick=()=>{const note=askNote('请输入补偿理由');if(note)action('/enterprise/workflows/'+encodeURIComponent(id)+'/compensate',{note})};
document.querySelectorAll('[data-approve]').forEach(button=>button.onclick=()=>action('/enterprise/workflows/'+encodeURIComponent(id)+'/steps/'+encodeURIComponent(button.dataset.approve)+'/approve',{approvalId:button.dataset.approval}));
document.querySelectorAll('[data-resolve]').forEach(button=>button.onclick=()=>{const note=askNote('请输入核对证据与处理理由');if(note)action('/enterprise/workflows/'+encodeURIComponent(id)+'/steps/'+encodeURIComponent(button.dataset.resolve)+'/resolve',{resolution:button.dataset.resolution,note})});
document.querySelectorAll('[data-retry]').forEach(button=>button.onclick=()=>{const note=askNote('请输入重试理由');if(!note)return;const external=button.dataset.external==='true';const confirmed=external?window.confirm('确认外部操作没有发生，允许重新执行？'):false;if(external&&!confirmed)return;action('/enterprise/workflows/'+encodeURIComponent(id)+'/steps/'+encodeURIComponent(button.dataset.retry)+'/retry',{note,mode:button.dataset.mode,confirmedExternalNotExecuted:confirmed})});
}catch(error){q('#detail').innerHTML='<div class="notice error">'+esc(error.message)+'</div>'}
}
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;load()});q('#refresh').onclick=load;function schedule(){clearInterval(timer);if(!document.hidden)timer=setInterval(load,15000)}document.addEventListener('visibilitychange',schedule);schedule();load();
</script></body></html>`;

export function sendDurableWorkflowAdminPage(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; connect-src 'self'; img-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(PAGE);
}
