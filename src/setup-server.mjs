import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { safeError } from './sync.mjs';
import { translationUI } from './translation-ui.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function setupServer({ port, status, configure, configureTranslation, configureOutput }) {
  const csrf = randomBytes(32).toString('hex');
  const scriptNonce = randomBytes(24).toString('base64');
  const host = `127.0.0.1:${port}`, origin = `http://${host}`;
  let configuring = false;
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    // no-referrer makes native (non-CORS) form POSTs send Origin: null.
    // Keep the same-origin Origin intact; cross-origin referrers remain omitted.
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    if (req.headers.host !== host) { res.writeHead(403); return res.end('Host rejected'); }
    // A custom header forces cross-origin browsers to preflight; this server
    // allows no CORS preflight. Same-origin pages can renew after a restart.
    if (req.method === 'GET' && req.url === '/csrf') {
      if (req.headers['x-csrf-refresh'] !== '1' || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403); return res.end('Origin rejected'); }
      res.setHeader('Content-Type','application/json; charset=utf-8'); return res.end(JSON.stringify({csrf}));
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('Content-Type','application/json; charset=utf-8'); return res.end(JSON.stringify(status()));
    }
    const llmAction=req.url?.match(/^\/llm\/(provider|settings|delete|test|backfill|retry)$/)?.[1];
    const outputAction=req.url==='/output'&&configureOutput;
    if (req.method === 'POST' && (req.url === '/setup' || (llmAction && configureTranslation) || outputAction)) {
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { res.writeHead(403); return res.end('Origin rejected'); }
      if (configuring) { res.writeHead(409); return res.end('Configuration already in progress'); }
      configuring = true;
      try {
        const chunks=[];let size=0;
        for await (const chunk of req) { size += chunk.length; if(size>131072) throw new Error('INPUT_TOO_LARGE'); chunks.push(chunk); }
        const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const supplied = Buffer.from(form.get('csrf') || '');
        if(supplied.length !== csrf.length || !timingSafeEqual(supplied,Buffer.from(csrf))) {
          res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8','X-CSRF-Expired':'1'});
          return res.end('页面验证已过期（后台可能已重启）。输入已保留；请刷新页面后重试。');
        }
        if(outputAction) await configureOutput(form);
        else if(llmAction) await configureTranslation(llmAction,form);
        else await configure(form.get('request') || '');
        if(llmAction==='test') { res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('连接测试通过，已收到有效翻译响应。'); }
        res.writeHead(303,{Location:'/'}); return res.end();
      } catch(error) {
        res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});
        const option = /^--?[a-zA-Z][a-zA-Z0-9.-]{0,40}$/.test(error.option || '') ? `（选项 ${error.option}）` : '';
        if(outputAction) {
          const descriptions={SYNC_BUSY:'正在同步或翻译，请完成后再保存。',OUTPUT_VAULT_ABSOLUTE_REQUIRED:'笔记库请填写绝对路径，也可用 ~/ 开头。',OUTPUT_SUBDIRECTORY_REQUIRED:'笔记和图片目录请填写库内相对路径，不能包含 ..。',OUTPUT_OUTSIDE_VAULT:'目标目录必须位于笔记库内，符号链接也不能指向库外。',OUTPUT_RESERVED_DIRECTORY:'Originals 专用于原文备份，请使用其他笔记目录。',OUTPUT_NOT_WRITABLE:'无法创建或写入目录，请检查路径和系统权限。',OUTPUT_CHANGE_RECOVERY_REQUIRED:'目录设置未完全保存，请重启后台服务以恢复。'};
          return res.end(`目录未保存：${safeError(error)}。${descriptions[safeError(error)]||'请检查目录配置或重启后台服务后重试。'}`);
        }
        return res.end(llmAction?`操作未完成：${safeError(error)}。SYNC_BUSY 表示正在同步，请稍后重试；更换地址或接口类型时需重新输入密钥。`: `配置未保存：${safeError(error)}${option}。请确认复制的是 Bookmarks GET 请求的 cURL (bash)。输入内容不会回显。`);
      } finally { configuring=false; }
    }
    if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404); return res.end('Not found'); }
    const info = status();
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>X 书签增量同步</title>
<style>body{font:16px/1.7 system-ui;max-width:900px;margin:48px auto;padding:0 24px;color:#172b36;background:#f7faf9}h1{font-size:28px}section{background:white;padding:24px;margin:20px 0;border:1px solid #dce7e2;border-radius:12px}textarea{box-sizing:border-box;width:100%;height:160px;font:13px monospace;padding:12px}button{padding:12px 20px;background:#12664f;color:white;border:0;border-radius:6px;font-size:16px;cursor:pointer}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#50655c;display:block}a{color:#12664f}.fields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}.wide{grid-column:1/-1}input:not([type=checkbox]):not([type=hidden]),select{display:block;box-sizing:border-box;width:100%;padding:10px;border:1px solid #acbfb5;border-radius:5px;font:inherit}details{border-top:1px solid #dce7e2;padding:16px 0}summary{cursor:pointer;font-weight:600}.actions{display:flex;gap:16px;flex-wrap:wrap}.actions form{flex:1}.error,[role=alert]{color:#90421c}.secondary{background:#56675e}@media(max-width:600px){.fields{grid-template-columns:1fr}}</style>
<h1>X 书签 → Obsidian</h1><p>首次只记录已有书签；之后每 ${escape(info.intervalSeconds)} 秒检查一次，仅保存新增条目。</p>
<section><h2>监听状态</h2><p>${info.configured?'已配置登录态':'等待本机配置'} · ${info.running?'正在同步':'等待下一次检查'}</p><p>笔记目录：${escape(info.destination)}</p><pre>${escape(JSON.stringify(info.sync,null,2))}</pre><a href="/">刷新状态</a> · <a href="/status">查看状态 JSON</a></section>
${info.output?`<section><h2>输出目录</h2><form method="post" action="/output" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><div class="fields">
<label class="wide">Obsidian 笔记库路径<input name="vault" required value="${escape(info.output.vault)}" placeholder="/Users/你的用户名/Documents/Obsidian"></label>
<label>笔记子目录<input name="notes" required value="${escape(info.output.notes)}" placeholder="Inbox/X"></label>
<label>图片子目录<input name="attachments" required value="${escape(info.output.attachments)}" placeholder="attachments/x"></label></div>
<p><small>库路径支持绝对路径或 ~/；子目录相对于笔记库。中文译文与原文放在同一笔记目录，原始备份保存在库内 Originals。保存时会创建并验证目录。</small></p>
<p>保存后立即生效，只影响之后归档的内容。已有文件留在原处，待翻译任务仍写回各自原文目录；保留书签去重记录。</p>
<button type="submit">保存输出目录</button><p role="alert" aria-live="polite"></p></form></section>`:''}
${translationUI(info,csrf)}
<section><h2>${info.configured?'更新登录态或接口请求':'配置 X 登录态'}</h2>
<ol><li>在你已登录 X 的浏览器里打开 <a href="https://x.com/i/bookmarks" target="_blank" rel="noreferrer">书签页</a>。</li><li>打开开发者工具（Mac：⌥⌘I），进入 Network / 网络，筛选 <code>Bookmarks</code>，刷新页面。</li><li>找到地址以 <code>/i/api/graphql/…/Bookmarks?</code> 开头、成功返回 JSON 的 GET 请求。右键 → Copy → Copy as cURL (bash)。不要复制 CreateBookmark 或 DeleteBookmark。</li><li>粘贴到下面。此内容含登录凭据，只在本机页面提交，不要发到聊天里。</li></ol>
<form method="post" action="/setup" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label for="request">Bookmarks 请求</label><textarea id="request" name="request" required spellcheck="false" autocomplete="off" placeholder="curl 'https://x.com/i/api/graphql/…/Bookmarks?…' …"></textarea><p><button type="submit">验证并启动增量监听</button></p><p role="alert" id="setup-message" aria-live="polite"></p></form>
<script nonce="${scriptNonce}">
document.querySelectorAll('form').forEach(form => form.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button');
  const message = form.querySelector('[role=alert]');
  button.disabled = true; message.textContent = '正在验证，请稍候…';
  try {
    const body = new URLSearchParams(new FormData(form));
    const submit = () => fetch(form.action, { method: 'POST', body, credentials: 'same-origin' });
    let response = await submit();
    // Retry only the explicit CSRF rejection, which occurs before any action.
    // Do not replay timeouts, network failures, or provider errors.
    if (response.status === 403 && response.headers.get('X-CSRF-Expired') === '1') {
      const renewed = await fetch('/csrf', { headers: { 'X-CSRF-Refresh': '1' }, credentials: 'same-origin', cache: 'no-store' });
      if (!renewed.ok) { message.textContent = '无法更新页面验证。输入已保留，请稍后重试。'; return; }
      const { csrf } = await renewed.json();
      if (typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf)) throw new Error('Invalid token');
      document.querySelectorAll('input[name=csrf]').forEach(input=>{input.value=csrf;});
      body.set('csrf',csrf);
      response = await submit();
    }
    if (!response.ok) { message.textContent = await response.text(); return; }
    if(form.action.endsWith('/test')) { message.textContent = await response.text(); return; }
    form.querySelectorAll('textarea,input[type=password]').forEach(input=>{input.value='';});
    location.replace('/');
  } catch { message.textContent = '无法连接本机服务。输入已保留，可以稍后重试。'; }
  finally { button.disabled = false; }
}));
</script>
<small>只解析请求，不执行粘贴的命令。仅保留必要字段，保存为本机仅当前用户可读写的文件；登录头只发送到 x.com。正文与图片写入配置的目录。取消 X 书签不会删除本地笔记。</small></section></html>`);
  });
  server.requestTimeout=60000;
  return server;
}
