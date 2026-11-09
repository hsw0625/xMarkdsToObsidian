import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { download } from './io.mjs';
import { extract } from './extract.mjs';
import { archive } from './archive.mjs';
import { findNote } from './note-files.mjs';

export function createWorker(config) {
  return async job => {
    if (!/^\d+$/.test(job.id)) throw new Error('INVALID_JOB_ID');
    const notes = resolve(config.vault, config.notes);
    if (!notes.startsWith(resolve(config.vault) + sep)) throw new Error('INVALID_DESTINATION');
    const existing=await findNote(notes,job.id);
    if(existing)return {status:'skipped-existing',notePath:existing.path};
    const html = (await download(job.url)).bytes.toString('utf8');
    const item = extract(html, job.url);
    if (item.id !== job.id) throw new Error('POST_ID_MISMATCH');
    const rawDir = resolve('output/raw'); await mkdir(rawDir, { recursive: true });
    await writeFile(join(rawDir, `${job.id}.html`), html);
    return archive(item, { ...config, requireAllImages: true });
  };
}
