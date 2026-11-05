const $ = id => document.getElementById(id);
const profileKeys=['firstName','lastName','email','phone','city','country','university','major','linkedin','portfolio'];
let state=null, signature='', busy=false;
const showError=message=>{$('error').textContent=message||'';$('error').hidden=!message;};
async function api(path,body) {
 const response=await fetch(path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Otium-Token':state?.csrf||''},body:JSON.stringify(body)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to complete that action.');return result;
}
function node(tag,cls,text){const element=document.createElement(tag);if(cls)element.className=cls;if(text!==undefined)element.textContent=text;return element;}
function render(next){
 state=next; const stamp=JSON.stringify(next);if(stamp===signature)return;signature=stamp;
 const active=['running','ready','reviewing'].includes(next.status);
 $('prepare').disabled=active||busy;$('demo').disabled=active||busy;$('empty-demo').disabled=active||busy;
 $('status').textContent=({idle:'Ready to start',running:'Preparing…',ready:'Ready for review',reviewing:'Manual review enabled',closed:'Batch closed',error:'Needs attention'})[next.status]||next.status;
 $('empty').hidden=active||next.results.length>0;
 $('progress').hidden=next.status!=='running';
 $('progress-text').textContent=next.progress ? `Preparing application ${Math.min(next.progress.done+1,next.progress.total)} of ${next.progress.total}. Chrome opens separately.`:'Starting Chrome…';
 $('progress-bar').max=next.progress?.total||1;$('progress-bar').value=next.progress?.done||0;
 $('handoff').hidden=!['ready','reviewing'].includes(next.status);
 $('review').hidden=next.status==='reviewing';
 $('handoff-note').textContent=next.status==='reviewing'?'Manual review is enabled. Check your answers, complete the gaps and submit each application yourself. Closing the batch can discard unsaved drafts.':'Your drafts are ready. Enable manual review, then check every answer in Chrome before submitting.';
 $('results').replaceChildren();
 for(const result of next.results){
  const article=node('article','result');article.dataset.jobId=result.id;
  const head=node('div','result-head'),text=node('div');text.append(node('h3','',result.id),node('p','result-url',result.url));
  const score=node('div','coverage',result.coverage===null?'—':Math.round(result.coverage)+'%');score.title='Completed visible required fields on scanned pages';const scoreGroup=node('div','coverage-wrap');scoreGroup.append(score,node('span','fine','required complete'));head.append(text,scoreGroup);article.append(head,node('span','status',result.status==='review'?'Ready to check':result.status==='blocked'?'Needs manual input':'Could not prepare'));
  article.append(node('p','',`${result.filled.length} fields filled · ${result.missing.filter(f=>f.required).length} required gaps`));
  if(result.reason)article.append(node('p','fine',result.reason.replaceAll('_',' ')));
  const details=node('details'),summary=node('summary','', 'See filled fields and questions');details.append(summary);
  for(const [title,fields]of[['Filled',result.filled],['Needs your input',result.missing]]){
   if(!fields.length)continue;details.append(node('p','',title));const list=node('ul');
   for(const field of fields)list.append(node('li','',(field.page?'Step '+field.page+' · ':'')+field.label+(field.reason?' — '+field.reason.replaceAll('_',' '):'')));
   details.append(list);
  }
  article.append(details);$('results').append(article);
 }
 if(next.error)showError(next.error);
}
async function refresh(){try{render(await api('/api/state'));}catch{showError('Otium is not reachable. Start it with npm run ui, then reload this page.');}}
async function start(demo){
 if(busy||!state)return;busy=true;showError('');
 try{
  let payload={demo:true};
  if(!demo){
   const advanced=$('workflow').value.trim();
   const jobs=advanced?JSON.parse(advanced):$('jobs').value.split(/\n/).map(s=>s.trim()).filter(Boolean).map((url,i)=>({id:'application-'+(i+1),url}));
   const answers=Object.fromEntries(profileKeys.map(k=>[k,$(k).value.trim()]).filter(([,v])=>v));
   const customAnswers=$('answers').value.trim()?JSON.parse($('answers').value):{};
   payload={jobs,profile:{answers,customAnswers},concurrency:Number($('concurrency').value)};
   const file=$('resume').files[0];
   if(file){
    if(file.size>10*1024*1024||!file.name.toLowerCase().endsWith('.pdf'))throw Error('Choose a PDF smaller than 10 MB.');
    const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Could not read that file.'));reader.readAsDataURL(file);});
    payload.resume={base64};
   }
  }
  render(await api('/api/run',payload));
 }catch(error){showError(error instanceof SyntaxError?'Check the JSON in advanced workflows or reusable answers.':error.message);}
 finally{busy=false;signature='';if(state)render({...state});}
}
$('batch-form').addEventListener('submit',event=>{event.preventDefault();void start(false);});
$('demo').addEventListener('click',()=>void start(true));$('empty-demo').addEventListener('click',()=>void start(true));
$('review').addEventListener('click',async()=>{try{render(await api('/api/review',{}));}catch(e){showError(e.message);}});
$('close').addEventListener('click',async()=>{try{render(await api('/api/close',{}));showError('');}catch(e){showError(e.message);}});
void refresh();setInterval(()=>void refresh(),1000);
