import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readJSON, atomicJSON } from './state.mjs';

export const destinationFor = config => JSON.stringify([config.vault,config.notes,config.attachments]);
export function outputFromForm(form,current) {
  let vault=(form.get('vault')||'').trim();
  if(vault==='~'||vault.startsWith('~/')) vault=join(homedir(),vault.slice(1));
  if(!isAbsolute(vault)||/[\0\r\n]/.test(vault)) throw new Error('OUTPUT_VAULT_ABSOLUTE_REQUIRED');
  vault=resolve(vault);
  const result={...current,vault};
  for(const field of ['notes','attachments']) {
    const value=(form.get(field)||'').trim();
    if(!value||isAbsolute(value)||/[\0\r\n]/.test(value)||value.split(/[\\/]/).includes('..')) throw new Error('OUTPUT_SUBDIRECTORY_REQUIRED');
    const target=resolve(vault,value);
    if(!target.startsWith(vault+sep)) throw new Error('OUTPUT_OUTSIDE_VAULT');
    result[field]=relative(vault,target);
  }
  if(result.notes==='Originals') throw new Error('OUTPUT_RESERVED_DIRECTORY');
  return result;
}

export async function validateOutput(config) {
  try {
    await mkdir(config.vault,{recursive:true});
    const root=await realpath(config.vault);
    for(const name of [config.notes,config.attachments,'Originals']) {
      const target=join(config.vault,name);
      // Check each existing ancestor before creating deeper directories.
      let cursor=config.vault;
      for(const part of name.split(sep)) {
        cursor=join(cursor,part);
        try { if(!(await realpath(cursor)).startsWith(root+sep)) throw new Error('OUTPUT_OUTSIDE_VAULT'); }
        catch(e) { if(e.code!=='ENOENT') throw e; }
      }
      await mkdir(target,{recursive:true});
      if(!(await realpath(target)).startsWith(root+sep)) throw new Error('OUTPUT_OUTSIDE_VAULT');
      const probe=join(target,`.xmarks-write-test-${randomUUID()}`);
      const f=await open(probe,'wx',0o600);
      try { await f.close(); } finally { await rm(probe,{force:true}); }
    }
  } catch(e) {
    if(e.message==='OUTPUT_OUTSIDE_VAULT') throw e;
    throw new Error('OUTPUT_NOT_WRITABLE');
  }
}

// A durable intent journal makes the three-file change recoverable if the
// process exits midway. Only explicit UI changes create this journal.
export async function recoverOutputChange(stateDir) {
  const path=join(stateDir,'output-change.json');
  const change=await readJSON(path,null);
  if(!change) return;
  if(change.version!==1||!change.config) throw new Error('OUTPUT_CHANGE_INVALID');
  const next=change.config;
  const translationPath=join(stateDir,'translation-state.json');
  const translations=await readJSON(translationPath,null);
  if(translations) {
    if(!translations.destination||!translations.jobs) throw new Error('TRANSLATION_STATE_INVALID');
    for(const job of Object.values(translations.jobs)) job.directory??=translations.destination;
    translations.destination=resolve(next.vault,next.notes);
    await atomicJSON(translationPath,translations);
  }
  const syncPath=join(stateDir,'state.json');
  const sync=await readJSON(syncPath,null);
  if(sync) { sync.destination=destinationFor(next); await atomicJSON(syncPath,sync); }
  await atomicJSON(join(stateDir,'config.json'),next);
  await rm(path);
}

export async function saveOutputChange(stateDir,config) {
  await validateOutput(config);
  await atomicJSON(join(stateDir,'output-change.json'),{version:1,config});
  await recoverOutputChange(stateDir);
}
