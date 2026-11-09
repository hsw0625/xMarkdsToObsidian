import { orderedProviders } from './llm.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function translationUI(info,csrf) {
  const config=info.translation||{providers:[],enabled:false};
  const hidden=`<input type="hidden" name="csrf" value="${csrf}">`;
  const form=(action,body)=>`<form method="post" action="/llm/${action}" autocomplete="off">${hidden}${body}<p role="alert" aria-live="polite"></p></form>`;
  const select=(name,values,current)=>`<select name="${name}">${values.map(([value,label])=>`<option value="${value}" ${value===current?'selected':''}>${label}</option>`).join('')}</select>`;
  const fields=(p={})=>`<input type="hidden" name="id" value="${esc(p.id)}"><div class="fields">
    <label>配置名称<input name="name" required maxlength="100" value="${esc(p.name)}" placeholder="例如：日常翻译"></label>
    <label>接口类型${select('type',[['openai','OpenAI 兼容'],['anthropic','Claude / Anthropic'],['gemini','Gemini']],p.type||'openai')}</label>
    <label class="wide">Base URL<input name="baseURL" type="url" required value="${esc(p.baseURL)}" placeholder="https://api.example.com/v1"></label>
    <label>模型 ID<input name="model" required value="${esc(p.model)}" placeholder="填写服务商提供的模型 ID"></label>
    <label>API Key ${p.hasKey?'（已保存；留空保留）':''}<input name="apiKey" type="password" autocomplete="new-password" placeholder="只在本机输入，不会回显"></label>
    <label>最大输出 tokens<input name="maxTokens" type="number" min="1024" max="65536" value="${esc(p.maxTokens||8192)}" required></label>
    <label>OpenAI 兼容接口的 token 参数${select('tokenParameter',[['max_tokens','max_tokens（多数兼容服务）'],['max_completion_tokens','max_completion_tokens（OpenAI 新模型）']],p.tokenParameter||'max_tokens')}</label>
    ${p.id?'<label class="wide"><input type="checkbox" name="clearKey"> 清除已保存的密钥（仅本机免密服务可用）</label>':''}
    </div><button type="submit">${p.id?'保存修改':'添加服务'}</button>`;
  return `<section><h2>中文翻译</h2><p>保存原文后，另存中文译文，附原文链接与可展开的原文对照。译文沿用本地图片；中文内容跳过翻译。</p>
  <p>${config.enabled?'已启用':'未启用'} · 待处理 ${config.pending||0} · 已完成 ${config.completed||0} · 重试中 ${config.retrying||0}</p>
  ${(config.errors||[]).length?`<p class="error">${esc(config.errors.join(' · '))}</p>`:''}
  ${form('settings',`<label>首选服务<select name="activeProvider"><option value="">请选择</option>${config.providers.map(p=>`<option value="${esc(p.id)}" ${p.id===config.activeProvider?'selected':''}>${esc(p.name)} · ${esc(p.model)}</option>`).join('')}</select></label><p><label><input name="enabled" type="checkbox" ${config.enabled?'checked':''}> 启用自动翻译（失败时依次发送给后续服务，按各服务规则计费）</label></p><button>保存翻译设置</button>`)}
  <p>尝试顺序：${orderedProviders(config).map(p=>esc(p.name)+' · '+esc(p.model)).join(' → ') || '请选择首选服务'}</p>
  <div class="actions">${form('backfill','<button>翻译当前目录已有笔记</button><small>仅补充未翻译的非中文本地笔记，不抓取历史书签，不覆盖已有译文。</small>')}${form('retry','<button>立即重试待翻译任务</button>')}</div>
  <details><summary>添加翻译服务</summary>${form('provider',fields())}</details>
  <p><small>Base URL 包含版本路径，不填具体操作：OpenAI 兼容一般为 /v1；Claude 为 https://api.anthropic.com/v1；Gemini 为 https://generativelanguage.googleapis.com/v1beta。本机服务可使用 http://127.0.0.1:端口/v1 并留空密钥。模型需支持文本对话和 JSON 输出。</small></p>
  ${config.providers.map(p=>`<details><summary>${esc(p.name)} · ${esc(p.model)} · ${p.hasKey?'密钥已保存':'本机免密'}</summary>${form('provider',fields(p))}<div class="actions">${form('test',`<input type="hidden" name="id" value="${esc(p.id)}"><button>测试连接（一次短请求）</button>`)}${form('delete',`<input type="hidden" name="id" value="${esc(p.id)}"><button class="secondary">删除此配置</button>`)}</div></details>`).join('')}
  <small>先尝试首选服务，再按添加顺序尝试其余配置；成功即停止，全部失败后保留原文并稍后重试。各模型的分段缓存独立保存，译文不混用。连接测试仅测试对应配置。密钥仅存本机 .local/llm.json，权限 0600；不会显示在页面、状态或日志中。</small></section>`;
}
