import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { emptyLLM, providerFromForm, publicLLM, requestTranslation } from '../src/llm.mjs';
import { translateMarkdown } from '../src/translate-markdown.mjs';
import { createTranslationQueue, parseNote } from '../src/translation-queue.mjs';
import { atomicJSON, readJSON } from '../src/state.mjs';
import { setupServer } from '../src/setup-server.mjs';

const provider={id:'one',name:'Test',type:'openai',baseURL:'https://example.com/v1',model:'test',apiKey:'secret-key',maxTokens:8192,tokenParameter:'max_tokens'};
const form=extra=>new URLSearchParams({name:'Test',type:'openai',baseURL:'https://example.com/v1',model:'test',apiKey:'secret-key',...extra});
const response=json=>new Response(JSON.stringify(json),{status:200,headers:{'Content-Type':'application/json'}});
const fakeTranslation=async(_provider,segments)=>segments.map(s=>({id:s.id,text:'测试译文 '+(s.text.match(/XMK_[a-f0-9]+_\d+_END/g)||[]).join(' ')}));

test('provider configuration validates destinations, retains keys only for unchanged endpoints, never exposes keys',()=>{
  const p=providerFromForm(form());
  assert.equal(providerFromForm(form({apiKey:''}),p).apiKey,p.apiKey);
  assert.throws(()=>providerFromForm(form({baseURL:'https://other.example/v1',apiKey:''}),p),/REENTER_KEY/);
  for(const baseURL of ['http://remote.example/v1','https://user:password@example.com','https://example.com?key=secret','file:///tmp/key']) assert.throws(()=>providerFromForm(form({baseURL})),/INVALID_URL/);
  assert.equal(providerFromForm(form({baseURL:'http://127.0.0.1:1234/v1',apiKey:''})).apiKey,'');
  assert.throws(()=>providerFromForm(form({apiKey:''})),/KEY_REQUIRED/);
  assert.throws(()=>providerFromForm(form({model:'../x?key=s'})),/INVALID_NAME_OR_MODEL/);
  const safe=JSON.stringify(publicLLM({...emptyLLM(),providers:[p]}));
  assert.doesNotMatch(safe,/secret-key|apiKey/);assert.match(safe,/hasKey/);
});

test('all three adapters send the correct protocol and reject truncation, bad IDs and private error bodies',async()=>{
  const segments=[{id:0,text:'Hello'}], translated={segments:[{id:0,text:'你好'}]};
  for(const type of ['openai','anthropic','gemini']){
    const p={...provider,type};
    const payload=type==='openai'?{choices:[{finish_reason:'stop',message:{content:JSON.stringify(translated)}}]}:type==='anthropic'?{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(translated)}]}:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(translated)}]}}]};
    const output=await requestTranslation(p,segments,{fetchImpl:async(url,opts)=>{
      assert.equal(opts.redirect,'error');assert.doesNotMatch(url,/secret-key/);
      const body=JSON.parse(opts.body);assert.ok(opts.signal);
      if(type==='openai'){assert.match(url,/chat\/completions$/);assert.equal(opts.headers.Authorization,'Bearer secret-key');assert.equal(body.max_tokens,8192);}
      if(type==='anthropic'){assert.match(url,/messages$/);assert.equal(opts.headers['x-api-key'],'secret-key');assert.equal(body.max_tokens,8192);}
      if(type==='gemini'){assert.match(url,/models\/test:generateContent$/);assert.equal(opts.headers['x-goog-api-key'],'secret-key');}
      return response(payload);
    }});
    assert.deepEqual(output,translated.segments);
  }
  await assert.rejects(requestTranslation(provider,segments,{fetchImpl:async()=>new Response('secret-key private prompt',{status:401})}),e=>e.message==='LLM_HTTP_401');
  await assert.rejects(requestTranslation(provider,segments,{fetchImpl:async()=>response({choices:[{finish_reason:'length',message:{content:'{}'}}]})}),/INCOMPLETE_OUTPUT/);
  await assert.rejects(requestTranslation(provider,segments,{fetchImpl:async()=>response({choices:[{finish_reason:'stop',message:{content:JSON.stringify({segments:[{id:4,text:'wrong'}]})}}]})}),/SEGMENT_MISMATCH/);
  await assert.rejects(requestTranslation(provider,segments,{fetchImpl:async()=>{throw new Error('secret-key');}}),e=>e.message==='LLM_NETWORK_OR_RESPONSE_ERROR');
});

test('translation preserves code, heading/list structure, local images and link destinations; dropped placeholders fail',async()=>{
  const md='# Original title\n\nBefore **strong** and `const x = 1` [reference](https://example.com/a_(b)).\n\n![cover](../../attachments/x/123/a.png)\n\n## Section\n\n- First item\n- Second item\n\n> Quoted content\n\n```js\nconst x = "do not translate";\n```\n\nAfter the image.';
  const translated=await translateMarkdown(md,provider,{request:fakeTranslation});
  assert.match(translated,/# 测试译文/);assert.match(translated,/## 测试译文/);
  assert.match(translated,/- 测试译文/);assert.match(translated,/> 测试译文/);
  assert.ok(translated.includes('`const x = 1`'));assert.ok(translated.includes('](https://example.com/a_(b))'));
  assert.ok(translated.includes('![cover](../../attachments/x/123/a.png)'));
  assert.ok(translated.includes('```js\nconst x = "do not translate";\n```'));
  assert.doesNotMatch(translated,/XMK_/);
  await assert.rejects(translateMarkdown('Please see [the source](https://example.com)',provider,{request:async(_p,s)=>s.map(x=>({id:x.id,text:'丢失链接'}))}),/MARKUP_CHANGED/);
});

test('long translations checkpoint valid batches and resume without repeating successful calls',async()=>{
  const md=Array.from({length:40},(_,i)=>`Paragraph ${i}: ${'Long article text. '.repeat(20)} **highlight**`).join('\n\n');
  const cache={};let calls=0;
  await assert.rejects(translateMarkdown(md,provider,{cache,request:async(p,s)=>{calls++;if(calls===2)throw new Error('LLM_HTTP_429');return fakeTranslation(p,s);}}),/429/);
  assert.equal(Object.keys(cache).length,1);
  let resumed=0;
  const result=await translateMarkdown(md,provider,{cache,request:async(p,s)=>{resumed++;assert.notEqual(s[0].id,0);return fakeTranslation(p,s);}});
  assert.ok(resumed>0);assert.equal(result.split('\n\n').length,40);assert.doesNotMatch(result,/XMK_/);
});

async function queueHarness(t){
  const dir=await mkdtemp(join(tmpdir(),'xmarks-translations-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const vault=join(dir,'vault'),notes='Inbox/X',stateDir=join(dir,'state');await mkdir(join(vault,notes),{recursive:true});
  const config={...emptyLLM(),enabled:true,activeProvider:provider.id,providers:[provider]};
  const original='---\ntags: [X收藏]\nsource: https://x.com/example/status/123\ncreated: 2026-11-05\naliases: [Original title]\ntweet_id: "123"\noriginal_language: und\ntranslation_status: pending\n---\n\n# Original title\n\nA test paragraph.\n\n![image](../../attachments/x/123/image.png)\n';
  const path=join(vault,notes,'123.md');await writeFile(path,original);
  let clock=100000;
  const options={stateDir,vault,notes,getConfig:()=>config,now:()=>clock,translate:(md,p,opts)=>translateMarkdown(md,p,{...opts,request:fakeTranslation})};
  return {dir,vault,notes,stateDir,path,original,config,options,tick:()=>clock+=60001};
}

test('queue preserves original bytes, writes bilingual metadata and local image links; restart never overwrites edited translation',async t=>{
  const h=await queueHarness(t),q=await createTranslationQueue(h.options);
  assert.equal(await q.enqueue(h.path),true);await q.run();
  assert.equal(q.summary().completed,1);assert.equal(await readFile(h.path,'utf8'),h.original);
  const target=join(h.vault,h.notes,'测试译文.zh-CN.md'),out=await readFile(target,'utf8');
  const {metadata}=parseNote(out);assert.equal(metadata.translation_status,'completed');assert.equal(metadata.translation_model,'test');assert.equal(metadata.original_note,'[[123]]');
  assert.match(out,/\[查看原文\]\(123.md\)/);assert.match(out,/!\[\[123\]\]/);assert.match(out,/\.\.\/\.\.\/attachments\/x\/123\/image.png/);
  await writeFile(target,out+'\n个人批注\n');const restarted=await createTranslationQueue(h.options);
  assert.equal(await restarted.enqueue(h.path),false);await restarted.run();assert.equal(await readFile(target,'utf8'),out+'\n个人批注\n');
  assert.equal((await stat(join(h.stateDir,'translation-state.json'))).mode&0o777,0o600);
});

test('disabled queue makes no requests, failed translation remains retryable across restart without publishing partial note',async t=>{
  const h=await queueHarness(t);let calls=0;
  h.config.enabled=false;
  let q=await createTranslationQueue({...h.options,translate:async()=>{calls++;throw new Error('LLM_HTTP_429: private response');}});
  await q.enqueue(h.path);await q.run();assert.equal(calls,0);
  h.config.enabled=true;await q.run();assert.equal(q.summary().retrying,1);assert.deepEqual(q.summary().errors,['LLM_HTTP_429']);
  assert.equal(await readFile(h.path,'utf8'),h.original);
  await assert.rejects(readFile(join(h.vault,h.notes,'测试译文.zh-CN.md')),/ENOENT/);
  q=await createTranslationQueue(h.options);await q.run();assert.equal(q.summary().completed,0);
  h.tick();await q.run();assert.equal(q.summary().completed,1);
});

test('backfill reads archive metadata, skips Chinese and duplicates, and preserves unrelated files',async t=>{
  const h=await queueHarness(t);
  await writeFile(join(h.vault,h.notes,'中文标题.md'),h.original.replace('original_language: und','original_language: zh').replace('tweet_id: "123"','tweet_id: "124"'));
  await writeFile(join(h.vault,h.notes,'123.zh-CN.md'),'My personal file');
  const q=await createTranslationQueue(h.options);assert.equal(await q.backfill(),1);assert.equal(await q.backfill(),0);
  await q.run();assert.equal(q.summary().completed,1);assert.equal(await readFile(join(h.vault,h.notes,'123.zh-CN.md'),'utf8'),'My personal file');
  await assert.rejects(q.enqueue(join(h.dir,'123.md')),/INVALID_PATH/);
});

test('local provider forms enforce Origin/CSRF, escape configuration, and never render submitted keys',async t=>{
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  let config=emptyLLM();
  const server=setupServer({port,status:()=>({configured:false,intervalSeconds:300,sync:{},translation:publicLLM(config)}),configure:async()=>{},configureTranslation:async(action,f)=>{assert.equal(action,'provider');config.providers.push(providerFromForm(f));}});
  await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${port}`,html=await(await fetch(base)).text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const send=(origin,token)=>fetch(base+'/llm/provider',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams([...form({name:'<script>alert(1)</script>'}),['csrf',token]]),redirect:'manual'});
  assert.equal((await send('https://evil.example',csrf)).status,403);assert.equal((await send(base,'wrong')).status,403);assert.equal(config.providers.length,0);
  assert.equal((await send(base,csrf)).status,303);
  const rendered=await(await fetch(base)).text();assert.doesNotMatch(rendered,/secret-key|<script>alert\(1\)<\/script>/);assert.match(rendered,/&lt;script&gt;/);
  assert.doesNotMatch(await(await fetch(base+'/status')).text(),/secret-key|apiKey/);
});

test('open page renews stale CSRF after server restart, preserves inputs and executes the action exactly once',async t=>{
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const base=`http://127.0.0.1:${port}`;let actions=0, failProvider=false;
  const options={port,status:()=>({configured:false,sync:{},translation:publicLLM({...emptyLLM(),providers:[provider]})}),configure:async()=>{},configureTranslation:async(action,f)=>{
    assert.equal(action,'test');assert.equal(f.get('id'),provider.id);actions++;
    if(failProvider) throw new Error('LLM_HTTP_403');
  }};
  let server=setupServer(options);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const html=await(await fetch(base)).text();
  const dom=new JSDOM(html,{url:base,runScripts:'outside-only'});t.after(()=>dom.window.close());
  const paths=[];
  dom.window.fetch=(url,opts={})=>{paths.push(new URL(url,base).pathname);return fetch(new URL(url,base),{...opts,...(opts.body?{body:new URLSearchParams(opts.body.toString())}:{}),headers:{...opts.headers,Origin:base}});};
  dom.window.eval(dom.window.document.querySelector('script').textContent);
  const pendingKey=dom.window.document.querySelector('input[type=password]');pendingKey.value='unsaved-local-input';
  const oldToken=dom.window.document.querySelector('[name=csrf]').value;
  await new Promise(r=>server.close(r));server=setupServer(options);await new Promise(r=>server.listen(port,'127.0.0.1',r));
  assert.equal((await fetch(base+'/csrf')).status,403);
  assert.equal((await fetch(base+'/csrf',{headers:{Origin:'https://evil.example','X-CSRF-Refresh':'1'}})).status,403);
  assert.equal((await fetch(base+'/csrf',{method:'OPTIONS',headers:{Origin:'https://evil.example','Access-Control-Request-Headers':'X-CSRF-Refresh'}})).status,404);
  const target=dom.window.document.querySelector('form[action="/llm/test"]');
  const submit=async()=>{
    target.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    for(let i=0;i<100&&target.querySelector('button').disabled;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(target.querySelector('button').disabled,false);
  };
  await submit();
  assert.deepEqual(paths,['/llm/test','/csrf','/llm/test']);assert.equal(actions,1);
  assert.match(target.querySelector('[role=alert]').textContent,/连接测试通过/);
  assert.equal(pendingKey.value,'unsaved-local-input');
  assert.notEqual(dom.window.document.querySelector('[name=csrf]').value,oldToken);
  failProvider=true;paths.length=0;await submit();
  assert.deepEqual(paths,['/llm/test']);assert.equal(actions,2);
  assert.match(target.querySelector('[role=alert]').textContent,/LLM_HTTP_403/);
});

test('running service: configure local provider, test connection, enable and backfill; real HTTP pipeline publishes only translation',async t=>{
  const h=await queueHarness(t);let requests=0;
  const api=createServer(async(req,res)=>{
    assert.equal(req.url,'/v1/chat/completions');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const input=JSON.parse(body.messages[1].content);
    requests++;
    if(body.model==='fail-test'){res.statusCode=429;res.end('rate limited');return;}
    const segments=await fakeTranslation(provider,input.segments);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({segments})}}]}));
  });
  await new Promise(r=>api.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>api.close(r)));
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  await atomicJSON(join(h.stateDir,'config.json'),{vault:h.vault,notes:h.notes,attachments:'attachments/x',tags:['X收藏'],intervalSeconds:30,maxPages:5,maxJobs:10});
  const child=spawn(process.execPath,['src/watch.mjs','--state-dir',h.stateDir,'--port',String(port)],{stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let log='';child.stdout.on('data',b=>{log+=b});child.stderr.on('data',b=>{log+=b});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await exited;}});
  const base=`http://127.0.0.1:${port}`;
  const wait=async fn=>{for(let i=0;i<80;i++){const result=await fn().catch(()=>null);if(result)return result;await new Promise(r=>setTimeout(r,50));}throw new Error('SERVICE_TEST_TIMEOUT');};
  await wait(async()=> (await fetch(base+'/status')).ok);
  const html=await(await fetch(base)).text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const post=async(action,fields)=>fetch(base+'/llm/'+action,{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...fields}),redirect:'manual'});
  assert.equal((await post('provider',{name:'Local test',type:'openai',baseURL:`http://127.0.0.1:${api.address().port}/v1`,model:'fake-test',apiKey:''})).status,303);
  let status=await(await fetch(base+'/status')).json();const id=status.translation.providers[0].id;
  assert.equal(requests,0);assert.equal(status.translation.enabled,false);
  assert.equal((await post('test',{id})).status,200);assert.equal(requests,1);
  const endpoint=`http://127.0.0.1:${api.address().port}/v1`;
  assert.equal((await post('provider',{name:'Backup',type:'openai',baseURL:endpoint,model:'backup-test',apiKey:''})).status,303);
  assert.equal((await post('provider',{id,name:'Local test',type:'openai',baseURL:endpoint,model:'fail-test',apiKey:''})).status,303);
  status=await(await fetch(base+'/status')).json();
  assert.deepEqual(status.translation.providers.map(p=>p.model),['fail-test','backup-test']);
  assert.match(await(await fetch(base)).text(),/尝试顺序：Local test · fail-test → Backup · backup-test/);
  assert.equal((await post('backfill',{})).status,303);
  assert.equal((await post('settings',{enabled:'on',activeProvider:id})).status,303);
  status=await wait(async()=>{const s=await(await fetch(base+'/status')).json();return s.translation.completed===1?s:null;});
  assert.equal(status.translation.pending,0);assert.equal(status.configured,false);
  assert.equal(await readFile(h.path,'utf8'),h.original);
  const metadata=parseNote(await readFile(join(h.vault,h.notes,'测试译文.zh-CN.md'),'utf8')).metadata;
  assert.equal(metadata.translation_status,'completed');assert.equal(metadata.translation_model,'backup-test');
  assert.equal(requests,3); // Single connection test, failed primary, successful backup.

  assert.equal((await stat(join(h.stateDir,'llm.json'))).mode&0o777,0o600);
  assert.doesNotMatch(log,/secret-key/);
});

test('pending translation finds a renamed original by ID and links its title filename',async t=>{
  const h=await queueHarness(t),q=await createTranslationQueue(h.options);
  await q.enqueue(h.path);
  const newName='文章标题 (Original).md',newPath=join(h.vault,h.notes,newName);
  await rename(h.path,newPath);await q.run();
  const out=await readFile(join(h.vault,h.notes,'测试译文.zh-CN.md'),'utf8');
  assert.equal(parseNote(out).metadata.original_note,'[[文章标题 (Original)]]');
  assert.match(out,/!\[\[文章标题 \(Original\)\]\]/);
  assert.ok(out.includes('[查看原文](%E6%96%87%E7%AB%A0%E6%A0%87%E9%A2%98%20%28Original%29.md)'));
  assert.equal(await readFile(newPath,'utf8'),h.original);
  assert.equal(await q.backfill(),0);
});

test('fallback tries preferred provider first, stops at success and records the actual model',async t=>{
  const h=await queueHarness(t),calls=[];
  h.config.providers=[provider,{...provider,id:'two',name:'Fallback',model:'second'},{...provider,id:'three',model:'third'}];
  h.config.activeProvider='three';
  const q=await createTranslationQueue({...h.options,translate:async(md,p,opts)=>{
    calls.push(p.id);
    if(p.id==='three')throw new Error('LLM_HTTP_429');
    if(p.id==='one')throw new Error('LLM_MARKUP_CHANGED');
    return h.options.translate(md,p,opts);
  }});
  await q.enqueue(h.path);await q.run();
  assert.deepEqual(calls,['three','one','two']);assert.equal(q.summary().completed,1);
  const {metadata}=parseNote(await readFile(join(h.vault,h.notes,'测试译文.zh-CN.md'),'utf8'));
  assert.equal(metadata.translation_provider,'Fallback');assert.equal(metadata.translation_model,'second');
  assert.equal(await readFile(h.path,'utf8'),h.original);
});

test('fallback stops immediately after the first success',async t=>{
  const h=await queueHarness(t),calls=[];
  h.config.providers.push({...provider,id:'two'});
  const q=await createTranslationQueue({...h.options,translate:async(md,p,opts)=>{calls.push(p.id);return h.options.translate(md,p,opts);}});
  await q.enqueue(h.path);await q.run();assert.deepEqual(calls,['one']);
});

test('all providers fail once per cycle; isolated checkpoints survive restart and retry',async t=>{
  const h=await queueHarness(t),calls=[];
  h.config.providers.push({...provider,id:'two',model:'second'});
  const options={...h.options,translate:async(md,p,{cache,onBatch})=>{
    calls.push(p.id);
    assert.equal(cache.owner,undefined);cache.owner=p.id;await onBatch(cache);
    throw new Error('LLM_HTTP_403: secret-key private response');
  }};
  let q=await createTranslationQueue(options);await q.enqueue(h.path);await q.run();
  assert.deepEqual(calls,['one','two']);assert.deepEqual(q.summary().errors,['LLM_ALL_PROVIDERS_FAILED']);
  const stored=await readFile(join(h.stateDir,'translation-state.json'),'utf8');
  assert.doesNotMatch(stored,/secret-key|private response/);
  const job=Object.values(JSON.parse(stored).jobs)[0];assert.equal(job.attempts,1);assert.equal(job.providerErrors.length,2);
  assert.deepEqual(Object.values(job.providerCaches).map(c=>c.owner),['one','two']);
  await assert.rejects(readFile(join(h.vault,h.notes,'测试译文.zh-CN.md')),/ENOENT/);
  q=await createTranslationQueue({...h.options,translate:async(md,p,opts)=>{
    calls.push(p.id);assert.equal(opts.cache.owner,p.id);
    if(p.id==='one')throw new Error('LLM_HTTP_429');
    return h.options.translate(md,p,{...opts,cache:{}});
  }});
  await q.run();assert.deepEqual(calls,['one','two']);h.tick();await q.run();
  assert.deepEqual(calls,['one','two','one','two']);assert.equal(q.summary().completed,1);
  const done=Object.values((await readJSON(join(h.stateDir,'translation-state.json'))).jobs)[0];
  assert.equal(done.providerCaches,undefined);assert.equal(done.snapshot,undefined);
});

test('checkpoint persistence failure does not call another provider',async t=>{
  const h=await queueHarness(t),calls=[];
  h.config.providers.push({...provider,id:'two'});
  const statePath=join(h.stateDir,'translation-state.json');
  const q=await createTranslationQueue({...h.options,translate:async(_md,p,{onBatch})=>{
    calls.push(p.id);
    // Make the state destination unwritable, without relying on OS user permissions.
    await rm(statePath);await mkdir(statePath);
    try { await onBatch({batch:'translated'}); }
    finally { await rm(statePath,{recursive:true}); }
  }});
  await q.enqueue(h.path);await q.run();
  assert.deepEqual(calls,['one']);assert.deepEqual(q.summary().errors,['TRANSLATION_CHECKPOINT_FAILED']);
});
