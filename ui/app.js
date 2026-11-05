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
 const regular=next.transport==='chrome-extension';
 $('chrome-setup').hidden=!regular;
 $('chrome-connection').textContent=!next.chromeConnected?'Chrome companion not connected':next.simplifyReady?'Regular Chrome connected':'Reload Chrome companion for Simplify';
 $('chrome-help').hidden=Boolean(next.chromeConnected&&next.simplifyReady);
 $('workflow-options').hidden=regular;
 $('copilot-note').hidden=!regular;
 $('local-profile').hidden=regular;
 $('resume-help').textContent=regular?'Stages the selected PDF in a recognized resume field. Verify the attachment before submitting.':'Used only by an explicitly configured upload step.';
 $('prepare').disabled=active||busy;$('demo').disabled=active||busy;$('empty-demo').disabled=active||busy;
 $('status').textContent=({idle:'Ready to start',running:'Preparing…',ready:'Ready for review',reviewing:'Manual review enabled',closed:'Batch closed',error:'Needs attention'})[next.status]||next.status;
 $('empty').hidden=active||next.results.length>0;
 $('progress').hidden=next.status!=='running';
 $('progress-text').textContent=next.progress ? `Preparing application ${Math.min(next.progress.done+1,next.progress.total)} of ${next.progress.total}. ${regular?'Workers are using your regular Chrome.':'Chrome opens separately.'}`:'Starting browser workers…';
 $('progress-bar').max=next.progress?.total||1;$('progress-bar').value=next.progress?.done||0;
 $('handoff').hidden=!['ready','reviewing'].includes(next.status);
 $('review').hidden=next.status==='reviewing';
 $('handoff-note').textContent=next.status==='reviewing'?'Manual review is enabled. Check your answers, complete the gaps and submit each application yourself. Closing the batch can discard unsaved drafts.':'Your drafts are ready. Enable manual review, then check every answer in Chrome before submitting.';
 $('results').replaceChildren();
 for(const result of next.results){
  const article=node('article','result');article.dataset.jobId=result.id;
  const head=node('div','result-head'),text=node('div');text.append(node('h3','',result.id),node('p','result-url',result.url));
  if(result.provider!=='simplify'){
   const score=node('div','coverage',result.coverage===null?'—':Math.round(result.coverage)+'%');score.title='Completed visible required fields on scanned pages';const scoreGroup=node('div','coverage-wrap');scoreGroup.append(score,node('span','fine','required complete'));head.append(text,scoreGroup);
  }else head.append(text,node('span','fine','Simplify Copilot'));
  article.append(head,node('span','status',result.status==='review'?(result.provider==='simplify'?'Copilot started':'Ready to check'):result.status==='blocked'?'Needs manual input':'Could not prepare'));
  if(result.provider!=='simplify')article.append(node('p','',`${result.filled.length} fields filled · ${result.missing.filter(f=>f.required).length} required gaps`));
  const messages={simplify_autofill_started:'Copilot started. Review the answers and attachments in Chrome when it finishes.',
    simplify_start_unconfirmed:'Otium clicked Autofill this page but could not confirm that Copilot started. Check the panel in Chrome.',
    simplify_panel_not_found:'No accessible Copilot panel appeared. Check that Simplify is installed, enabled, and signed in, and that this is the actual application form.',
    simplify_autofill_unavailable:'Copilot did not expose an enabled Autofill this page control. Check the panel in Chrome.',
    simplify_control_ambiguous:'More than one Copilot fill control was visible. Select the intended control manually.',
    sign_in_in_chrome_then_retry:'This employer requires sign-in. Sign in in Chrome, then use Copilot on the application form.',
    sign_in_in_chrome_then_resume_manually:'This employer requires sign-in. Sign in in Chrome, then use Copilot on the application form.',
    posting_closed:'The employer says this posting is closed.'};
  if(result.reason)article.append(node('p','',messages[result.reason]||result.reason.replaceAll('_',' ')));
  if(result.provider==='simplify'){$('results').append(article);continue;}
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
   const advanced=state.transport==='chrome-extension'?'':$('workflow').value.trim();
   const jobs=advanced?JSON.parse(advanced):$('jobs').value.split(/\n/).map(s=>s.trim()).filter(Boolean).map((url,i)=>({id:'application-'+(i+1),url}));
   payload={jobs,concurrency:Number($('concurrency').value)};
   if(state.transport!=='chrome-extension'){
    const answers=Object.fromEntries(profileKeys.map(k=>[k,$(k).value.trim()]).filter(([,v])=>v));
    const customAnswers=$('answers').value.trim()?JSON.parse($('answers').value):{};
    payload.profile={answers,customAnswers};
   }
   const file=state.transport==='chrome-extension'?null:$('resume').files[0];
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
