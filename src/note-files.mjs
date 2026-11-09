import { readFile, readdir, writeFile, link, rm, lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';

export function parseFrontmatter(text) {
  const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if(!match) return null;
  try { const metadata=YAML.parse(match[1]);return metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?{metadata,body:match[2]}:null; }catch{return null;}
}
export function noteId(metadata) {
  const id=String(metadata?.tweet_id||metadata?.archive_id||'');
  if(/^(?:\d+|[a-f0-9]{20})$/.test(id)) return id;
  if(typeof metadata?.source==='string'&&/^https?:\/\//.test(metadata.source)) return createHash('sha256').update(metadata.source).digest('hex').slice(0,20);
  return null;
}
export function titleFilename(title,id) {
  const replacements={':':'：','/':'／','\\':'＼','*':'＊','?':'？','"':'＂','<':'＜','>':'＞','|':'｜','[':'［',']':'］','#':'＃','^':'＾'};
  let value=String(title||'').normalize('NFC').replace(/[\x00-\x1f\x7f]/g,' ').replace(/[:/\\*?"<>|\[\]#^]/g,c=>replacements[c]).replace(/\s+/g,' ').trim().replace(/^[. ]+|[. ]+$/g,'');
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value='_'+value;
  let result='';for(const char of value){if(Buffer.byteLength(result+char,'utf8')>175)break;result+=char;}
  return result.trim().replace(/[. ]+$/g,'')||`Untitled (${id})`;
}
export async function publish(path,content) {
  const temporary=`${path}.${randomUUID()}.tmp`;
  try {await writeFile(temporary,content,{flag:'wx'});await link(temporary,path);}
  finally {await rm(temporary,{force:true});}
}
export async function readIdentifiedNote(path) {
  try {
    if(!(await lstat(path)).isFile()) return null;
    const text=await readFile(path,'utf8'),parsed=parseFrontmatter(text);
    if(!parsed) return null;
    const id=noteId(parsed.metadata);
    return id?{path,text,id,...parsed,translated:parsed.metadata.translation_status==='completed'}:null;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function findNote(directory,id,{translated=false}={}) {
  let files;try{files=await readdir(directory);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  for(const file of files.filter(f=>f.endsWith('.md')).sort()) {
    const note=await readIdentifiedNote(join(directory,file));
    if(note?.id===id&&note.translated===translated)return note;
  }
  return null;
}
export async function publishNamedNote(directory,title,id,content,{translated=false}={}) {
  const stem=titleFilename(title,id),variant=translated?'.zh-CN':'';
  for(let attempt=0;attempt<100;attempt++) {
    const suffix=attempt?` (${id}${attempt>1?'-'+attempt:''})`:'';
    const path=join(directory,`${stem}${suffix}${variant}.md`);
    try {await publish(path,content);return {status:'saved',notePath:path};}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      const existing=await readIdentifiedNote(path);
      if(existing?.id===id&&existing.translated===translated)return {status:'skipped-existing',notePath:path};
    }
  }
  throw new Error('NOTE_NAME_CONFLICT');
}
export function originalLinks(path) {
  const file=basename(path),stem=file.slice(0,-3);
  // URI encoding keeps spaces/parentheses safe in Markdown destinations.
  return {markdown:encodeURIComponent(file).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()),wiki:`[[${stem}]]`};
}
