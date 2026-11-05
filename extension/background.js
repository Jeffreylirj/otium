import { fillWithCopilot } from './simplify.js';

const app='http://127.0.0.1:4317';
const pulseAlarm='otium-worker-poll';
const guardTypes=['main_frame','sub_frame','xmlhttprequest','ping','websocket','webtransport','other'];
const empty=(status,reason)=>({status,reason,filled:[],missing:[],coverage:null});
let pollInFlight, csrf, lastFailure=0, timer, focusedBatch;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const script=(tabId,func,args=[])=>chrome.scripting.executeScript({target:{tabId},func,args}).then(rows=>rows[0]?.result);

async function api(action,body,retry=true){
  if(!csrf){
    const r=await fetch(app+'/api/state',{signal:AbortSignal.timeout(3000),cache:'no-store'});
    if(!r.ok)throw Error('Otium is offline');
    csrf=(await r.json()).csrf;
  }
  const response=await fetch(app+'/api/chrome/'+action,{method:'POST',signal:AbortSignal.timeout(3000),
    headers:{'Content-Type':'application/json','X-Otium-Token':csrf},body:JSON.stringify(body)});
  if(response.status===403&&retry){csrf=null;return api(action,body,false);}
  if(!response.ok)throw Error('Chrome companion could not connect');
  return response.json();
}

async function guard(tabId){
  const id=tabId+1;
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[id],addRules:[{
    id,priority:1,action:{type:'block'},condition:{tabIds:[tabId],resourceTypes:guardTypes}
  }]});
}

async function releaseGuards(closeTabs=false,batchId){
  const rules=await chrome.declarativeNetRequest.getSessionRules();
  const tabIds=[...new Set(rules.flatMap(rule=>rule.condition.tabIds??[]))];
  await Promise.allSettled(tabIds.map(tabId=>script(tabId,()=>globalThis.otiumRelease?.())));
  if(rules.length)await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:rules.map(r=>r.id)});
  if(closeTabs) {
    const {otiumTabs=[]}=await chrome.storage.session.get('otiumTabs');
    // Leave tabs open if the user navigated away after review.
    for(const entry of otiumTabs.filter(t=>t.batchId===batchId)) {
      const tab=await chrome.tabs.get(entry.id).catch(()=>null);
      if(tab && (tab.url===entry.url || tab.pendingUrl===entry.url))await chrome.tabs.remove(entry.id).catch(()=>{});
    }
    await chrome.storage.session.set({otiumTabs:otiumTabs.filter(t=>t.batchId!==batchId)});
  }
}

let storageChain=Promise.resolve();
function remember(entry) {
  const next=storageChain.catch(()=>{}).then(async()=>{
    const {otiumTabs=[]}=await chrome.storage.session.get('otiumTabs');
    await chrome.storage.session.set({otiumTabs:[...otiumTabs.filter(t=>t.id!==entry.id),entry]});
  });
  storageChain=next;return next;
}

async function waitForTab(tabId){
  for(let i=0;i<75;i++){
    const tab=await chrome.tabs.get(tabId);
    if(tab.status==='complete' && tab.url && tab.url!=='about:blank')return tab;
    await delay(400);
  }
  throw Error('navigation_timeout');
}
function allowedTarget(value){
  try{const u=new URL(value);return !u.username&&!u.password&&(u.protocol==='https:' || (u.origin===app&&/^\/demo\/apply\/[12]$/.test(u.pathname)));}catch{return false;}
}
const workday=host=>/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/.test(host);
function trustedApplyLink(start,dest) {
  if(!allowedTarget(dest))return false;
  const a=new URL(start),b=new URL(dest);
  if(a.origin===b.origin)return /(?:^|[/?&=_-])apply(?:$|[/?&=_-])/i.test(b.pathname+b.search);
  if(a.hostname==='careers.nba.com' && workday(b.hostname) && b.hostname.startsWith('nba.')){
    const req=a.pathname.match(/\bJR\d+\b/i)?.[0];
    return Boolean(req && b.pathname.includes(req));
  }
  return false;
}

async function inspect(tabId){
  return script(tabId,()=>{
    const visible=el=>el.getClientRects().length && getComputedStyle(el).visibility==='visible';
    const buttons=Array.from(document.querySelectorAll('a[href]')).filter(el=>visible(el) && /^(?:apply(?: now| for this job)?|start your application)$/i.test((el.getAttribute('aria-label')||el.textContent||'').trim()));
    const controls=Array.from(document.querySelectorAll('input,textarea,select')).filter(visible);
    return {auth:controls.some(el=>el.type==='password'||el.autocomplete==='one-time-code'),links:[...new Set(buttons.map(a=>a.href))].slice(0,8),
      closed:/job you are trying to apply for is no longer accepting applications|job is no longer available/i.test(document.body.innerText),
      fields:controls.filter(el=>!['submit','reset','button','hidden','search'].includes(el.type)).length,
      workdayStart:Array.from(document.querySelectorAll('button')).some(el=>visible(el)&&el.textContent.trim()==='Apply Manually')};
  });
}

async function prepare({batchId,ticket,windowId,job,profile,resume,provider}, focus) {
  let tabId, result;
  try {
    if(!allowedTarget(job.url))throw Error('unsupported_destination');
    const tab=await chrome.tabs.create({windowId,url:job.url,active:focus});
    tabId=tab.id;
    if(focus)await chrome.windows.update(windowId,{focused:true}).catch(()=>{});
    await remember({id:tabId,batchId,url:job.url});
    let loaded=await waitForTab(tabId);
    if(!allowedTarget(loaded.url) || (new URL(loaded.url).origin!==new URL(job.url).origin && !trustedApplyLink(job.url,loaded.url)))throw Error('destination_changed');
    let page=await inspect(tabId);
    const links=page.links.filter(url=>url!==loaded.url&&trustedApplyLink(loaded.url,url));
    if(!page.auth&&page.fields<2&&links.length===1){
      await chrome.tabs.update(tabId,{url:links[0]});
      loaded=await waitForTab(tabId);
      if(!allowedTarget(loaded.url)||new URL(loaded.url).origin!==new URL(links[0]).origin)throw Error('destination_changed');
      page=await inspect(tabId);
    }
    if(page.workdayStart && workday(new URL(loaded.url).hostname)){
      const original=loaded.url;
      await script(tabId,expected=>{
        if(location.href!==expected)return;
        const choices=Array.from(document.querySelectorAll('button')).filter(el=>el.getClientRects().length&&el.textContent.trim()==='Apply Manually'&&(!el.form||el.type==='button'));
        if(choices.length===1)choices[0].click();
      },[original]);
      for(let i=0;i<12;i++){
        await delay(350);
        loaded=await waitForTab(tabId);
        if(new URL(loaded.url).origin!==new URL(original).origin)throw Error('destination_changed');
        page=await inspect(tabId);
        if(page.auth || page.fields>=2)break;
      }
    }
    await remember({id:tabId,batchId,url:loaded.url});
    if(page.closed)result=empty('blocked','posting_closed');
    else if(page.auth)result=empty('blocked','sign_in_in_chrome_then_resume_manually');
    else if(provider==='simplify'){
      // Copilot needs its ordinary network access. Do not apply the built-in
      // worker's tab freeze, and do not hand any Otium profile data to Copilot.
      const reason=await script(tabId,fillWithCopilot,[loaded.url]);
      result=empty(reason==='simplify_autofill_started'?'review':'blocked',reason??'simplify_autofill_unavailable');
    }
    else if(page.fields<2)result=empty('blocked','open_the_direct_application_form');
    else{
      await guard(tabId);
      await chrome.scripting.executeScript({target:{tabId},files:['worker.bundle.js']});
      result=await script(tabId,async payload=>globalThis.otiumRunInTab(payload),[{profile,job,resume,expectedUrl:loaded.url}]);
    }
  }catch(error){
    if(tabId)await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[tabId+1]}).catch(()=>{});
    result=empty('error',['unsupported_destination','destination_changed','navigation_timeout'].includes(error.message)?error.message:'could_not_fill_in_chrome');
  }
  await api('complete',{batchId,ticket,result:result??empty('error','chrome_worker_failed')}).catch(()=>{});
}

async function poll(windowId) {
  const config=await chrome.storage.local.get(['otiumConnected','otiumWindowId']);
  if(!config.otiumConnected)return;
  let targetWindow=Number.isInteger(windowId)?windowId:config.otiumWindowId;
  if(!Number.isInteger(targetWindow) || !await chrome.windows.get(targetWindow).then(w=>w.type==='normal',()=>false)){
    targetWindow=(await chrome.windows.getLastFocused({windowTypes:['normal']}).catch(()=>null))?.id;
  }
  const data=await api('poll',{windowId:targetWindow,capabilities:['simplify-copilot']});
  lastFailure=0;
  if(data.status==='reviewing'||data.status==='closed'||data.status==='idle')await releaseGuards(data.status==='closed',data.batchId);
  // Lease a bounded set in the server, then dispatch one independent worker per tab.
  const focus=data.jobs.length>0&&focusedBatch!==data.batchId;
  if(focus)focusedBatch=data.batchId;
  void Promise.allSettled(data.jobs.map((task,index)=>prepare(task,focus&&index===0)));
}
function tick(windowId) {
  if(!pollInFlight)pollInFlight=poll(windowId).catch(async error=>{
    if(!lastFailure)lastFailure=Date.now();
    if(Date.now()-lastFailure>30000){await releaseGuards().catch(()=>{});clearInterval(timer);timer=null;}
    throw error;
  }).finally(()=>{pollInFlight=null;});
  return pollInFlight;
}
function keepPolling(){if(!timer)timer=setInterval(()=>void tick().catch(()=>{}),1500);}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type==='otium-pulse' && sender.url===app+'/'){
    void tick(sender.tab?.windowId).then(()=>reply({ok:true}),()=>reply({ok:false}));return true;
  }
  if(message?.type==='otium-connect' && sender.url===chrome.runtime.getURL('popup.html')){
    void (async()=>{
      await chrome.storage.local.set({otiumConnected:true,otiumWindowId:message.windowId});
      await chrome.alarms.create(pulseAlarm,{periodInMinutes:0.5});
      await tick(message.windowId);keepPolling();reply({ok:true});
    })().catch(()=>reply({ok:false,error:'Could not connect. Start Otium and check that no other Chrome profile is connected.'}));
    return true;
  }
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===pulseAlarm)void tick().then(keepPolling,()=>{});});
chrome.runtime.onStartup.addListener(()=>{void chrome.alarms.create(pulseAlarm,{periodInMinutes:0.5});void tick().then(keepPolling,()=>{});});
chrome.tabs.onRemoved.addListener(id=>{void chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[id+1]}).catch(()=>{});});
