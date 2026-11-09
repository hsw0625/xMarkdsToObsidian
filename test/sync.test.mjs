import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synchronize } from '../src/sync.mjs';
import { atomicJSON, readJSON, lock } from '../src/state.mjs';
import { parseRequest, parsePage, createSource } from '../src/x-source.mjs';
import { archive } from '../src/archive.mjs';
import { extract } from '../src/extract.mjs';
import { setupServer } from '../src/setup-server.mjs';

const item=id=>({id:String(id),url:`https://x.com/example/status/${id}`});
const page=(ids,cursor=null)=>({items:ids.map(item),cursor});
async function harness(t) {
  const dir=await mkdtemp(join(tmpdir(),'xmarks-sync-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const processed=[];
  const options={statePath:join(dir,'state.json'),scope:'account',destination:'test-vault',pause:async()=>{},processItem:async job=>{processed.push(job.id);return{status:'saved',notePath:`${job.id}.md`};}};
  return {dir,processed,options,run:extra=>synchronize({...options,...extra}),state:()=>readJSON(options.statePath,null)};
}

test('first scan baselines all pages without downloading; only new IDs are processed even for old tweets',async t=>{
  const h=await harness(t);
  let status=await h.run({fetchPage:async c=>c?page([80,70]):page([100,90],'older')});
  assert.equal(status.phase,'watching');assert.deepEqual(h.processed,[]);assert.equal(status.knownBookmarks,4);
  // Tweet ID 10 is older than all baseline tweets, but newly bookmarked now.
  status=await h.run({fetchPage:async c=>c?page([80,70]):page([10,100,90],'older')});
  assert.equal(status.completed,1);assert.deepEqual(h.processed,['10']);
  await h.run({fetchPage:async()=>page([10,100,90])});assert.deepEqual(h.processed,['10']);
});

test('page budget checkpoints baseline and incremental backlog without losing new arrivals',async t=>{
  const h=await harness(t);
  await h.run({maxPages:1,fetchPage:async()=>page([100],'b')});
  assert.equal((await h.state()).phase,'baseline');
  await h.run({fetchPage:async c=>{assert.equal(c,'b');return page([90]);}});
  assert.deepEqual(h.processed,[]);
  await h.run({maxPages:1,fetchPage:async()=>page([120],'s')});
  assert.deepEqual(h.processed,[]);assert.equal((await h.state()).scan[0].id,'120');
  await h.run({fetchPage:async c=>{assert.equal(c,'s');return page([110,100]);}});
  assert.deepEqual([...h.processed].sort(),['110','120']);
  await h.run({fetchPage:async()=>page([130,120,110])});assert.deepEqual([...h.processed].sort(),['110','120','130']);
});

test('queue is committed before processing; failures survive restart and retry with backoff',async t=>{
  const h=await harness(t);await h.run({fetchPage:async()=>page([1])});let clock=100000;
  await h.run({fetchPage:async()=>page([2,1]),now:()=>clock,processItem:async job=>{
    assert.equal((await h.state()).jobs[job.id].status,'pending');throw new Error('FETCH_FAILED: secret details');
  }});
  let state=await h.state();assert.equal(state.jobs['2'].attempts,1);assert.equal(state.jobs['2'].lastError,'FETCH_FAILED');
  await h.run({fetchPage:async()=>page([2,1]),now:()=>clock});assert.deepEqual(h.processed,[]);
  clock+=60001;
  await h.run({fetchPage:async()=>{throw new Error('NETWORK_ERROR');},now:()=>clock});
  assert.deepEqual(h.processed,['2']);assert.equal((await h.state()).jobs['2'].status,'done');
});

test('duplicate/re-added IDs and removed bookmarks never rewrite or delete notes',async t=>{
  const h=await harness(t);await h.run({fetchPage:async()=>page([1])});
  await h.run({fetchPage:async()=>page([2,1])});
  await h.run({fetchPage:async()=>page([1])});
  await h.run({fetchPage:async()=>page([2,2,1])});assert.deepEqual(h.processed,['2']);
});

test('stalled cursor and schema failure cannot finish baseline or release partial incremental scan',async t=>{
  const h=await harness(t);
  let status=await h.run({fetchPage:async()=>page([1],'loop')});
  assert.equal(status.phase,'baseline');assert.equal(status.lastError,'CURSOR_STALLED');
  status=await h.run({fetchPage:async()=>{throw new Error('X_SCHEMA_CHANGED');}});
  assert.equal(status.phase,'baseline');assert.deepEqual(h.processed,[]);
});

test('X cursor-only terminal page completes a resumed baseline and incremental scan',async t=>{
  const h=await harness(t);
  await h.run({maxPages:1,fetchPage:async()=>page([100,90],'bottom')});
  // Reproduce the actual X response: top and bottom cursors, no tweet entries.
  const terminal=cursor=>parsePage(response([
    {content:{entryType:'TimelineTimelineCursor',cursorType:'Top',value:'top'}},
    {content:{entryType:'TimelineTimelineCursor',cursorType:'Bottom',value:cursor}},
  ]));
  let status=await h.run({fetchPage:async c=>terminal(c)});
  assert.equal(status.phase,'watching');assert.equal(status.knownBookmarks,2);
  assert.equal(status.lastError,null);assert.equal(status.scanInProgress,false);
  assert.deepEqual(h.processed,[]);assert.ok((await h.state()).baselineCompletedAt);
  // All previous bookmarks may have been removed; reaching EOF must still
  // commit new discoveries exactly once, even without an overlap page.
  await h.run({maxPages:1,fetchPage:async()=>page([110],'new-bottom')});
  status=await h.run({fetchPage:async c=>terminal(c)});
  assert.equal(status.completed,1);assert.deepEqual(h.processed,['110']);
  await h.run({fetchPage:async()=>page([110],'new-bottom')});
  assert.deepEqual(h.processed,['110']);
});

test('empty pages with advancing cursors continue; cycles to earlier cursors still fail',async t=>{
  const h=await harness(t);
  const pages=[page([1],'a'),page([],'b'),page([],'a')];
  const status=await h.run({fetchPage:async()=>pages.shift()});
  assert.equal(status.phase,'baseline');assert.equal(status.lastError,'CURSOR_STALLED');
  assert.deepEqual(h.processed,[]);
});

test('refuses changed session, destination and corrupt state without silently creating a new baseline',async t=>{
  const h=await harness(t);await h.run({fetchPage:async()=>page([1])});
  await assert.rejects(h.run({scope:'other',fetchPage:async()=>page([])}),/SESSION_CHANGED/);
  await assert.rejects(h.run({destination:'other',fetchPage:async()=>page([])}),/DESTINATION_CHANGED/);
  await writeFile(h.options.statePath,'broken');
  await assert.rejects(h.run({fetchPage:async()=>page([])}),/STATE_OR_CONFIG_INVALID/);
  assert.equal(await readFile(h.options.statePath,'utf8'),'broken');
});

test('exclusive process lock and private atomic state permissions',async t=>{
  const h=await harness(t),path=join(h.dir,'lock');const unlock=await lock(path);
  await assert.rejects(lock(path),/ALREADY_RUNNING/);await unlock();
  await atomicJSON(h.options.statePath,{private:true});assert.equal((await stat(h.options.statePath)).mode&0o777,0o600);
});

const requestURL='https://x.com/i/api/graphql/current-id/Bookmarks?variables='+encodeURIComponent(JSON.stringify({count:20,cursor:'old-cursor'}))+'&features='+encodeURIComponent('{"example":true}');
const curl=`curl '${requestURL}' -H 'authorization: Bearer public-token' -H 'x-csrf-token: test-csrf' -b 'auth_token=test-session; ct0=test-csrf; unrelated=do-not-store'`;
test('local import parses request data without execution and retains only required headers/cookies',()=>{
  const r=parseRequest(curl);
  assert.equal(r.headers.cookie,'auth_token=test-session; ct0=test-csrf');
  assert.equal(JSON.parse(new URL(r.url).searchParams.get('variables')).cursor,undefined);
  assert.equal(JSON.parse(new URL(r.url).searchParams.get('variables')).count,100);
  assert.throws(()=>parseRequest(curl+'; touch /tmp/nope'),/INVALID_CURL/);
  assert.throws(()=>parseRequest(curl.replace('https://x.com/','https://evil.example/')),/INVALID_BOOKMARKS_URL/);
  assert.throws(()=>parseRequest(curl.replace('/Bookmarks?','/DeleteBookmark?')),/INVALID_BOOKMARKS_URL/);
  assert.throws(()=>parseRequest(curl.replace("'auth_token=test-session; ct0=test-csrf; unrelated=do-not-store'","'/tmp/cookies.txt'")),/MISSING_SESSION/);
});

test('browser cURL variants accept named URLs, equals, attached short values and transport flags',()=>{
  const variants = [
    curl + ' --http2 --path-as-is --insecure --location --silent --show-error --connect-timeout 10',
    curl.replace(`curl '${requestURL}'`, `curl --url '${requestURL}'`) + " -A 'Browser/1.0' -e 'https://x.com/i/bookmarks' -sSL --max-time=40",
    `curl --url='${requestURL}' --request=GET --header='authorization: Bearer public-token' --cookie='auth_token=test-session; ct0=test-csrf' --compressed`,
    `curl '${requestURL}' -XGET -H'authorization: Bearer public-token' -b'auth_token=test-session; ct0=test-csrf' -ABrowser/1.0 -m30`,
    curl.split(' -').join(' \\\r\n  -'),
  ];
  for (const command of variants) {
    const r = parseRequest(command);
    assert.equal(r.headers.cookie,'auth_token=test-session; ct0=test-csrf');
    assert.equal(new URL(r.url).origin,'https://x.com');
    assert.deepEqual(Object.keys(r).sort(),['headers','scope','url','version']);
  }
});

test('unsupported option diagnostics contain only option names and never private argument values',()=>{
  for (const argument of ['--config=/private/secret','--proxy=https://private.example']) {
    assert.throws(()=>parseRequest(curl+' '+argument),error=>{
      assert.equal(error.message,'UNSUPPORTED_CURL_OPTION');
      assert.equal(error.option,argument.split('=')[0]);
      assert.doesNotMatch(JSON.stringify(error),/private|secret/);
      return true;
    });
  }
  assert.throws(()=>parseRequest(curl+' private-sensitive-value'),error=>error.option===undefined&&!error.message.includes('private'));
  assert.throws(()=>parseRequest(curl+" --data-raw '{}'"),/NOT_A_GET_REQUEST/);
  assert.throws(()=>parseRequest(curl+' --request POST'),/INVALID_BOOKMARKS_URL/);
});

const entry = id => {
  const result = { rest_id: String(id), core: { user_results: { result: { legacy: { screen_name: 'example' } } } } };
  return { entryId: `tweet-${id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result } } } };
};
const response=entries=>({data:{bookmark_timeline_v2:{timeline:{instructions:[{type:'TimelineAddEntries',entries}]}}}});
test('source parses tweets and cursors but fails closed on schema drift and authentication errors',async()=>{
  const json=response([entry(1),{entryId:'cursor-bottom',content:{entryType:'TimelineTimelineCursor',cursorType:'Bottom',value:'next'}}]);
  assert.deepEqual(parsePage(json),page([1],'next'));
  assert.deepEqual(parsePage(response([])),page([]));
  assert.throws(()=>parsePage({data:{}}),/X_SCHEMA_CHANGED/);
  assert.throws(()=>parsePage(response([{entryId:'unrecognized',content:{}}])),/X_SCHEMA_CHANGED/);
  const r=parseRequest(curl);
  const source=createSource(r,async(url,headers)=>{assert.equal(new URL(url).origin,'https://x.com');assert.equal(JSON.parse(new URL(url).searchParams.get('variables')).cursor,'next');assert.ok(headers.cookie);return{status:200,text:JSON.stringify(json)};});
  assert.deepEqual(await source('next'),page([1],'next'));
  await assert.rejects(createSource(r,async()=>({status:403,text:'secret reflected text'}))(null),/^Error: AUTH_EXPIRED/);
  await assert.rejects(createSource(r,async()=>({status:200,text:'not-json'}))(null),/X_SCHEMA_CHANGED/);
});

test('monitor does not publish a partial-image note; a later retry can publish successfully',async t=>{
  const h=await harness(t),html=await readFile(new URL('../fixtures/post.html',import.meta.url),'utf8');
  const item=extract(html,'https://x.com/example/status/124');
  const opts={vault:join(h.dir,'vault'),requireAllImages:true,fetchImage:async()=>{throw new Error('network');}};
  await assert.rejects(archive(item,opts),/MEDIA_INCOMPLETE/);
  await assert.rejects(readFile(join(opts.vault,'Inbox/X/124.md')),/ENOENT/);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
  const result=await archive(item,{...opts,fetchImage:async()=>({bytes:png,mime:'image/png'})});
  assert.equal(result.status,'saved');assert.equal(result.metadata.media_status,'complete');
});

test('local setup rejects cross-origin posts, does not echo pasted credentials, and status is secret-free',async t=>{
  // Find an unused port first, then bind the actual host-validated setup server.
  const {createServer}=await import('node:net');const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  let saved=false;
  const server=setupServer({port,status:()=>({configured:false,sync:{phase:'not-started'}}),configure:async()=>{saved=true;}});
  await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${port}`;
  const formResponse=await fetch(base);
  assert.equal(formResponse.headers.get('referrer-policy'),'same-origin');
  const html=await formResponse.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const post=origin=>fetch(base+'/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,request:'sensitive-input'}),redirect:'manual'});
  assert.equal((await post('https://evil.example')).status,403);assert.equal(saved,false);
  assert.equal((await post('null')).status,403);assert.equal(saved,false);
  const badCsrf=await fetch(base+'/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:'wrong-token',request:'sensitive-input'}),redirect:'manual'});
  assert.equal(badCsrf.status,403);assert.equal(saved,false);
  assert.equal((await post(base)).status,303);assert.equal(saved,true);
  assert.doesNotMatch(await(await fetch(base+'/status')).text(),/sensitive-input|csrf|cookie/);
});
