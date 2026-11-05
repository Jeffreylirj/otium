// Runs in an isolated Chrome world. Use only Copilot's visible, documented
// controls. Do not read its account data, call its APIs, or select Autopilot.
export async function fillWithCopilot(expectedUrl) {
  const clean=s=>String(s??'').replace(/\s+/g,' ').trim().toLowerCase();
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const visible=el=>{
    if(!el?.isConnected||el.closest('[hidden],[inert],[aria-hidden=true]'))return false;
    const r=el.getBoundingClientRect(),style=getComputedStyle(el);
    return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&
      style.visibility==='visible'&&style.display!=='none'&&Number(style.opacity)>0;
  };
  const clickable=el=>visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&
    !el.form&&el.tagName==='BUTTON';
  const roots=()=>[...document.querySelectorAll('.simplify-jobs-shadow-root')].slice(0,20)
    .map(host=>host.shadowRoot).filter(Boolean);
  const fillButtons=panels=>panels.flatMap(panel=>[...panel.querySelectorAll('button#fill-button[aria-label]')])
    .filter(el=>clean(el.getAttribute('aria-label'))==='autofill this page');
  const formValues=()=>[...document.querySelectorAll('input,select,textarea')].slice(0,250)
    .filter(el=>!['hidden','password','submit','button','reset'].includes(el.type)&&el.getClientRects().length)
    .map(el=>['radio','checkbox'].includes(el.type)?el.checked:el.value);
  const applicationSignIn=()=>[...document.querySelectorAll('input[type=password],input[autocomplete=one-time-code]')].some(visible);
  let opened=false, seenPanel=false;
  for(let attempt=0;attempt<24;attempt++){
    if(location.href!==expectedUrl)return 'destination_changed';
    if(applicationSignIn())return 'sign_in_in_chrome_then_retry';
    const panels=roots();
    seenPanel||=panels.length>0;
    const buttons=fillButtons(panels).filter(clickable);
    if(buttons.length>1)return 'simplify_control_ambiguous';
    if(buttons.length===1){
      // A new application tab can be in the background. Never focus or
      // trigger an employer action, and never click a second fill button.
      const before=formValues();
      buttons[0].click();
      let started=false, quiet=0;
      for(let check=0;check<28;check++){
        await wait(500);
        if(location.href!==expectedUrl)return started?'simplify_autofill_started':'simplify_start_unconfirmed';
        const current=fillButtons(roots());
        const busy=current.some(el=>el.disabled||el.getAttribute('aria-disabled')==='true'||el.getAttribute('aria-busy')==='true') ||
          roots().some(panel=>[...panel.querySelectorAll('[role=status],[aria-live],button')].some(el=>
            visible(el)&&/^(?:autofilling|filling (?:your |the |this )?application|filling fields)\b/i.test(clean(el.textContent))));
        const changed=JSON.stringify(before)!==JSON.stringify(formValues());
        started||=busy||changed;
        quiet=started&&!busy?quiet+1:0;
        if(quiet>=3)return 'simplify_autofill_started';
        if(check>=7&&!started)return 'simplify_start_unconfirmed';
      }
      return started?'simplify_autofill_started':'simplify_start_unconfirmed';
    }
    const account=panels.some(panel=>[...panel.querySelectorAll('button#account-fill-button')].some(visible));
    if(account)return 'sign_in_in_chrome_then_retry';
    if(!opened){
      const openers=panels.flatMap(panel=>[...panel.querySelectorAll('button[aria-label]')]).filter(el=>
        clickable(el)&&clean(el.getAttribute('aria-label'))==='show fill prompt');
      if(openers.length===1){openers[0].click();opened=true;}
    }
    await wait(500);
  }
  return seenPanel?'simplify_autofill_unavailable':'simplify_panel_not_found';
}
