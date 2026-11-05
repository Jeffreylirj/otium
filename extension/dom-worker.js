// Bundled with the shared autofill engine. The adapter operates in Chrome's
// isolated extension world; employer code cannot read our local worker state.
function locator(get) {
  const one=()=>{const items=get();if(items.length!==1)throw Error('ambiguous control');return items[0];};
  const visible=el=>el.getClientRects().length>0 && getComputedStyle(el).visibility==='visible';
  const validClick=el=>{
    if(el.matches('a[href],input[type=submit],input[type=image],button[type=submit]') ||
      (el instanceof HTMLButtonElement && el.form && el.type!=='button') || el.matches(':disabled,[aria-disabled=true]')) throw Error('unsafe control');
    el.click();
  };
  const set=(el,value)=>{
    const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);
    el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  };
  return {
    count:async()=>get().length, evaluate:async fn=>fn(one()),evaluateAll:async fn=>fn(get()),
    nth:i=>locator(()=>get().slice(i,i+1)),
    locator:s=>locator(()=>get().flatMap(el=>Array.from(el.querySelectorAll(s)))),
    filter:({visible:show})=>locator(()=>get().filter(el=>!show||visible(el))),
    getAttribute:async name=>one().getAttribute(name),innerText:async()=>one().innerText,
    isEnabled:async()=>!one().matches(':disabled,[aria-disabled=true]'),
    click:async()=>validClick(one()),
    check:async()=>{const el=one();if(!el.checked)validClick(el);},
    setChecked:async want=>{const el=one();if(el.checked!==want)validClick(el);},
    fill:async value=>set(one(),value),selectOption:async ({value})=>set(one(),value),
    press:async key=>one().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}))
  };
}
globalThis.otiumRunInTab=async ({profile,job,resume,expectedUrl})=>{
  if(location.href!==expectedUrl) return {status:'blocked',reason:'destination_changed',filled:[],missing:[],coverage:null};
  const formWindow={url:()=>location.href,locator:s=>locator(()=>Array.from(document.querySelectorAll(s))),
    waitForTimeout:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
  const page={url:formWindow.url,frames:()=>[formWindow],mainFrame:()=>formWindow};
  const block=event=>{event.preventDefault();event.stopImmediatePropagation();};
  globalThis.otiumRelease?.();
  window.addEventListener('submit',block,true);
  globalThis.otiumRelease=()=>{window.removeEventListener('submit',block,true);delete globalThis.otiumRelease;};
  const result=await fillForm(page,profile,job);
  if(resume && result.status==='review' && location.href===expectedUrl){
    const matches=Array.from(document.querySelectorAll('input[type=file]')).filter(el=>
      !el.disabled && el.getClientRects().length && !el.files.length &&
      /^(?:resume|cv|curriculum vitae|upload resume|upload cv|resume cv)$/.test(normalize(
        el.getAttribute('aria-label')||Array.from(el.labels||[]).map(l=>l.textContent).join(' ')
      )));
    if(matches.length===1){
      try{
        const el=matches[0],transfer=new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(atob(resume.base64),c=>c.charCodeAt(0))],resume.name,{type:'application/pdf'}));
        el.files=transfer.files;
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        if(el.files.length)result.reason='resume_staged_locally_verify_upload';
      }catch{}
    }
  }
  return result;
};
