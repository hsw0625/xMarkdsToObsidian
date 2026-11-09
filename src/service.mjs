import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, open, chmod, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { prepareBootService } from './boot-service.mjs';

const exec=promisify(execFile);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const label=`com.xmarks-to-obsidian.${createHash('sha256').update(root).digest('hex').slice(0,8)}`;
const domain=`gui/${process.getuid?.()}`;
const plist=join(homedir(),'Library/LaunchAgents',`${label}.plist`);
const xml=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const command=process.argv[2]||'status';
try {
  if(process.platform!=='darwin') throw new Error('This service installer requires macOS; use npm run watch elsewhere.');
  const systemPlist=join('/Library/LaunchDaemons',`${label}.plist`);
  let systemInstalled=false;try {await access(systemPlist);systemInstalled=true;}catch{}
  if(command==='prepare-boot') {
    const result=await prepareBootService({root,label});
    console.log(`开机自启配置已生成并校验，当前服务未变更。\n系统安装目标：${result.target}\n请在本机终端执行：\n${result.command}`);
  } else if(command==='install') {
    if(systemInstalled) throw new Error('System boot service is installed. Restart with sudo launchctl kickstart -k system/'+label+'; use prepare-boot to regenerate its configuration.');
    if(!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) throw new Error('This service requires a Node.js version supporting --use-env-proxy.');
    // launchd does not load shell startup files. Preserve its existing bypass
    // rules as well as the installer's, and always bypass loopback addresses.
    const bypass=[];
    for(const name of ['NO_PROXY','no_proxy']) {
      bypass.push(process.env[name]||'');
      try {const {stdout}=await exec('/bin/launchctl',['getenv',name]);bypass.push(stdout.trim());}catch{}
    }
    const noProxy=[...new Set([...bypass.flatMap(value=>value.split(',').map(x=>x.trim()).filter(Boolean)),'localhost','127.0.0.1','::1','[::1]'])].join(',');
    const dir=join(root,'.local');await mkdir(dir,{recursive:true,mode:0o700});
    for(const name of ['service.log','service.error.log']) {const f=await open(join(dir,name),'a',0o600);await f.close();await chmod(join(dir,name),0o600);}
    await mkdir(dirname(plist),{recursive:true});
    await writeFile(plist,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--use-env-proxy</string><string>${xml(join(root,'src/watch.mjs'))}</string></array>
<key>EnvironmentVariables</key><dict><key>NO_PROXY</key><string>${xml(noProxy)}</string><key>no_proxy</key><string>${xml(noProxy)}</string></dict>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(dir,'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir,'service.error.log'))}</string>
</dict></plist>`,{mode:0o600});
    try {await exec('/bin/launchctl',['bootout',`${domain}/${label}`]);}catch{}
    // bootout can return before launchd has released the old job registration.
    // Retry only that transient bootstrap error; don't report a failed restart
    // merely because the old service is still being removed.
    for (let attempt=0; ; attempt++) {
      try { await exec('/bin/launchctl',['bootstrap',domain,plist]); break; }
      catch (error) {
        if (error.code !== 5 || attempt >= 19) throw error;
        await new Promise(r=>setTimeout(r,250));
      }
    }
    console.log(`已安装并启动：${label}\n本机配置：http://127.0.0.1:8765\n登录 macOS 后自动启动；停止：npm run service -- stop`);
  } else if(command==='stop') {
    if(systemInstalled) throw new Error('System boot service requires: sudo launchctl bootout system/'+label);
    await exec('/bin/launchctl',['bootout',`${domain}/${label}`]);
    console.log('本次登录会话的服务已停止，配置和笔记均保留；下次登录仍会自动启动。');
  } else if(command==='status') {
    const serviceDomain=systemInstalled?'system':domain;
    console.log(`模式：${systemInstalled?'系统开机自启':'用户登录自启'}`);
    const {stdout}=await exec('/bin/launchctl',['print',`${serviceDomain}/${label}`]);
    console.log(stdout.split('\n').filter(line=>/^\s*(state =|pid =|last exit code =|runs =)/.test(line)).join('\n'));
  } else throw new Error('Usage: npm run service -- install|prepare-boot|stop|status');
} catch(error) {console.error(error.code?`Service action failed (${error.code})`:error.message);process.exitCode=1;}
