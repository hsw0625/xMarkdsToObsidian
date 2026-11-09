import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readJSON, atomicJSON, lock } from './state.mjs';
import { parseRequest, createSource } from './x-source.mjs';
import { synchronize, summarize, safeError } from './sync.mjs';
import { createWorker } from './worker.mjs';
import { setupServer } from './setup-server.mjs';
import { emptyLLM, publicLLM, providerFromForm, requestTranslation } from './llm.mjs';
import { createTranslationQueue } from './translation-queue.mjs';
import { outputFromForm, destinationFor, saveOutputChange, recoverOutputChange } from './output-config.mjs';

const { values } = parseArgs({ options: { once:{type:'boolean'}, 'state-dir':{type:'string',default:'.local'}, port:{type:'string',default:'8765'} } });
const dir=resolve(values['state-dir']);
const configPath=join(dir,'config.json'), requestPath=join(dir,'credentials.json'), statePath=join(dir,'state.json');
let unlock;
try {
  unlock=await lock(join(dir,'watch.lock'));
  await recoverOutputChange(dir);
  const defaults={ vault:resolve('output/vault'), notes:'Inbox/X', attachments:'attachments/x', tags:['X收藏'], intervalSeconds:300, maxPages:5, maxJobs:10 };
  let config=await readJSON(configPath,defaults);
  for (const [field,min,max] of [['intervalSeconds',30,86400],['maxPages',1,100],['maxJobs',1,100]]) if(!Number.isInteger(config[field])||config[field]<min||config[field]>max) throw new Error('CONFIG_INVALID');
  if(typeof config.vault!=='string'||typeof config.notes!=='string'||typeof config.attachments!=='string') throw new Error('CONFIG_INVALID');
  if(!Array.isArray(config.tags)||config.tags.some(t=>typeof t!=='string')) throw new Error('CONFIG_INVALID');
  config.vault=resolve(config.vault);
  await atomicJSON(configPath,config);
  let destination=destinationFor(config);
  let request=await readJSON(requestPath,null), running=false, configuring=false, outputBlocked=false, discoveryPaused=false, stopped=false, nextRun=0, errors=0;
  let summary=summarize(await readJSON(statePath,null));
  let activePromise=Promise.resolve();
  const llmPath=join(dir,'llm.json');
  let llm=await readJSON(llmPath,emptyLLM());
  if(llm.version!==1||!Array.isArray(llm.providers)) throw new Error('LLM_CONFIG_INVALID');
  let translations=await createTranslationQueue({stateDir:dir,...config,getConfig:()=>llm});
  let archiveItem=createWorker(config);
  const processItem=async job=>{const result=await archiveItem(job);await translations.enqueue(result.notePath);return result;};
  const run=async () => {
    if(running||configuring||outputBlocked||stopped||(!request&&!llm.enabled)) return;
    running=true;
    try {
      if(request&&!discoveryPaused) summary=await synchronize({statePath,scope:request.scope,destination,fetchPage:createSource(request),processItem,maxPages:config.maxPages,maxJobs:config.maxJobs});
      await translations.run();
      errors=summary.lastError?errors+1:0;
    } catch(error) { summary={...summary,lastError:safeError(error)}; errors++; }
    finally { running=false; }
    const needsSetup=/^(AUTH_EXPIRED|SESSION_CHANGED|DESTINATION_CHANGED|STATE_|X_SCHEMA_CHANGED|X_API_ERROR|X_HTTP_400|X_HTTP_404)/.test(summary.lastError||'');
    discoveryPaused=needsSetup;
    const delay=errors?Math.max(config.intervalSeconds,Math.min(3600,60*2**Math.min(errors,6))):(summary.scanInProgress?30:config.intervalSeconds);
    nextRun=needsSetup&&!llm.enabled?Infinity:Date.now()+delay*1000;
    console.log(JSON.stringify({time:new Date().toISOString(),...summary,nextCheckAt:Number.isFinite(nextRun)?new Date(nextRun).toISOString():null}));
  };
  if(values.once) {
    if(!request) throw new Error('SETUP_REQUIRED: run npm run watch and open http://127.0.0.1:8765');
    await run(); if(summary.lastError) process.exitCode=1;
    await unlock(); unlock=null;
  } else {
    const port=Number(values.port);if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('INVALID_PORT');
    const server=setupServer({port,status:()=>({configured:!!request,running,intervalSeconds:config.intervalSeconds,destination:join(config.vault,config.notes),output:{vault:config.vault,notes:config.notes,attachments:config.attachments},sync:summary,translation:{...publicLLM(llm),...translations.summary()},nextCheckAt:Number.isFinite(nextRun)&&nextRun?new Date(nextRun).toISOString():null}), configureOutput:async form=>{
      if(running) throw new Error('SYNC_BUSY');
      if(outputBlocked) throw new Error('OUTPUT_CHANGE_RECOVERY_REQUIRED');
      configuring=true;
      try {
        const candidate=outputFromForm(form,config);
        await saveOutputChange(dir,candidate);
        config=candidate;destination=destinationFor(config);
        translations=await createTranslationQueue({stateDir:dir,...config,getConfig:()=>llm});
        archiveItem=createWorker(config);
        summary=summarize(await readJSON(statePath,null));
        nextRun=0;
      } catch(error) {
        // If committing failed, freeze writes until startup recovery can
        // replay the journal rather than running with mixed destinations.
        if(await readJSON(join(dir,'output-change.json'),null)) { outputBlocked=true;summary={...summary,lastError:'OUTPUT_CHANGE_RECOVERY_REQUIRED'}; }
        throw error;
      } finally { configuring=false; }
    }, configureTranslation:async(action,form)=>{
      if(running) throw new Error('SYNC_BUSY');
      if(outputBlocked) throw new Error('OUTPUT_CHANGE_RECOVERY_REQUIRED');
      configuring=true;
      try {
      const candidate=structuredClone(llm);
      const id=form.get('id'), existing=candidate.providers.find(p=>p.id===id);
      if(action==='provider') {
        if(id&&!existing) throw new Error('LLM_PROVIDER_NOT_FOUND');
        const provider=providerFromForm(form,existing);
        if(existing) candidate.providers=candidate.providers.map(p=>p.id===provider.id?provider:p);
        else candidate.providers.push(provider);
        if(!candidate.activeProvider) candidate.activeProvider=provider.id;
      } else if(action==='settings') {
        candidate.activeProvider=form.get('activeProvider')||'';
        candidate.enabled=form.get('enabled')==='on';
        if(candidate.enabled&&!candidate.providers.some(p=>p.id===candidate.activeProvider)) throw new Error('LLM_SELECT_PROVIDER');
      } else if(action==='delete') {
        if(!existing) throw new Error('LLM_PROVIDER_NOT_FOUND');
        candidate.providers=candidate.providers.filter(p=>p.id!==id);
        if(candidate.activeProvider===id){candidate.activeProvider='';candidate.enabled=false;}
      } else if(action==='test') {
        if(!existing) throw new Error('LLM_PROVIDER_NOT_FOUND');
        running=true;
        try { await requestTranslation(existing,[{id:0,text:'Hello, this is a connection test.'}]); } finally { running=false; }
        return;
      } else if(action==='backfill'||action==='retry') {
        if(action==='backfill') await translations.backfill();
        await translations.retry();nextRun=0;return;
      } else throw new Error('LLM_INVALID_ACTION');
      await atomicJSON(llmPath,candidate);llm=candidate;
      await translations.retry();nextRun=0;
      } finally { configuring=false; }
    }, configure:async text=>{
      if(running) throw new Error('SYNC_BUSY: try again when the current scan finishes');
      if(outputBlocked) throw new Error('OUTPUT_CHANGE_RECOVERY_REQUIRED');
      configuring=true;
      try {
      const candidate=parseRequest(text);
      const state=await readJSON(statePath,null);
      if(state&&state.scope!==candidate.scope) throw new Error('SESSION_CHANGED: a new auth_token needs a separate state directory');
      // Verify the connection without storing/logging the response or submitted command.
      await createSource(candidate)(null);
      // A newly captured request may have fresh pagination semantics. Restart discovery
      // from the top, retaining accumulated IDs and queued work.
      if (state?.cursor) { state.cursor=null; state.cursors=[]; await atomicJSON(statePath,state); }
      await atomicJSON(requestPath,candidate); request=candidate;errors=0;nextRun=0;discoveryPaused=false;
      } finally { configuring=false; }
    }});
    await new Promise((res,rej)=>{server.once('error',rej);server.listen(port,'127.0.0.1',res);});
    console.log(`本机配置与状态：http://127.0.0.1:${port}`);
    console.log(`输出目录：${join(config.vault,config.notes)}；首次只建基线，不导入历史。`);
    const timer=setInterval(()=>{if(!running&&!stopped&&(request||llm.enabled)&&Date.now()>=nextRun) activePromise=run();},1000);
    const shutdown=async()=>{if(stopped)return;stopped=true;clearInterval(timer);server.close();await activePromise;await unlock();unlock=null;};
    process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
  }
} catch(error) {
  console.error(safeError(error)); if(unlock) await unlock();process.exitCode=1;
}
