const status=document.getElementById('status');
document.getElementById('connect').addEventListener('click',async()=>{
  try{
    if (!await chrome.permissions.request({origins:['https://*/*']})) {
      status.textContent='Permission was declined. Otium cannot fill employer pages yet.';return;
    }
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const result=await chrome.runtime.sendMessage({type:'otium-connect',windowId:tab?.windowId});
    status.textContent=result?.ok?'Connected. Return to Otium and click Prepare applications.':result?.error||'Start the Otium local server first.';
  }catch{status.textContent='Start the Otium local server and try again.';}
});
document.getElementById('open').addEventListener('click',()=>chrome.tabs.create({url:'http://127.0.0.1:4317/'}));
