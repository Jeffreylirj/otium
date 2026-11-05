import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { parseJobs } from './input.mjs';
import { runBatch } from './run.mjs';
import { createChromeQueue } from './chrome-queue.mjs';

const root = fileURLToPath(new URL('../ui/', import.meta.url));
const demoProfile = { answers: { firstName:'Alex', lastName:'Example', email:'alex@example.test', phone:'4155550100', country:'United States', university:'Example University', major:'Computer Science', linkedin:'https://www.linkedin.com/in/example/' },
  customAnswers: { 'What interests you about this role?':'I enjoy building useful developer tools.' } };
const files = new Map([['/', ['index.html','text/html']], ['/chrome-setup',['chrome-setup.html','text/html']], ['/app.js',['app.js','text/javascript']], ['/style.css',['style.css','text/css']]]);

export function createOtiumServer({ headless = false, browserChannel = 'chrome', dataDir = resolve('.otium-ui'), transport = headless ? 'isolated' : 'chrome' } = {}) {
  const csrf = randomBytes(32).toString('hex');
  let run = null, browser = null, closing = false;
  const pending = new Set();
  const chromeQueue=createChromeQueue();
  const publicState = () => ({csrf, ...(transport==='chrome' ? chromeQueue.state() : {transport:'isolated',status:run?.status ?? 'idle', id:run?.id ?? null, results:run?.results ?? [], progress:run?.progress ?? null, error:run?.error ?? null})});
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (code, body) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };
    try {
      const address = server.address();
      const expectedHost = `127.0.0.1:${address?.port}`;
      if (req.headers.host !== expectedHost) return send(403,{error:'Use the printed 127.0.0.1 address.'});
      const path = new URL(req.url,'http://' + expectedHost).pathname;
      if (req.method === 'GET') {
        if (files.has(path)) {
          const [file,type]=files.get(path);
          res.writeHead(200,{'Content-Type':type+'; charset=utf-8'}); return res.end(await readFile(join(root,file)));
        }
        if (path === '/api/state') return send(200,publicState());
        if (/^\/demo\/apply\/[12]$/.test(path)) {
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
          return res.end(await readFile(join(root,'demo.html')));
        }
        return send(404,{error:'Not found'});
      }
      if (req.method !== 'POST') return send(405,{error:'Method not allowed'});
      const chromeAction=path.startsWith('/api/chrome/');
      const origin=req.headers.origin ?? '';
      const validOrigin=chromeAction ? transport==='chrome' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin) : origin==='http://'+expectedHost;
      if (!validOrigin || req.headers['x-otium-token'] !== csrf || req.headers['content-type'] !== 'application/json') return send(403,{error:'Use the Otium interface to perform this action.'});
      const chunks=[]; let size=0;
      for await (const chunk of req) {
        size+=chunk.length;
        if (size>15*1024*1024) { send(413,{error:'Request is too large.'}); req.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400,{error:'Enter valid JSON.'}); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400,{error:'Expected a JSON object.'});
      if (path==='/api/chrome/poll') {
        const response=chromeQueue.poll(origin,body.windowId);
        return response ? send(200,response) : send(409,{error:'Another Chrome profile is connected.'});
      }
      if (path==='/api/chrome/complete') return chromeQueue.complete(origin,body) ? send(200,{ok:true}) : send(409,{error:'This job is no longer active.'});
      if (path === '/api/run') {
        if (closing || pending.size) return send(409,{error:'Wait for the previous batch to finish closing.'});
        if (run && !['closed','error'].includes(run.status)) return send(409,{error:'Close the current batch before starting another.'});
        const profile=body.demo ? demoProfile : body.profile;
        if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.answers || typeof profile.answers !== 'object' || Array.isArray(profile.answers) ||
          (profile.customAnswers && (typeof profile.customAnswers !== 'object' || Array.isArray(profile.customAnswers)))) return send(400,{error:'Provide your profile details.'});
        const jobs=parseJobs(body.demo ? [1,2].map(n=>({id:'demo-'+n,url:'http://'+expectedHost+'/demo/apply/'+n})) : body.jobs,{regularChrome:transport==='chrome'});
        if (jobs.length>20) return send(400,{error:'Use up to 20 application links per batch in the interface.'});
        const concurrency=body.concurrency ?? 2;
        if (!Number.isInteger(concurrency) || concurrency<1 || concurrency>5) return send(400,{error:'Choose 1–5 parallel tabs.'});
        if(transport==='chrome' && jobs.some(job=>job.workflow.length || job.credentialEnv)) return send(400,{error:'Configured sign-ins and page transitions use the CLI. Use direct job URLs in regular Chrome.'});
        let resume;
        if (body.resume) {
          if (typeof body.resume.base64 !== 'string' || body.resume.base64.length>14*1024*1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.resume.base64)) return send(400,{error:'Choose a PDF smaller than 10 MB.'});
          resume=Buffer.from(body.resume.base64,'base64');
          if (resume.length>10*1024*1024 || resume.subarray(0,5).toString()!=='%PDF-') return send(400,{error:'Choose a valid PDF smaller than 10 MB.'});
        }
        if(transport==='chrome') {
          const error=chromeQueue.start(jobs,profile,resume?{name:'resume.pdf',base64:resume.toString('base64')}:null,concurrency);
          return error ? send(409,{error}) : send(202,publicState());
        }
        run={id:randomUUID(),status:'running',results:[],progress:{done:0,total:jobs.length},error:null,release:null};
        const active=run;
        const task=(async()=>{
          let resumePath, ownedBrowser;
          try {
            const dir=join(dataDir,active.id);
            await mkdir(dir,{recursive:true,mode:0o700});
            if (resume) { resumePath=join(dir,'resume.pdf'); await writeFile(resumePath,resume,{mode:0o600,flag:'wx'}); }
            ownedBrowser=await chromium.launch({channel:browserChannel,headless});
            browser=ownedBrowser;
            const context=await ownedBrowser.newContext({serviceWorkers:'block',acceptDownloads:false});
            const credentials=Object.fromEntries(jobs.filter(j=>j.credentialEnv).map(j=>[j.id,{email:process.env[j.credentialEnv+'_EMAIL'],password:process.env[j.credentialEnv+'_PASSWORD']}]));
            const result=await runBatch({context,jobs,profile,credentials,resumePath,outDir:dir,concurrency,
              onProgress:progress=>{active.progress=progress;}});
            active.results=result.results; active.release=result.releaseForReview;
            if (active.status !== 'closed') active.status='ready';
            ownedBrowser.once('disconnected',()=>{if (active.status!=='error') active.status='closed';});
          } catch { if (active.status!=='closed') {active.status='error';active.error='Could not prepare the batch. Check that Chrome is installed and the application links are valid.';} await ownedBrowser?.close().catch(()=>{}); }
          finally { if(resumePath) await rm(resumePath,{force:true}); }
        })();
        pending.add(task); task.finally(()=>pending.delete(task));
        return send(202,publicState());
      }
      if (path === '/api/review') {
        if(transport==='chrome') return chromeQueue.review() ? send(200,publicState()) : send(409,{error:'Wait for the batch to finish.'});
        if (run?.status!=='ready' || !run.release) return send(409,{error:'Wait for the batch to finish.'});
        await run.release(); run.release=null; run.status='reviewing'; return send(200,publicState());
      }
      if (path === '/api/close') {
        if(transport==='chrome') return chromeQueue.close() ? send(200,publicState()) : send(409,{error:'Wait for preparation to finish before closing the batch.'});
        if (run?.status==='running') return send(409,{error:'Wait for preparation to finish before closing the batch.'});
        if (run) run.status='closed';
        await browser?.close(); browser=null; return send(200,publicState());
      }
      return send(404,{error:'Not found'});
    } catch (error) { return send(400,{error: error.message?.startsWith('Job ') || error.message?.startsWith('Use ') || error.message?.startsWith('Workflow ') ? error.message : 'Check the job list, profile, and workflow configuration.'}); }
  });
  server.requestTimeout=30000;
  return { server, async close() {
    if(closing) return; closing=true;
    if(run) run.status='closed';
    await browser?.close().catch(()=>{});
    await Promise.allSettled([...pending]);
    await browser?.close().catch(()=>{});
    await new Promise(resolve=>{
      if (!server.listening) return resolve();
      server.close(resolve);
      server.closeAllConnections();
    });
  }};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app=createOtiumServer();
  app.server.listen(4317,'127.0.0.1',()=>console.log('Otium is ready: http://127.0.0.1:4317'));
  app.server.on('error',()=>{console.error('Could not start Otium on port 4317. Close an existing instance and try again.');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void app.close();});
}
