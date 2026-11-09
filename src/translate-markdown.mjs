import { randomBytes } from 'node:crypto';
import { requestTranslation } from './llm.mjs';

// Keep layout, code, images and link targets outside the model's control.
// The archiver produces ATX headings, fenced code and inline Markdown links.
export async function translateMarkdown(markdown, provider, { request = requestTranslation, onBatch = async () => {}, cache = {} } = {}) {
  const nonce = randomBytes(6).toString('hex');
  const lines = markdown.split('\n'), segments = [], tasks = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
    if (fence || /^\s*$|^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line) || /^(?: {4}|\t)/.test(line)) continue;
    const prefix = line.match(/^(?:(?:>\s*)+)?(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?/)?.[0] || '';
    const protectedValues = [];
    const protect = value => { const token = `XMK_${nonce}_${protectedValues.length}_END`; protectedValues.push({ token, value }); return token; };
    // Parenthesized link URLs can contain balanced parentheses, as emitted by Turndown.
    const pattern = /!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)|(`+)[^`\n]*?\1|\]\((?:[^()\n]|\([^()\n]*\))*\)|https?:\/\/[^\s<>]+|<[^>]+>|\\.|\*+|_+|~+|\[|\]|\|/g;
    const text = line.slice(prefix.length).replace(pattern, protect);
    if (!/\p{L}/u.test(protectedValues.reduce((s,p)=>s.replace(p.token,''),text))) continue;
    // Bound individual paragraphs; split long plain stretches without splitting placeholders.
    const pieces = text.match(/XMK_[a-f0-9]+_\d+_END|[\s\S]/gu) || [];
    let part = '';
    const ids = [];
    const add = () => { if (part.trim()) { const id = segments.length; segments.push({ id, text: part }); ids.push(id); } part = ''; };
    for (const piece of pieces) {
      if (part.length + piece.length > 1800) {
        const boundary = part.lastIndexOf(' ');
        if (boundary > 900) { const remainder = part.slice(boundary + 1); part = part.slice(0,boundary + 1); add(); part = remainder; }
        else add();
      }
      part += piece;
    }
    add();
    tasks.push({ index, prefix, protectedValues, ids });
  }
  const translated = new Map();
  for (let start = 0; start < segments.length;) {
    const batch = []; let length = 0;
    while (start < segments.length && length + segments[start].text.length <= 4500 && batch.length < 24) { length += segments[start].text.length; batch.push(segments[start++]); }
    // Cache is deliberately keyed by batch position and uses placeholder-neutral
    // text. It belongs to one source hash/provider fingerprint in the queue.
    const batchKey = String(batch[0].id);
    const neutral = s => s.replaceAll(`XMK_${nonce}_`, 'XMK_CACHE_');
    const saved = cache[batchKey];
    const output = saved ? saved.map(x=>({...x,text:x.text.replaceAll('XMK_CACHE_',`XMK_${nonce}_`)})) : await request(provider, batch);
    if (!Array.isArray(output) || output.length !== batch.length) throw new Error('LLM_SEGMENT_MISMATCH');
    for (let i = 0; i < batch.length; i++) {
      const input = batch[i], result = output[i];
      if (result.id !== input.id || typeof result.text !== 'string' || !result.text.trim() || /[\r\n]/.test(result.text)) throw new Error('LLM_SEGMENT_MISMATCH');
      const tokens = s => s.match(/XMK_[a-f0-9]+_\d+_END/g) || [];
      if (JSON.stringify(tokens(result.text)) !== JSON.stringify(tokens(input.text))) throw new Error('LLM_MARKUP_CHANGED');
      const plainInput = input.text.replace(/XMK_[a-f0-9]+_\d+_END/g,'');
      if (plainInput.length > 80 && /\p{L}{3}/u.test(plainInput) && !/\p{Script=Han}/u.test(result.text) && result.text === input.text) throw new Error('LLM_NOT_TRANSLATED');
      // Escape model-generated Markdown/HTML; original markup is restored later.
      translated.set(input.id, result.text.split(/(XMK_[a-f0-9]+_\d+_END)/g).map(part => /^XMK_[a-f0-9]+_\d+_END$/.test(part) ? part : part.replace(/[\\`*_[\]<>|~]/g,'\\$&')).join(''));
    }
    if (!saved) { cache[batchKey] = output.map(x=>({...x,text:neutral(x.text)})); await onBatch(cache); }
  }
  for (const task of tasks) {
    let text = task.ids.map(id=>translated.get(id)).join('');
    for (const {token,value} of task.protectedValues) text = text.replace(token,value);
    lines[task.index] = task.prefix + text;
  }
  return lines.join('\n');
}
