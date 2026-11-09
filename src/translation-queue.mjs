import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { atomicJSON, readJSON } from './state.mjs';
import { findNote, noteId, originalLinks, publishNamedNote } from './note-files.mjs';
import { translateMarkdown } from './translate-markdown.mjs';
import { safeError } from './sync.mjs';
import { orderedProviders } from './llm.mjs';

export function parseNote(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('TRANSLATION_INVALID_NOTE');
  const metadata = YAML.parse(match[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('TRANSLATION_INVALID_NOTE');
  return { metadata, body: match[2] };
}
export async function createTranslationQueue({ stateDir, vault, notes, getConfig, translate = translateMarkdown, now = () => Date.now() }) {
  const statePath = join(stateDir, 'translation-state.json');
  const directory = resolve(vault, notes);
  if (!directory.startsWith(resolve(vault) + sep)) throw new Error('INVALID_DESTINATION');
  const state = await readJSON(statePath, { version: 1, destination: directory, jobs: {} });
  if (state.version !== 1 || !state.jobs || state.destination !== directory) throw new Error('TRANSLATION_STATE_INVALID');
  for(const job of Object.values(state.jobs)) job.directory??=state.destination;
  const save = () => atomicJSON(statePath,state);
  const enqueue = async notePath => {
    const file = basename(notePath);
    if (!file.endsWith('.md') || resolve(notePath) !== join(directory,file)) throw new Error('TRANSLATION_INVALID_PATH');
    const snapshot = await readFile(notePath,'utf8');
    let parsed;try{parsed=parseNote(snapshot);}catch{return false;}
    const { metadata, body } = parsed, id=noteId(metadata);
    if(!id||!/^\d+$/.test(id)||metadata.translation_status==='completed') return false;
    if (Object.values(state.jobs).some(job=>job.id===id&&job.directory===directory)) return false;
    if (metadata.original_language === 'zh' && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(body)) return false;
    const key=createHash('sha256').update(JSON.stringify([directory,id])).digest('hex');
    state.jobs[key] = { id, directory, originalPath:resolve(notePath), status: 'pending', snapshot, attempts: 0, nextAttemptAt: 0, cache: {}, createdAt: new Date(now()).toISOString() };
    await save(); return true;
  };
  return {
    enqueue,
    summary() { const jobs = Object.values(state.jobs); return { pending: jobs.filter(x=>x.status==='pending').length, completed: jobs.filter(x=>x.status==='done').length, retrying: jobs.filter(x=>x.status==='pending'&&x.attempts).length, errors: [...new Set(jobs.filter(x=>x.status==='pending'&&x.lastError).map(x=>x.lastError))] }; },
    async backfill() {
      let count = 0; let files;
      try { files = await readdir(directory); } catch(e) { if(e.code==='ENOENT') return 0; throw e; }
      for (const file of files) if (file.endsWith('.md')) count += Number(await enqueue(join(directory,file)));
      return count;
    },
    async retry() { for (const job of Object.values(state.jobs)) if(job.status==='pending') job.nextAttemptAt = 0; await save(); },
    async run() {
      const config = getConfig();
      if (!config.enabled) return;
      const providers = orderedProviders(config);
      if (!providers.length) return;
      for (const job of Object.values(state.jobs).filter(j=>j.status==='pending'&&j.nextAttemptAt<=now()).slice(0,2)) {
        try {
          const existing=await findNote(job.directory,job.id,{translated:true});
          if (existing) {
            job.notePath=existing.path;
          } else {
            const original=await findNote(job.directory,job.id);
            if(!original)throw new Error('ORIGINAL_NOTE_MISSING');
            job.originalPath=original.path;
            const links=originalLinks(original.path);
            const { metadata, body } = parseNote(job.snapshot);
            let translated, provider;
            job.providerErrors = [];
            job.providerCaches ??= {};
            for (const candidate of providers) {
              const identity = [candidate.id,candidate.type,candidate.baseURL,candidate.model,candidate.maxTokens,body];
              const legacyFingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
              const fingerprint = createHash('sha256').update(JSON.stringify([...identity,candidate.tokenParameter])).digest('hex');
              // Retain pre-fallback checkpoints, then isolate each provider's batches.
              job.providerCaches[fingerprint] ??= job.fingerprint === legacyFingerprint ? (job.cache || {}) : {};
              const cache = job.providerCaches[fingerprint];
              try {
                translated = await translate(body,candidate,{ cache, onBatch: async updated=>{
                  job.providerCaches[fingerprint] = updated;
                  try { await save(); } catch (cause) { throw new Error('TRANSLATION_CHECKPOINT_FAILED', { cause }); }
                } });
                provider = candidate;
                break;
              } catch (error) {
                // A local checkpoint failure must not trigger more paid model calls.
                if (error.message === 'TRANSLATION_CHECKPOINT_FAILED') throw error;
                job.providerErrors.push({ providerId:candidate.id, model:candidate.model, error:safeError(error) });
                await save();
              }
            }
            if (!provider) throw new Error(providers.length === 1 ? job.providerErrors[0].error : 'LLM_ALL_PROVIDERS_FAILED');
            const title = translated.match(/^\s*# (.+)/)?.[1];
            const meta = { ...metadata, aliases: [...new Set([...(Array.isArray(metadata.aliases)?metadata.aliases:[]), ...(title?[title]:[])])],
              language: 'zh-CN', translation_status: 'completed', translated_at: new Date(now()).toISOString(),
              translation_provider: provider.name, translation_model: provider.model, original_note: links.wiki };
            const content = `---\n${YAML.stringify(meta)}---\n\n> 中文译文 · [查看原文](${links.markdown}) · AI 翻译，请结合原文核对。\n\n${translated.trim()}\n\n> [!quote]- 展开原文对照\n> !${links.wiki}\n`;
            const published=await publishNamedNote(job.directory,title||metadata.aliases?.[0]||job.id,job.id,content,{translated:true});
            job.notePath=published.notePath;
          }
          job.status = 'done'; job.completedAt = new Date(now()).toISOString(); job.lastError = null; delete job.cache; delete job.fingerprint; delete job.providerCaches; delete job.snapshot;
        } catch(error) {
          job.attempts++; job.lastError = safeError(error);
          job.nextAttemptAt = now() + Math.min(3600000,60000 * 2 ** Math.min(job.attempts-1,6));
        }
        await save();
      }
    },
  };
}
