import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {archive} from '../src/archive.mjs';
import {titleFilename,findNote} from '../src/note-files.mjs';
import {createWorker} from '../src/worker.mjs';

test('filenames preserve readable titles while handling unsupported characters and long Unicode names',()=>{
  assert.equal(titleFilename('文章标题：如何使用 AI','1'),'文章标题：如何使用 AI');
  assert.equal(titleFilename('Title: A/B? [draft]','1'),'Title： A／B？ ［draft］');
  assert.equal(titleFilename('..','1'),'Untitled (1)');
  assert.equal(titleFilename('CON','1'),'_CON');
  const name=titleFilename('长标题😀'.repeat(100),'1');assert.ok(Buffer.byteLength(name)<=175);assert.doesNotMatch(name,/\ufffd/);
});

test('archive names by title, adds ID only on collision, and deduplicates renamed notes without fetching again',async t=>{
  const vault=await mkdtemp(join(tmpdir(),'xmarks-names-'));t.after(()=>rm(vault,{recursive:true,force:true}));
  const item={id:'1',isX:true,title:'同名文章',source:'https://x.com/example/status/1',author:'example',kind:'x-article',language:'zh',markdown:'完整正文',images:[],headings:[],warnings:[],extractionStatus:'test'};
  const first=await archive(item,{vault});assert.equal(basename(first.notePath),'同名文章.md');
  const second=await archive({...item,id:'2',source:'https://x.com/example/status/2'},{vault});assert.equal(basename(second.notePath),'同名文章 (2).md');
  const original=await readFile(first.notePath,'utf8');
  const renamed=join(vault,'Inbox/X','用户修改的标题.md');await rename(first.notePath,renamed);await writeFile(renamed,original+'\n我的批注');
  const retry=await archive({...item,title:'Changed remote title'},{vault});assert.equal(retry.notePath,renamed);assert.equal(retry.status,'skipped-existing');
  assert.equal(await readFile(renamed,'utf8'),original+'\n我的批注');
  const worker=createWorker({vault,notes:'Inbox/X',attachments:'attachments/x'});
  assert.equal((await worker({id:'1',url:'https://invalid.example'})).notePath,renamed);
  assert.equal((await findNote(join(vault,'Inbox/X'),'2')).path,second.notePath);
  await writeFile(join(vault,'Inbox/X','个人笔记.md'),'Do not overwrite');
  const third=await archive({...item,id:'3',title:'个人笔记',source:'https://x.com/example/status/3'},{vault});assert.equal(basename(third.notePath),'个人笔记 (3).md');
  assert.equal(await readFile(join(vault,'Inbox/X','个人笔记.md'),'utf8'),'Do not overwrite');
});
