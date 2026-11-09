import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { createHash } from 'node:crypto';

export function sourceIdentity(source) {
  const url = new URL(source);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP(S) sources are supported');
  const isX = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname);
  const match = isX && url.pathname.match(/^\/([^/]+)\/(?:status|article)\/(\d+)\/?$/);
  if (isX && !match) throw new Error('Provide a specific X status or article URL');
  url.hash = '';
  return match
    ? { id: match[2], source: `https://x.com/${match[1]}/status/${match[2]}`, handle: match[1], isX: true }
    : { id: createHash('sha256').update(url.href).digest('hex').slice(0, 20), source: url.href, isX: false };
}

export function extract(html, source) {
  const identity = sourceIdentity(source);
  const dom = new JSDOM(html, { url: identity.source }); // No scripts or remote resources executed.
  const doc = dom.window.document;
  const meta = name => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content;
  let root, title, author, kind, warnings = [];
  if (identity.isX) {
    // Match the requested post, never an arbitrary reply or a metadata-only preview.
    const candidates = [...doc.querySelectorAll('article')].filter(a =>
      [...a.querySelectorAll('a[href]')].some(link => {
        try { return new URL(link.href).pathname === new URL(identity.source).pathname; } catch { return false; }
      }));
    // Streaming SSR can include an empty mobile shell before a populated copy.
    const article = candidates.find(a => a.querySelector('[data-article-body-html]'))
      || candidates.find(a => a.querySelector('[data-testid="tweetText"], div.whitespace-pre-wrap[dir="auto"]'))
      || candidates[0];
    if (!article) throw new Error('X_POST_NOT_FOUND: login shell, blocked response, or unsupported markup');
    const blocks = [...article.querySelectorAll('[data-article-body-html]')];
    // X splits prose around code and embedded media. The marker identifies a
    // fragment, not the whole article; capture their container in DOM order.
    const container = article.querySelector('[data-article-part="body"], .x-article-body');
    if (blocks.length > 1 && !container) throw new Error('X_BODY_CONTAINER_MISSING: refusing to save only the first fragment');
    const body = blocks.length ? (container || blocks[0]) : null;
    const heading = article.querySelector('[data-article-part="title"]');
    root = doc.createElement('section');
    if (body && heading) {
      kind = 'x-article';
      title = heading.textContent.trim();
      const cover = article.querySelector('[data-article-part="cover"] img');
      if (cover) root.append(cover.cloneNode(true));
      root.append(body.cloneNode(true));
    } else {
      const text = article.querySelector('[data-testid="tweetText"], div.whitespace-pre-wrap[dir="auto"]');
      if (!text || article.querySelector('[data-article-part="title"], [data-article-part="cover"]')) {
        throw new Error('X_BODY_MISSING: refusing to save an article card or preview as full text');
      }
      if ([...article.querySelectorAll('button,a')].some(x => /^(Show more|显示更多)$/.test(x.textContent.trim()))) {
        throw new Error('X_TRUNCATED: expand the post before capturing');
      }
      kind = 'x-post';
      title = text.textContent.trim().split('\n')[0].slice(0, 100);
      // X uses CSS whitespace preservation; convert actual newlines explicitly.
      const copy = text.cloneNode(true);
      const walker = doc.createTreeWalker(copy, dom.window.NodeFilter.SHOW_TEXT);
      const textNodes = []; while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const node of textNodes) {
        const parts = node.textContent.split('\n');
        if (parts.length > 1) node.replaceWith(...parts.flatMap((part, i) => i ? [doc.createElement('br'), doc.createTextNode(part)] : [doc.createTextNode(part)]));
      }
      root.append(copy);
      const seen = new Set();
      for (const img of article.querySelectorAll('img[src]')) {
        if (img.closest('article') !== article || !img.src.startsWith('https://pbs.twimg.com/media/') || seen.has(img.src)) continue;
        seen.add(img.src); root.append(img.cloneNode(true));
      }
      warnings.push('Single post only; reply/thread completeness is not verified.');
    }
    author = meta('og:title')?.split(' on X')[0]?.replace(/ \(@[^)]+\)$/, '') || identity.handle;
  } else {
    const parsed = new Readability(doc.cloneNode(true)).parse();
    if (!parsed || parsed.textContent.trim().length < 100) throw new Error('ARTICLE_NOT_FOUND: insufficient readable content');
    title = parsed.title; author = parsed.byline || ''; kind = 'external-article';
    root = doc.createElement('section'); root.innerHTML = parsed.content;
    warnings.push('Readability extraction; compare with source for paywalls, lazy images, and omitted content.');
  }
  root.querySelectorAll('script,style,noscript,svg,button,iframe,form').forEach(x => x.remove());
  // Some X code blocks are bare <pre>; Turndown fences only <pre><code>.
  for (const pre of root.querySelectorAll('pre')) {
    if (!pre.querySelector('code')) {
      const code = doc.createElement('code'); code.textContent = pre.textContent;
      pre.replaceChildren(code);
    }
  }
  // Lazy embedded posts can be empty in SSR. Preserve their source explicitly.
  for (const embed of root.querySelectorAll('[data-slot="embedded-tweet-frame"]')) {
    const href = embed.getAttribute('data-href') || embed.querySelector('a[href]')?.getAttribute('href');
    if (href) {
      const link = doc.createElement('a'); link.href = href; link.textContent = 'Embedded post';
      const quote = doc.createElement('blockquote'); quote.append(link);
      embed.replaceWith(quote);
      warnings.push('Embedded post retained as source link; embedded post text is not archived.');
    }
  }
  // Avoid duplicated Markdown emphasis from X's nested <b><strong> markup.
  root.querySelectorAll('b > strong, i > em').forEach(x => x.replaceWith(...x.childNodes));
  for (const a of root.querySelectorAll('a[href]')) {
    const url = new URL(a.getAttribute('href'), identity.source);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) a.href = url.href;
    else a.removeAttribute('href');
    if (a.children.length === 1 && a.firstElementChild.tagName === 'IMG') a.replaceWith(a.firstElementChild);
  }
  const images = [];
  for (const img of root.querySelectorAll('img')) {
    let src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) { img.remove(); continue; }
    const url = new URL(src, identity.source);
    if (!['https:', 'http:'].includes(url.protocol)) { img.remove(); warnings.push('Skipped non-HTTP image'); continue; }
    img.src = url.href;
    images.push({ url: url.href, alt: img.alt || '' });
  }
  const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(x => x.textContent.trim());
  const text = root.textContent.trim();
  if (!text) throw new Error('EMPTY_BODY');
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const language = han / Math.max(1, text.replace(/\s/g, '').length) > 0.25 ? 'zh' : 'und';
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  const markdown = converter.turndown(root.innerHTML);
  dom.window.close();
  return { ...identity, kind, title, author, language, markdown, images, headings, textLength: text.length, warnings, extractionStatus: 'body-extracted-unverified' };
}
