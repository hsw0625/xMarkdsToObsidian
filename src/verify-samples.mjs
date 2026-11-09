import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { imageExtension } from './archive.mjs';
import { findNote } from './note-files.mjs';

// Independent comparison: original HTTP DOM text versus rendered saved Markdown.
const samples = [
  { id: '2117512471930167377', selector: '[data-article-body-html]', images: 2, paragraphs: 56, headings: 8, listItems: 8 },
  { id: '2118065161290616833', selector: 'article div.whitespace-pre-wrap[dir="auto"]', images: 1 },
];
const results = [];
for (const sample of samples) {
  const sourceDom = new JSDOM(await readFile(`output/raw/${sample.id}.html`, 'utf8'));
  const source = sourceDom.window.document.querySelector(sample.selector);
  assert.ok(source, 'Source body must exist');
  const notePath = (await findNote(resolve('output/vault/Inbox/X'),sample.id))?.path;
  assert.ok(notePath,'Saved note must exist by archive ID');
  const note = await readFile(notePath, 'utf8');
  const body = note.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*# [^\n]*\n/, '');
  const rendered = new JSDOM(marked.parse(body));
  const output = rendered.window.document.body;
  const normalized = text => text.replace(/\s+/g, '');
  assert.equal(normalized(output.textContent), normalized(source.textContent), 'All source text must survive, in order');
  for (const [count, selector] of [['paragraphs','p'], ['headings','h1,h2,h3,h4,h5,h6'], ['listItems','li']]) {
    // Markdown wraps standalone images in <p>; those are not text paragraphs.
    if (sample[count] !== undefined) assert.equal([...output.querySelectorAll(selector)].filter(e => count !== 'paragraphs' || e.textContent.trim()).length, sample[count]);
  }
  const imgs = [...output.querySelectorAll('img')];
  assert.equal(imgs.length, sample.images);
  for (const img of imgs) {
    assert.ok(!/^https?:/.test(img.getAttribute('src')), 'Reading note must use local images');
    const bytes = await readFile(resolve(dirname(notePath), decodeURIComponent(img.getAttribute('src'))));
    imageExtension(bytes);
  }
  assert.doesNotMatch(body, /profile_images|__xClientTextFormatters|tailwindcss|Show translation/);
  results.push({ id: sample.id, notePath, exactTextAfterWhitespaceNormalization: true, normalizedCharacters: normalized(source.textContent).length, localImages: imgs.length, ...(sample.paragraphs ? { paragraphs: sample.paragraphs, headings: sample.headings, listItems: sample.listItems } : {}) });
  sourceDom.window.close(); rendered.window.close();
}
await writeFile('output/verification.json', JSON.stringify({ verifiedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
