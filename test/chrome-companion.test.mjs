import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createOtiumServer } from '../src/server.mjs';
import { createChromeQueue } from '../src/chrome-queue.mjs';

test('regular Chrome queue leases only the requested concurrency and accepts results only from its companion',()=>{
  const queue=createChromeQueue(),origin='chrome-extension://'+ 'a'.repeat(32);
  const jobs=[1,2,3].map(id=>({id:String(id),url:'https://example.test/apply/'+id}));
  assert.match(queue.start(jobs,{},null,2),/Connect/);
  queue.poll(origin,1);
  assert.equal(queue.start(jobs,{answers:{firstName:'Synthetic'}},null,2),undefined);
  const batch=queue.poll(origin,1);
  assert.equal(batch.jobs.length,2);
  assert.equal(queue.poll(origin,1).jobs.length,0);
  const task=batch.jobs[0];
  const result={status:'review',filled:[{label:'First name',required:true,value:'Synthetic'}],missing:[],coverage:100};
  assert.equal(queue.complete('chrome-extension://'+ 'b'.repeat(32),{...task,result}),false);
  assert.equal(queue.complete(origin,{...task,result}),true);
  assert.equal(queue.complete(origin,{...task,result}),false);
  assert.equal(queue.poll(origin,1).jobs.length,1);
  assert.equal(JSON.stringify(queue.state()).includes('Synthetic'),false);
});

test('Simplify jobs require a compatible companion and never lease Otium answer or resume data',()=>{
  const queue=createChromeQueue(),origin='chrome-extension://'+ 'a'.repeat(32);
  const jobs=[{id:'one',url:'https://example.test/apply',answers:{city:'Synthetic'}}];
  queue.poll(origin,1);
  assert.match(queue.start(jobs,{},null,1,'simplify'),/Reload/);
  queue.poll(origin,1,['simplify-copilot']);
  assert.equal(queue.start(jobs,{answers:{name:'Synthetic'}},{base64:'fake'},1,'simplify'),undefined);
  assert.equal(queue.poll(origin,1).jobs.length,0,'old worker does not receive Simplify jobs');
  const [task]=queue.poll(origin,1,['simplify-copilot']).jobs;
  assert.equal(task.provider,'simplify');
  assert.deepEqual(task.job,{id:'one',url:'https://example.test/apply'});
  assert.equal(task.profile,null);
  assert.equal(task.resume,null);
});

test('Chrome companion runs the local demo and delegates real batches to Copilot controls', {skip:process.env.OTIUM_TEST_CHROME_EXTENSION!=='1',timeout:60000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'otium-companion-'));
  const app=createOtiumServer();
  let context;
  try{
    app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
    const origin='http://127.0.0.1:'+app.server.address().port;
    const ext=join(dir,'extension');
    execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/build-chrome.mjs',import.meta.url))]);
    await cp(new URL('../extension/',import.meta.url),ext,{recursive:true});
    for(const name of ['background.js','bridge.js','popup.js']){
      const path=join(ext,name);
      await writeFile(path,(await readFile(path,'utf8')).replaceAll('http://127.0.0.1:4317',origin));
    }
    context=await chromium.launchPersistentContext(join(dir,'profile'),{
      channel:'chromium',headless:true,args:['--disable-extensions-except='+ext,'--load-extension='+ext]
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const control=context.pages()[0]||await context.newPage();
    await control.goto(origin);
    const windowId=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return tab.windowId;});
    // Simulate user-approved pairing in this disposable profile. Demo sites
    // require only the manifest's localhost access, not broad site permission.
    await worker.evaluate(async id=>chrome.storage.local.set({otiumConnected:true,otiumWindowId:id}),windowId);
    await control.getByText('Regular Chrome connected',{exact:true}).waitFor({timeout:12000});
    await control.getByRole('button',{name:'Try demo',exact:true}).click();
    await control.getByText('Ready for review',{exact:true}).waitFor({timeout:18000});
    const state=await (await control.request.get(origin+'/api/state')).json();
    assert.equal(state.transport,'chrome-extension');
    assert.equal(state.results.length,2,JSON.stringify(state.results));
    assert.ok(state.results.every(job=>job.status==='review'&&job.filled.some(f=>f.label==='First name')),JSON.stringify(state.results));
    const tabs=context.pages().filter(p=>p.url().startsWith(origin+'/demo/apply/'));
    assert.equal(tabs.length,2);
    assert.equal(await tabs[0].locator('[name=first_name]').inputValue(),'Alex');
    assert.equal(await tabs[0].getByRole('checkbox').isChecked(),false);
    assert.equal(await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).length),2);
    assert.equal(await tabs[0].evaluate(async()=>fetch(location.href).then(()=>false,()=>true)),true);
    await control.getByRole('button',{name:'Enable manual review',exact:true}).click();
    await control.getByText('Manual review enabled',{exact:true}).waitFor();
    await control.waitForFunction(()=>document.getElementById('review').hidden);
    const end=Date.now()+7000;
    while(Date.now()<end && await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).length)) await new Promise(r=>setTimeout(r,200));
    assert.equal(await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).length),0);
    assert.equal(await tabs[0].evaluate(async()=> (await fetch(location.href)).ok),true);
    await control.getByRole('button',{name:'Close batch',exact:true}).click();
    await control.getByText('Batch closed',{exact:true}).waitFor();
    await Promise.all(tabs.map(tab=>tab.isClosed()?null:tab.waitForEvent('close',{timeout:6000})));
    assert.equal(control.isClosed(),false);

    // Simulate only Copilot's publicly visible UI in a local fixture. Do not
    // run the user's actual extension against an employer during tests.
    const [handleRequest]=app.server.listeners('request');
    app.server.removeListener('request',handleRequest);
    app.server.on('request',(req,res)=>{
      if(!/^\/demo\/apply\/[12]$/.test(req.url))return handleRequest(req,res);
      const signIn=req.url.endsWith('/2');
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
      res.end(`<!doctype html><label>First name <input id="given"></label>
        <label>Last name <input id="family"></label><button id="submit">Submit application</button>
        <script>
          window.calls={fill:0,account:0,autopilot:0,submit:0};
          document.querySelector('#submit').onclick=()=>calls.submit++;
          const host=document.createElement('div');host.className='simplify-jobs-shadow-root';document.body.append(host);
          const root=host.attachShadow({mode:'open'});
          root.innerHTML='<button aria-label="Show fill prompt">Open</button>';
          root.querySelector('button').onclick=()=>{
            root.innerHTML='<button id="autopilot">Autopilot</button>'+(${JSON.stringify(signIn)}
              ? '<button id="account-fill-button">Sign in and autofill</button>'
              : '<button id="fill-button" aria-label="Autofill this page">Autofill This Page</button>');
            root.querySelector('#autopilot').onclick=()=>calls.autopilot++;
            const account=root.querySelector('#account-fill-button');
            if(account)account.onclick=()=>calls.account++;
            const fill=root.querySelector('#fill-button');
            if(fill)fill.onclick=()=>{calls.fill++;document.querySelector('#given').value='Synthetic Copilot';};
          };
        </script>`);
    });
    await control.locator('#jobs').fill(origin+'/demo/apply/1\n'+origin+'/demo/apply/2');
    await control.getByRole('button',{name:'Prepare applications',exact:true}).click();
    await control.getByText('Ready for review',{exact:true}).waitFor({timeout:20000});
    const copilotState=await (await control.request.get(origin+'/api/state')).json();
    assert.deepEqual(copilotState.results.map(job=>[job.provider,job.reason]),[
      ['simplify','simplify_autofill_started'],['simplify','sign_in_in_chrome_then_retry']
    ]);
    const first=context.pages().find(p=>p.url()===origin+'/demo/apply/1');
    const second=context.pages().find(p=>p.url()===origin+'/demo/apply/2');
    assert.deepEqual(await first.evaluate(()=>window.calls),{fill:1,account:0,autopilot:0,submit:0});
    assert.deepEqual(await second.evaluate(()=>window.calls),{fill:0,account:0,autopilot:0,submit:0});
    assert.equal(await first.locator('#given').inputValue(),'Synthetic Copilot');
    assert.equal(await second.locator('#given').inputValue(),'');
    assert.equal(await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).length),0);
  }finally{
    await context?.close();
    await app.close();
    await rm(dir,{recursive:true,force:true});
  }
});
