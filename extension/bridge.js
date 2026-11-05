if (location.origin==='http://127.0.0.1:4317' && location.pathname==='/') {
  const pulse=()=>chrome.runtime.sendMessage({type:'otium-pulse'}).catch(()=>{});
  void pulse();
  setInterval(pulse,1200);
}
