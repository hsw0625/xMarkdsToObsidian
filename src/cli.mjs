import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { extract, sourceIdentity } from './extract.mjs';
import { archive } from './archive.mjs';
import { download } from './io.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    html: { type: 'string' }, vault: { type: 'string', default: 'output/vault' },
    notes: { type: 'string', default: 'Inbox/X' }, attachments: { type: 'string', default: 'attachments/x' },
    tag: { type: 'string', multiple: true },
  }});
  if (positionals.length !== 1) throw new Error('Usage: npm run clip -- URL [--html snapshot.html] [--vault path] [--notes Inbox/X] [--attachments attachments/x] [--tag AI]');
  const identity = sourceIdentity(positionals[0]);
  const html = values.html ? await readFile(values.html, 'utf8') : (await download(identity.source)).bytes.toString('utf8');
  const rawDir = resolve('output/raw');
  await mkdir(rawDir, { recursive: true });
  await writeFile(join(rawDir, `${identity.id}.html`), html);
  const item = extract(html, identity.source);
  const result = await archive(item, { ...values, tags: values.tag || ['X收藏'] });
  console.log(JSON.stringify(result, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
