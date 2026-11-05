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

test('Prepare applications dispatches real extension workers into the same Chrome window', {skip:process.env.OTIUM_TEST_CHROME_EXTENSION!=='1',timeout:45000},async()=>{
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
    await control.locator('#jobs').fill(origin+'/demo/apply/1\n'+origin+'/demo/apply/2');
    await control.locator('#firstName').fill('Alex');
    await control.getByRole('button',{name:'Prepare applications',exact:true}).click();
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
  }finally{
    await context?.close();
    await app.close();
    await rm(dir,{recursive:true,force:true});
  }
});
