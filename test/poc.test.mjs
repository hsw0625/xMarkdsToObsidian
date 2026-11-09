import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { extract, sourceIdentity } from '../src/extract.mjs';
import { archive } from '../src/archive.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}.html`, import.meta.url), 'utf8');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

test('X Article preserves heading, inline image order, list, code, quotation; excludes chrome/replies', async () => {
  const item = extract(await fixture('article'), 'https://x.com/example/status/123');
  assert.equal(item.kind, 'x-article'); assert.equal(item.images.length, 2);
  assert.deepEqual(item.headings, ['A useful heading']);
  assert.match(item.markdown, /\*\*emphasis\*\*/); assert.doesNotMatch(item.markdown, /\*{4}|42K|Bookmark|Do not capture|\.noise/);
  assert.match(item.markdown, /```js\nconst answer = 42;/);
  assert.match(item.markdown, /> A quotation/); assert.match(item.markdown, /-\s+First item/);
  const before = item.markdown.indexOf('Before the inline image');
  const img = item.markdown.indexOf('https://images.example/inline.png');
  const after = item.markdown.indexOf('After the inline image');
  assert.ok(before < img && img < after);
});

test('Chinese post matches requested ID and preserves paragraphs; excludes avatar and other posts', async () => {
  const item = extract(await fixture('post'), 'https://x.com/example/status/124');
  assert.equal(item.language, 'zh'); assert.equal(item.images.length, 1);
  assert.match(item.markdown, /标题。\s*\n\s*\n这是正文/);
  assert.doesNotMatch(item.markdown, /其他帖子|avatar|Views|translation/);
});

test('fail closed for login pages, article previews and truncated posts', () => {
  const url = 'https://x.com/example/status/123';
  assert.throws(() => extract('<html>Log in</html>', url), /X_POST_NOT_FOUND/);
  assert.throws(() => extract('<article><a href="/example/status/123">Date</a><h1 data-article-part="title">Preview</h1></article>', url), /X_BODY_MISSING/);
  assert.throws(() => extract('<article><a href="/example/status/123">Date</a><div class="whitespace-pre-wrap" dir="auto">Preview</div><button>Show more</button></article>', url), /X_TRUNCATED/);
});

test('streamed X response prefers populated article over an earlier empty shell for the same ID', async () => {
  const html = (await fixture('article')).replace('<body>', '<body><article><a href="/example/status/123">Date</a></article>');
  const item = extract(html, 'https://x.com/example/status/123');
  assert.equal(item.kind, 'x-article');
  assert.match(item.markdown, /The final paragraph/);
});

test('archives images, emits parseable YAML, deduplicates and never overwrites annotations', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'xmarks-test-'));
  try {
    const item = extract(await fixture('article'), 'https://x.com/example/status/123');
    let downloads = 0;
    const opts = { vault, notes: '收件箱/X', attachments: '附件/X', tags: ['AI', '带冒号: 标签'], fetchImage: async () => { downloads++; return { bytes: image, mime: 'image/png' }; } };
    const result = await archive(item, opts);
    let note = await readFile(result.notePath, 'utf8');
    const meta = YAML.parse(note.split('---\n')[1]);
    assert.equal(meta.source, item.source); assert.equal(meta.tweet_id, '123');
    assert.equal(meta.aliases[0], item.title); assert.equal(meta.tags[1], '带冒号: 标签');
    assert.equal(meta.translation_status, 'pending'); assert.equal(meta.media_status, 'complete');
    assert.doesNotMatch(note, /!\[[^\]]*\]\(https?:/);
    for (const match of note.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) await access(resolve(dirname(result.notePath), decodeURIComponent(match[1])));
    note += '\nMy annotation\n'; await writeFile(result.notePath, note);
    assert.equal((await archive(item, opts)).status, 'skipped-existing');
    assert.equal(downloads, 2); assert.equal(await readFile(result.notePath, 'utf8'), note);
  } finally { await rm(vault, { recursive: true, force: true }); }
});

test('failed image stays remote and is reported as partial, never marked saved', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'xmarks-failure-'));
  try {
    const item = extract(await fixture('post'), 'https://x.com/example/status/124');
    const result = await archive(item, { vault, fetchImage: async () => ({ bytes: Buffer.from('<html>Error</html>'), mime: 'image/png' }) });
    assert.equal(result.metadata.media_status, 'partial');
    assert.equal(result.images[0].status, 'failed');
    assert.match(await readFile(result.notePath, 'utf8'), /!\[.*\]\(https:\/\/pbs/);
  } finally { await rm(vault, { recursive: true, force: true }); }
});

test('normalizes X query parameters and rejects unsupported destinations', async () => {
  assert.equal(sourceIdentity('https://twitter.com/example/status/123?s=20').source, 'https://x.com/example/status/123');
  assert.throws(() => sourceIdentity('file:///etc/passwd'));
  assert.throws(() => sourceIdentity('https://x.com/i/bookmarks'));
  const item = extract(await fixture('post'), 'https://x.com/example/status/124');
  await assert.rejects(archive(item, { vault: '/tmp/example-vault', notes: '../escape' }), /within the vault/);
});

test('multi-fragment X Articles keep all prose, interleaved code/media and final section exactly once', () => {
  const article=`<article><a href="/example/status/123">Date</a>
    <h1 data-article-part="title">Whole article</h1>
    <div data-article-part="body"><style>.noise{color:red}</style><div class="x-article-body">
      <div data-article-body-html><p>Opening paragraph</p></div>
      <div data-slot="embedded-tweet-frame" data-href="/i/web/status/456"><a href="/i/web/status/456"></a><div aria-label="Loading post"></div></div>
      <div class="x-article-code"><button>Copy code</button><pre>const value = 1;\nreturn value;</pre></div>
      <div data-article-body-html><h2>Middle section</h2><img src="https://images.example/inline.png"><p>After the image</p></div>
      <div class="x-article-code"><pre><code class="language-js">console.log(value);</code></pre></div>
      <div data-article-body-html><h2>Final section</h2><p>The very last paragraph.</p></div>
    </div></div><p>18K Views</p></article>`;
  const item=extract(article+article+'<article>Unrelated reply</article>','https://x.com/example/status/123');
  assert.deepEqual(item.headings,['Middle section','Final section']);
  assert.equal(item.images.length,1);
  const markers=['Opening paragraph','https://x.com/i/web/status/456','```\nconst value = 1;\nreturn value;\n```','## Middle section','https://images.example/inline.png','After the image','```js\nconsole.log(value);\n```','## Final section','The very last paragraph.'];
  let previous=-1;
  for(const marker of markers){const at=item.markdown.indexOf(marker);assert.ok(at>previous,marker);assert.equal(item.markdown.indexOf(marker,at+1),-1,marker);previous=at;}
  assert.doesNotMatch(item.markdown,/Copy code|Views|noise|Unrelated reply/);
  assert.throws(()=>extract('<article><a href="/example/status/123">Date</a><h1 data-article-part="title">Title</h1><div data-article-body-html>First</div><div data-article-body-html>Last</div></article>','https://x.com/example/status/123'),/X_BODY_CONTAINER_MISSING/);
});
