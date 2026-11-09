import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { download } from './io.mjs';
import { publish, findNote, publishNamedNote } from './note-files.mjs';
export { publish } from './note-files.mjs';

function inVault(vault, path) {
  const result = resolve(vault, path);
  if (result === resolve(vault) || !result.startsWith(resolve(vault) + sep)) throw new Error('Output directory must be within the vault');
  return result;
}
export function imageExtension(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) return 'gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(4,8).toString() === 'ftyp' && ['avif','avis'].includes(bytes.subarray(8,12).toString())) return 'avif';
  throw new Error('Image signature not recognized (possibly an HTML error response)');
}
export async function archive(item, { vault = 'output/vault', notes = 'Inbox/X', attachments = 'attachments/x', tags = ['X收藏'], fetchImage = download, requireAllImages = false } = {}) {
  const notesDir = inVault(vault, notes);
  const mediaDir = inVault(vault, join(attachments, item.id));
  const originalDir = inVault(vault, 'Originals');
  const existing=await findNote(notesDir,item.id);
  if(existing) return {status:'skipped-existing',notePath:existing.path};
  await Promise.all([notesDir, mediaDir, originalDir].map(d => mkdir(d, { recursive: true })));
  let markdown = item.markdown;
  const media = [];
  for (const { url } of [...new Map(item.images.map(i => [i.url, i])).values()]) {
    try {
      const { bytes, mime } = await fetchImage(url);
      if (!mime.startsWith('image/')) throw new Error('Response is not an image');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const path = join(mediaDir, `${hash.slice(0,16)}.${imageExtension(bytes)}`);
      try { await publish(path, bytes); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const link = relative(notesDir, path).split(sep).map(encodeURIComponent).join('/');
      markdown = markdown.split(`](${url})`).join(`](${link})`);
      media.push({ url, path: relative(resolve(vault), path), sha256: hash, bytes: bytes.length, status: 'saved' });
    } catch (e) { media.push({ url, status: 'failed', error: e.message }); }
  }
  if (requireAllImages && media.some(m => m.status === 'failed')) throw new Error('MEDIA_INCOMPLETE: retry before publishing the reading note');
  const metadata = {
    tags, source: item.source, created: new Date().toISOString(), aliases: [item.title],
    author: item.author, archive_id:item.id, ...(item.isX ? { tweet_id: item.id } : {}), content_type: item.kind,
    original_language: item.language, translation_status: item.language === 'zh' ? 'not-needed' : 'pending',
    extraction_status: item.extractionStatus, media_status: media.some(m => m.status === 'failed') ? 'partial' : 'complete',
  };
  // Original keeps remote references for provenance; the reading note uses local files.
  const originalPath = join(originalDir, `${item.id}.md`);
  try { await publish(originalPath, `# ${item.title}\n\n${item.markdown}\n`); } catch(e) { if(e.code !== 'EEXIST') throw e; }
  const content = `---\n${YAML.stringify(metadata)}---\n\n# ${item.title.replace(/[\r\n]/g, ' ')}\n\n${markdown}\n`;
  const published=await publishNamedNote(notesDir,item.title,item.id,content);
  if(published.status==='skipped-existing')return published;
  const {notePath}=published;
  const report = { status: 'saved', notePath, originalPath, id: item.id, source: item.source, title: item.title, kind: item.kind, textLength: item.textLength, headings: item.headings, images: media, warnings: item.warnings, metadata };
  await writeFile(join(originalDir, `${item.id}.report.json`), JSON.stringify(report, null, 2));
  return report;
}
