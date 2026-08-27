/**
 * The console UI as one HTML string (disposable v1). Cognito Hosted UI login
 * with PKCE in ~60 lines of vanilla JS; three tabs over the read-only API.
 * __COGNITO_DOMAIN__ and __CLIENT_ID__ are substituted by the Lambda.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WNK Console</title>
<style>
  :root { --ink:#23292f; --soft:#5a636b; --line:#d8dcd9; --accent:#0e7c86; --bg:#f7f8f6; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e3e7e6; --soft:#9aa4a6; --line:#333a3d; --accent:#4fb3bc; --bg:#171a1c; --card:#1e2225; } }
  * { box-sizing:border-box; } body { margin:0; font:15px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; align-items:center; gap:16px; padding:14px 22px; border-bottom:2px solid var(--ink); }
  header h1 { font-size:17px; margin:0; } header .who { color:var(--soft); font-size:13px; margin-left:auto; }
  nav { display:flex; gap:6px; padding:12px 22px 0; } nav[hidden] { display:none; }
  nav button { font:inherit; padding:6px 14px; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:6px 6px 0 0; cursor:pointer; }
  nav button.on { border-color:var(--accent); color:var(--accent); font-weight:600; }
  main { padding:16px 22px 60px; max-width:960px; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th,td { text-align:left; padding:7px 12px 7px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--soft); }
  tr.row { cursor:pointer; } tr.row:hover td { color:var(--accent); }
  .detail { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:14px 18px; margin:14px 0; }
  .detail .t { margin:4px 0; } .detail .t b { color:var(--soft); font-weight:600; margin-right:8px; }
  .muted { color:var(--soft); } button.link { background:none; border:none; color:var(--accent); cursor:pointer; font:inherit; padding:0; }
  #login { margin:80px auto; text-align:center; }
  #login button { font:inherit; padding:10px 22px; background:var(--accent); color:#fff; border:none; border-radius:6px; cursor:pointer; }
</style></head><body>
<header><h1>WNK Console</h1><span class="who" id="who"></span></header>
<div id="login" hidden><p>Read-only console for your business's agents.</p><button onclick="login()">Sign in</button></div>
<nav id="nav" hidden>
  <button data-tab="calls" class="on">Calls</button><button data-tab="leads">Leads</button><button data-tab="memory">Memory</button><button data-tab="business">Business</button>
</nav>
<main id="main" hidden></main>
<script>
const DOMAIN='__COGNITO_DOMAIN__', CLIENT='__CLIENT_ID__', HERE=location.origin+'/';
function login(){
  location=DOMAIN+'/oauth2/authorize?response_type=code&client_id='+CLIENT+'&redirect_uri='+encodeURIComponent(HERE+'auth/callback')+'&scope=openid+email+profile';
}
const api=async(p)=>{const r=await fetch('/api'+p,{headers:{authorization:'Bearer '+sessionStorage.getItem('idt')}});
  if(r.status===401){sessionStorage.removeItem('idt');show();throw new Error('expired');} return r.json();};
const el=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d;};
const esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when=(iso)=>iso?new Date(iso).toLocaleString():'—';
const main=document.getElementById('main');
async function tabCalls(){
  const calls=await api('/calls');
  main.innerHTML='<table><tr><th>When</th><th>From</th><th>Status</th><th>Turns</th><th>Tools</th></tr>'+calls.map(c=>
    '<tr class="row" data-id="'+esc(c.callId)+'"><td>'+when(c.startedAt)+'</td><td>'+esc(c.from)+'</td><td>'+esc(c.status)+'</td><td>'+c.turns+'</td><td>'+esc((c.tools||[]).join(', '))+'</td></tr>').join('')+'</table><div id="calldetail"></div>';
  main.querySelectorAll('tr.row').forEach(r=>r.onclick=async()=>{
    const c=await api('/calls/'+r.dataset.id);
    document.getElementById('calldetail').replaceChildren(el('<div class="detail"><p class="muted">'+esc(c.callId)+' · '+when(c.startedAt)+' → '+when(c.endedAt)+'</p>'+
      (c.transcript||[]).map(t=>'<p class="t"><b>'+esc(t.role)+'</b>'+esc(t.text)+'</p>').join('')+
      ((c.toolCalls||[]).length?'<p class="muted">tools: '+esc(c.toolCalls.map(t=>t.name).join(', '))+'</p>':'')+'</div>'));
  });
}
async function tabLeads(){
  const leads=await api('/leads');
  main.innerHTML='<table><tr><th>When</th><th>Name</th><th>Phone</th><th>Reason</th><th>Callback</th></tr>'+leads.map(l=>
    '<tr><td>'+when(l.createdAt)+'</td><td>'+esc(l.callerName)+'</td><td>'+esc(l.phone)+'</td><td>'+esc(l.reason)+'</td><td>'+esc(l.preferredCallbackTime)+'</td></tr>').join('')+'</table>';
}
async function tabMemory(){
  const calls=await api('/calls');
  const phones=[...new Set(calls.map(c=>c.from).filter(Boolean))];
  main.innerHTML='<p class="muted">What the platform remembers, per caller (extracted from call transcripts):</p>'+
    phones.map(p=>'<p><button class="link" data-p="'+esc(p)+'">'+esc(p)+'</button></p>').join('')+'<div id="mem"></div>';
  main.querySelectorAll('button.link').forEach(b=>b.onclick=async()=>{
    const m=await api('/memories?phone='+encodeURIComponent(b.dataset.p));
    document.getElementById('mem').replaceChildren(el('<div class="detail"><p class="muted">'+esc(m.phone)+'</p>'+
      (m.records.length?m.records.map(r=>{try{const j=JSON.parse(r);r=(j.preference||r)+(j.context?' — '+j.context:'');}catch{}return '<p class="t">• '+esc(r)+'</p>';}).join(''):'<p class="muted">nothing yet</p>')+'</div>'));
  });
}
async function tabBusiness(){
  const {config:c,prompt}=await api('/tenant');
  const row=(k,v)=>'<tr><td>'+esc(k)+'</td><td>'+esc(v)+'</td></tr>';
  const groups=[
    ['Identity',[['phoneNumber (routing key)',c.phoneNumber],['businessName',c.businessName],['agentName',c.agentName],['greeting',c.greeting||'(default)'],['active',c.active]]],
    ['Knowledge (fed into prompt)',[['description',c.description||'—'],['services',(c.services||[]).join(', ')],['hours',c.hours||'—'],['timezone',c.timezone]]],
    ['Behavior',[['extraInstructions',c.extraInstructions||'—'],['tools',(c.tools||[]).join(', ')],['maxCallSeconds',c.maxCallSeconds+' ('+Math.round(c.maxCallSeconds/60)+' min)']]],
    ['Voice & model',[['model',c.model],['voice',c.voice]]],
    ['Integrations',[['notifications.email',c.notifications?.email||'(none — owner gets no email)'],['notifications.sms',c.notifications?.sms||'(none)'],['crm',c.crm?.type||'(none)']]],
  ];
  main.innerHTML='<p class="muted">Every per-business lever, live from the tenants table. Change via tenants/'+esc(c.tenantId)+'.json + npm run seed.</p>'+
    groups.map(([g,rows])=>'<h3 style="margin:18px 0 4px;font-size:15px">'+esc(g)+'</h3><table>'+rows.map(r=>row(r[0],r[1])).join('')+'</table>').join('')+
    '<h3 style="margin:22px 0 4px;font-size:15px">The prompt these levers produce</h3><p class="muted">Exactly what the voice agent is told at call start (before caller memory / caller ID are appended):</p>'+
    '<pre style="background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px;white-space:pre-wrap;font-size:12.5px;overflow-x:auto">'+esc(prompt)+'</pre>';
}
const tabs={calls:tabCalls,leads:tabLeads,memory:tabMemory,business:tabBusiness};
document.getElementById('nav').onclick=(e)=>{const t=e.target.dataset?.tab;if(!t)return;
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));tabs[t]();};
async function show(){
  const signedIn=!!sessionStorage.getItem('idt');
  document.getElementById('login').hidden=signedIn;
  document.getElementById('nav').hidden=!signedIn;
  main.hidden=!signedIn;
  if(signedIn){try{const me=await api('/me');document.getElementById('who').textContent=(me.email||'')+' · '+me.tenantId;await tabCalls();}catch{}}
}
show();
</script></body></html>`;
