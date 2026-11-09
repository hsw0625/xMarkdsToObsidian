import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {outputFromForm, destinationFor, saveOutputChange, recoverOutputChange} from '../src/output-config.mjs';
import {atomicJSON, readJSON} from '../src/state.mjs';
import {synchronize} from '../src/sync.mjs';
import {createTranslationQueue} from '../src/translation-queue.mjs';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'xmarks-output-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const stateDir=join(dir,'state');
  const old={vault:join(dir,'old vault'),notes:'Inbox/X',attachments:'attachments/x',tags:['X收藏'],intervalSeconds:30,maxPages:5,maxJobs:10};
  const next={...old,vault:join(dir,'新笔记库'),notes:'收藏/X',attachments:'图片/X'};
  await mkdir(join(old.vault,old.notes),{recursive:true});await atomicJSON(join(stateDir,'config.json'),old);
  return {dir,stateDir,old,next};
}

test('output paths require vault-relative children and reject reserved or escaping destinations before committing',async t=>{
  const h=await fixture(t),form=extra=>new URLSearchParams({vault:h.next.vault,notes:h.next.notes,attachments:h.next.attachments,...extra});
  assert.deepEqual(outputFromForm(form(),h.old),h.next);
  for(const fields of [{vault:'relative/vault'},{notes:'../escape'},{notes:'/outside'},{attachments:'.'},{notes:'Originals'}]) assert.throws(()=>outputFromForm(form(fields),h.old),/OUTPUT_/);
  const outside=join(h.dir,'outside');await mkdir(outside);await mkdir(h.next.vault);await symlink(outside,join(h.next.vault,'收藏'));
  await assert.rejects(saveOutputChange(h.stateDir,h.next),/OUTPUT_OUTSIDE_VAULT/);
  assert.deepEqual(await readJSON(join(h.stateDir,'config.json')),h.old);
  await assert.rejects(readFile(join(outside,'X')),/ENOENT/);
});

test('explicit output switch preserves bookmark baseline and queues, pins old translations and permits same-ID backfill in the new directory',async t=>{
  const h=await fixture(t),statePath=join(h.stateDir,'state.json');
  const run=config=>synchronize({statePath,scope:'account',destination:destinationFor(config),fetchPage:async()=>({items:[{id:'1',url:'https://x.com/example/status/1'}],cursor:null}),processItem:async()=>{throw new Error('HISTORY_MUST_NOT_BE_IMPORTED');}});
  await run(h.old);
  const note='---\ntweet_id: "123"\noriginal_language: und\n---\n# Original\n\nText\n';
  const oldPath=join(h.old.vault,h.old.notes,'123.md');await writeFile(oldPath,note);
  const getConfig=()=>({enabled:true,activeProvider:'test',providers:[{id:'test',name:'test',model:'test'}]});
  const options={stateDir:h.stateDir,getConfig,translate:async()=> '# 测试\n\n译文'};
  const oldQueue=await createTranslationQueue({...options,...h.old});await oldQueue.enqueue(oldPath);
  const before=await readJSON(statePath);
  await saveOutputChange(h.stateDir,h.next);
  const after=await readJSON(statePath);
  assert.deepEqual({...after,destination:before.destination},before);
  const summary=await run(h.next);assert.equal(summary.phase,'watching');assert.equal(summary.knownBookmarks,1);assert.equal(summary.completed,0);
  const newPath=join(h.next.vault,h.next.notes,'123.md');await writeFile(newPath,note);
  const newQueue=await createTranslationQueue({...options,...h.next});assert.equal(await newQueue.backfill(),1);await newQueue.run();
  assert.equal(newQueue.summary().completed,2);
  for(const config of [h.old,h.next]) {
    assert.equal(await readFile(join(config.vault,config.notes,'123.md'),'utf8'),note);
    assert.match(await readFile(join(config.vault,config.notes,'测试.zh-CN.md'),'utf8'),/译文/);
  }
  assert.equal(await newQueue.backfill(),0);
});

test('interrupted output change is replayable and never repins legacy tasks to the new directory',async t=>{
  const h=await fixture(t);
  const translations={version:1,destination:join(h.old.vault,h.old.notes),jobs:{'123':{id:'123',status:'pending',snapshot:'untouched',cache:{partial:'batch'}}}};
  await atomicJSON(join(h.stateDir,'translation-state.json'),translations);
  await atomicJSON(join(h.stateDir,'output-change.json'),{version:1,config:h.next});
  await recoverOutputChange(h.stateDir);
  // Simulate replay after a crash before the journal was removed.
  await atomicJSON(join(h.stateDir,'output-change.json'),{version:1,config:h.next});
  await recoverOutputChange(h.stateDir);
  const restored=await readJSON(join(h.stateDir,'translation-state.json'));
  assert.equal(restored.destination,join(h.next.vault,h.next.notes));
  assert.equal(restored.jobs['123'].directory,translations.destination);
  assert.deepEqual(restored.jobs['123'].cache,{partial:'batch'});
  assert.deepEqual(await readJSON(join(h.stateDir,'config.json')),h.next);
});

test('live service saves output settings with CSRF, immediately reflects them and keeps them after restart',async t=>{
  const h=await fixture(t),probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  let child,exited;
  const start=()=>{child=spawn(process.execPath,['src/watch.mjs','--state-dir',h.stateDir,'--port',String(port)],{stdio:'ignore'});exited=once(child,'exit');};
  const stop=async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await exited;}};
  t.after(stop);const base=`http://127.0.0.1:${port}`;
  const ready=async()=>{for(let i=0;i<80;i++){try{const res=await fetch(base+'/status');if(res.ok)return await res.json();}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('SERVICE_TEST_TIMEOUT');};
  start();await ready();
  const html=await(await fetch(base)).text();assert.match(html,/保存输出目录/);
  const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const post=token=>fetch(base+'/output',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token,vault:h.next.vault,notes:h.next.notes,attachments:h.next.attachments}),redirect:'manual'});
  assert.equal((await post('wrong')).status,403);assert.equal((await ready()).output.vault,h.old.vault);
  assert.equal((await post(csrf)).status,303);
  assert.deepEqual((await ready()).output,{vault:h.next.vault,notes:h.next.notes,attachments:h.next.attachments});
  await stop();start();const status=await ready();assert.equal(status.destination,join(h.next.vault,h.next.notes));
});
