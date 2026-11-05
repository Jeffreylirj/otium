import { randomUUID } from 'node:crypto';
import { redactUrl } from './input.mjs';

const statusValues = new Set(['review','blocked','error']);
const resultFields = list => Array.isArray(list) ? list.slice(0,250).filter(x=>typeof x?.label==='string').map(x=>({
  label:x.label.slice(0,240),required:Boolean(x.required),...(typeof x.reason==='string'?{reason:x.reason.slice(0,100)}:{})
})) : [];

export function createChromeQueue() {
  let owner, lastSeen = 0, batch, simplifyReady=false;
  const connected = () => Boolean(owner && Date.now()-lastSeen<45000);
  function settle() {
    if(!batch || batch.status!=='running') return;
    for(const item of batch.items) if(item.lease && !item.result && Date.now()-item.lease>120000) {
      item.result={status:'error',reason:'chrome_worker_timed_out',filled:[],missing:[],coverage:null};
    }
    if(Date.now()-lastSeen>90000) for(const item of batch.items) if(!item.result) {
      item.result={status:'error',reason:'chrome_companion_disconnected',filled:[],missing:[],coverage:null};
    }
    if(batch.items.every(item=>item.result)) {
      batch.status='ready';
      batch.profile=null;
      batch.resume=null;
      for(const item of batch.items) item.job.answers={};
    }
  }
  function state() {
    settle();
    return {chromeConnected:connected(),simplifyReady:connected()&&simplifyReady,transport:'chrome-extension',status:batch?.status??'idle',id:batch?.id??null,error:null,
      progress:batch?{done:batch.items.filter(x=>x.result).length,total:batch.items.length}:null,
      results:batch?.items.filter(item=>item.result).map(item=>({id:item.job.id,url:redactUrl(item.job.url),provider:batch.provider,...item.result}))??[]};
  }
  return {
    state,
    start(jobs, profile, resume, concurrency, provider='local') {
      if(!connected()) return 'Connect the Otium extension in your regular Chrome first.';
      if(provider==='simplify'&&!simplifyReady) return 'Reload Otium Chrome Companion in chrome://extensions to enable Simplify.';
      if(batch && batch.status!=='closed') return 'Close the current batch first.';
      batch={id:randomUUID(),status:'running',provider,profile:provider==='simplify'?null:profile,resume:provider==='simplify'?null:resume,concurrency,
        items:jobs.map(job=>({job:provider==='simplify'?{id:job.id,url:job.url,answers:{}}:job,lease:0,ticket:null,result:null}))};
    },
    review() { if(batch?.status!=='ready') return false; batch.status='reviewing'; return true; },
    close() { if(batch?.status==='running') return false; if(batch) {batch.status='closed';batch.profile=null;batch.resume=null;} return true; },
    poll(origin, windowId, capabilities) {
      if(owner && owner!==origin && (connected() || batch?.status==='running')) return null;
      owner=origin;lastSeen=Date.now();
      simplifyReady=Array.isArray(capabilities)&&capabilities.includes('simplify-copilot');
      settle();
      const jobs=[];
      if(batch?.status==='running' && (batch.provider!=='simplify'||simplifyReady) && Number.isInteger(windowId) && windowId>=0) {
        const free=batch.concurrency-batch.items.filter(item=>item.lease&&!item.result).length;
        for(const item of batch.items.filter(item=>!item.lease).slice(0,Math.max(0,free))) {
          item.lease=Date.now();item.ticket=randomUUID();
          const job=batch.provider==='simplify'?{id:item.job.id,url:item.job.url}:item.job;
          jobs.push({batchId:batch.id,ticket:item.ticket,windowId,job,provider:batch.provider,profile:batch.profile,resume:batch.resume});
        }
      }
      return {batchId:batch?.id??null,status:batch?.status??'idle',jobs};
    },
    complete(origin, {batchId,ticket,result}) {
      if(!owner || owner!==origin || batch?.status!=='running' || batch.id!==batchId || typeof ticket!=='string' || !statusValues.has(result?.status)) return false;
      const item=batch.items.find(x=>x.ticket===ticket && !x.result);
      if(!item) return false;
      item.result={status:result.status,filled:resultFields(result.filled),missing:resultFields(result.missing),
        coverage:typeof result.coverage==='number' && Number.isFinite(result.coverage)?Math.min(100,Math.max(0,result.coverage)):null,
        ...(typeof result.reason==='string'?{reason:result.reason.slice(0,100)}:{})};
      settle(); return true;
    }
  };
}
