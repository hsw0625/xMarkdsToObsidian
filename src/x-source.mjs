import { parse } from 'shell-quote';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

// Import data only. Never execute a user-pasted cURL command.
export function parseRequest(text) {
  let args;
  try { args = parse(text.replace(/\\\r?\n/g, ' '), () => { throw new Error(); }); }
  catch { throw new Error('INVALID_CURL: paste Copy as cURL (bash) from the Bookmarks request'); }
  if (args[0] !== 'curl' || args.some(x => typeof x !== 'string')) throw new Error('INVALID_CURL: only a single cURL request is accepted');
  let url, cookie = '', method = 'GET';
  const headers = {};
  const keptHeaders = new Set(['authorization', 'x-csrf-token', 'x-twitter-auth-type', 'x-twitter-active-user', 'x-twitter-client-language', 'user-agent']);
  const flags = new Set(['--compressed', '--globoff', '--path-as-is', '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--http3', '--http3-only', '--silent', '--show-error', '--fail', '--fail-with-body', '--insecure', '--location', '--ipv4', '--ipv6', '--verbose', '--include', '--no-progress-meter']);
  const valued = new Set(['--url', '--header', '--cookie', '--request', '--user-agent', '--referer', '--max-time', '--connect-timeout', '--retry', '--retry-delay']);
  const short = { H: '--header', b: '--cookie', X: '--request', A: '--user-agent', e: '--referer', m: '--max-time' };
  const setURL = value => {
    if (url) throw new Error('MULTIPLE_URLS');
    url = value;
  };
  const addHeader = line => {
    const colon = line.indexOf(':');
    if (colon < 1 || /[\r\n]/.test(line)) throw new Error('INVALID_HEADER');
    const key = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (key === 'cookie') cookie = value;
    if (keptHeaders.has(key)) headers[key] = value;
  };
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (/^https:\/\//.test(token)) { setURL(token); continue; }
    let option = token, value;
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    if (equals > 0) { option = token.slice(0, equals); value = token.slice(equals + 1); }
    else if (/^-[HbXAem]/.test(token)) {
      option = short[token[1]];
      if (token.length > 2) value = token.slice(2);
    }
    if (valued.has(option)) {
      if (value === undefined) value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error('MISSING_CURL_VALUE');
      if (option === '--url') setURL(value);
      else if (option === '--header') addHeader(value);
      else if (option === '--cookie') cookie = value;
      else if (option === '--request') method = value.toUpperCase();
      else if (option === '--user-agent') {
        if (/[\r\n]/.test(value)) throw new Error('INVALID_HEADER');
        headers['user-agent'] = value;
      }
      // Captured referer/timeouts/retry settings are not replayed. The service
      // owns its destination, TLS verification, redirects and network limits.
      continue;
    }
    if (value === undefined && (flags.has(option) || /^-[sSgfkL46vi]+$/.test(option))) continue;
    if (['-I', '--head', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-F', '--form'].includes(option)) throw new Error('NOT_A_GET_REQUEST: copy the Bookmarks GET request');
    const error = new Error('UNSUPPORTED_CURL_OPTION');
    // Never include an argument value, URL, cookie, or arbitrary text in diagnostics.
    if (/^--[a-zA-Z][a-zA-Z0-9.-]{0,40}$/.test(option) || /^-[a-zA-Z]$/.test(option)) error.option = option;
    throw error;
  }
  let u;
  try { u = new URL(url); } catch { throw new Error('INVALID_BOOKMARKS_URL'); }
  if (u.origin !== 'https://x.com' || !/^\/i\/api\/graphql\/[\w-]+\/Bookmarks$/.test(u.pathname) || method !== 'GET') throw new Error('INVALID_BOOKMARKS_URL: only the X Bookmarks GET endpoint is supported');
  const cookies = Object.fromEntries(cookie.split(';').map(x => { const i=x.indexOf('='); return [x.slice(0,i).trim(),x.slice(i+1).trim()]; }));
  for (const name of ['auth_token', 'ct0']) if (!cookies[name] || !/^[a-zA-Z0-9%_-]+$/.test(cookies[name])) throw new Error('MISSING_SESSION: request must include auth_token and ct0 cookies');
  if (!/^Bearer [a-zA-Z0-9%_-]+$/.test(headers.authorization || '')) throw new Error('MISSING_AUTHORIZATION');
  headers['x-csrf-token'] = cookies.ct0;
  headers.cookie = `auth_token=${cookies.auth_token}; ct0=${cookies.ct0}`;
  headers['x-twitter-auth-type'] = 'OAuth2Session';
  headers['x-twitter-active-user'] = 'yes';
  headers.accept = 'application/json';
  headers.referer = 'https://x.com/i/bookmarks';
  let variables;
  try { variables = JSON.parse(u.searchParams.get('variables')); } catch { throw new Error('INVALID_VARIABLES'); }
  if (!variables || Array.isArray(variables) || typeof variables !== 'object') throw new Error('INVALID_VARIABLES');
  delete variables.cursor;
  variables.count = 100;
  u.searchParams.set('variables', JSON.stringify(variables));
  return { version: 1, url: u.href, headers, scope: createHash('sha256').update(cookies.auth_token).digest('hex') };
}

// Headers reach curl through stdin, never argv, environment, or logs. No redirects.
export async function authenticatedGET(url, headers) {
  if (new URL(url).origin !== 'https://x.com') throw new Error('AUTH_DESTINATION_REJECTED');
  const quote = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  let config = `url = ${quote(url)}\n`;
  for (const [name, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(name + value)) throw new Error('INVALID_HEADER');
    config += `header = ${quote(`${name}: ${value}`)}\n`;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['--silent', '--config', '-', '--proto', '=https', '--connect-timeout', '10', '--max-time', '40', '--max-filesize', '20971520', '--write-out', '\n%{http_code}'], { stdio: ['pipe','pipe','ignore'] });
    const chunks = []; let size=0, oversized=false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('NETWORK_ERROR: could not start curl')); });
    child.stdout.on('data', chunk => { size += chunk.length; if(size > 20971520) { oversized=true; child.kill(); } else chunks.push(chunk); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || oversized) return reject(new Error('NETWORK_ERROR: X request failed or exceeded limits'));
      const response = Buffer.concat(chunks).toString('utf8');
      const separator = response.lastIndexOf('\n');
      resolve({ status: Number(response.slice(separator+1)), text: response.slice(0,separator) });
    });
    child.stdin.end(config);
  });
}

export function parsePage(json) {
  if (json?.errors?.length) {
    const codes = json.errors.map(e => Number(e.code));
    if (codes.some(c => [32,89,215,326].includes(c))) throw new Error('AUTH_EXPIRED: update the local X request');
    if (codes.includes(88)) throw new Error('RATE_LIMIT: wait before retrying');
    throw new Error('X_API_ERROR: update the captured Bookmarks request');
  }
  const instructions = (json?.data?.bookmark_timeline_v2 || json?.data?.bookmark_timeline)?.timeline?.instructions;
  if (!Array.isArray(instructions)) throw new Error('X_SCHEMA_CHANGED: missing timeline; not an empty bookmark list');
  const items = new Map(); let cursor = null, terminated = false;
  const entry = e => {
    const c = e?.content;
    if (!c) throw new Error('X_SCHEMA_CHANGED: missing entry content');
    if (c.cursorType === 'Bottom') { if (typeof c.value !== 'string') throw new Error('X_SCHEMA_CHANGED'); cursor = c.value || null; return; }
    if (c.cursorType) return;
    if (Array.isArray(c.items)) { for(const child of c.items) entry({ ...child, content: child.item }); return; }
    let result = c.itemContent?.tweet_results?.result;
    if (result?.tweet) result = result.tweet;
    const id = result?.rest_id || result?.legacy?.id_str || e.entryId?.match(/^tweet-(\d+)/)?.[1];
    if (id && /^\d+$/.test(id)) {
      const user = result?.core?.user_results?.result;
      const handle = user?.legacy?.screen_name || user?.core?.screen_name;
      items.set(id, { id, url: `https://x.com/${/^[\w]+$/.test(handle || '') ? handle : 'i'}/status/${id}` });
    } else if (c.itemContent?.tweet_results || c.entryType === 'TimelineTimelineItem' || c.__typename === 'TimelineTimelineItem') throw new Error('X_SCHEMA_CHANGED: unrecognized tweet entry');
    else throw new Error('X_SCHEMA_CHANGED: unsupported timeline entry');
  };
  for (const instruction of instructions) {
    if (instruction.type === 'TimelineTerminateTimeline' && instruction.direction === 'Bottom') terminated = true;
    else if (Array.isArray(instruction.entries)) instruction.entries.forEach(entry);
    else if (instruction.entry) entry(instruction.entry);
    else if (!['TimelineClearCache','TimelineTerminateTimeline'].includes(instruction.type)) throw new Error('X_SCHEMA_CHANGED: unsupported timeline instruction');
  }
  return { items: [...items.values()], cursor: terminated ? null : cursor };
}

export function createSource(request, transport = authenticatedGET) {
  return async cursor => {
    const u = new URL(request.url), vars = JSON.parse(u.searchParams.get('variables'));
    if (cursor) vars.cursor = cursor; else delete vars.cursor;
    u.searchParams.set('variables', JSON.stringify(vars));
    const raw = await transport(u.href, request.headers);
    if ([401,403].includes(raw.status)) throw new Error('AUTH_EXPIRED: update the local X request');
    if (raw.status === 429) throw new Error('RATE_LIMIT: wait before retrying');
    if (raw.status !== 200) throw new Error(`X_HTTP_${raw.status}: update the captured Bookmarks request if this persists`);
    let json; try { json = JSON.parse(raw.text); } catch { throw new Error('X_SCHEMA_CHANGED: response is not JSON'); }
    return parsePage(json);
  };
}
