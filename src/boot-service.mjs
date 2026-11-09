import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec=promisify(execFile);
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const quote=s=>`'${s.replace(/'/g,"'\\''")}'`;

export async function prepareBootService({root,label,nodePath=process.execPath}) {
  const user=userInfo();
  if(user.uid===0) throw new Error('Run prepare-boot as your normal user, not with sudo.');
  if(!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) throw new Error('Node.js must support --use-env-proxy.');
  const dir=join(root,'.local');await mkdir(dir,{recursive:true,mode:0o700});
  const environment={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:user.homedir};
  for(const name of ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','all_proxy','NO_PROXY','no_proxy']) {
    let value=process.env[name];
    if(!value) {try {value=(await exec('/bin/launchctl',['getenv',name])).stdout.trim();}catch{}}
    if(value) environment[name]=value;
  }
  const bypass=[...new Set([...(environment.NO_PROXY||'').split(','),...(environment.no_proxy||'').split(','),'localhost','127.0.0.1','::1','[::1]'].map(x=>x.trim()).filter(Boolean))].join(',');
  environment.NO_PROXY=bypass;environment.no_proxy=bypass;
  const staged=join(dir,`${label}.boot.plist`);
  const target=join('/Library/LaunchDaemons',`${label}.plist`);
  const agent=join(user.homedir,'Library/LaunchAgents',`${label}.plist`);
  const backup=join(dir,`${label}.login-agent.backup.plist`);
  const installer=join(dir,'install-boot-service.sh');
  const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>UserName</key><string>${xml(user.username)}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>--use-env-proxy</string><string>${xml(join(root,'src/watch.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key,value])=>`<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>180</integer>
<key>StandardOutPath</key><string>${xml(join(dir,'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir,'service.error.log'))}</string>
</dict></plist>
`;
  await writeFile(staged,plist,{mode:0o600});await chmod(staged,0o600);
  const script=`#!/bin/bash
set -euo pipefail
if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  echo '需要管理员权限：请使用 sudo /bin/bash 执行此文件。' >&2
  exit 1
fi
staged=${quote(staged)}
target=${quote(target)}
agent=${quote(agent)}
backup=${quote(backup)}
label=${quote(label)}
domain=${quote(`gui/${user.uid}`)}
/usr/bin/plutil -lint "$staged" >/dev/null
temporary=$(/usr/bin/mktemp -d /private/tmp/xmarks-boot.XXXXXX)
had_system=0
if [ -f "$target" ]; then /bin/cp -p "$target" "$temporary/previous.plist"; had_system=1; fi
rollback() {
  /bin/launchctl bootout "system/$label" >/dev/null 2>&1 || true
  if [ "$had_system" -eq 1 ]; then
    /usr/bin/install -o root -g wheel -m 600 "$temporary/previous.plist" "$target"
    /bin/launchctl bootstrap system "$target" >/dev/null 2>&1 || true
  else
    /bin/rm -f "$target"
    if [ -f "$agent" ]; then /bin/launchctl bootstrap "$domain" "$agent" >/dev/null 2>&1 || true; fi
  fi
  /bin/rm -rf "$temporary"
  echo '系统服务安装失败，已尝试恢复原服务。' >&2
}
trap rollback ERR
/bin/launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
/bin/launchctl bootout "system/$label" >/dev/null 2>&1 || true
/usr/bin/install -o root -g wheel -m 600 "$staged" "$target"
/bin/launchctl enable "system/$label"
loaded=0
for attempt in {1..20}; do
  if /bin/launchctl bootstrap system "$target" 2>/dev/null; then loaded=1; break; fi
  /bin/sleep 1
done
if [ "$loaded" -ne 1 ]; then false; fi
if [ -f "$agent" ]; then
  /bin/cp -p "$agent" "$backup"
  /bin/rm "$agent"
fi
trap - ERR
/bin/rm -rf "$temporary"
echo '已安装开机自启服务，以 ${user.username} 用户身份运行。'
if /usr/bin/curl --noproxy '*' --silent --fail --max-time 5 --retry 10 --retry-connrefused --retry-delay 1 --output /dev/null http://127.0.0.1:8765/status; then
  echo '本机服务已响应：http://127.0.0.1:8765/'
else
  echo '已注册系统启动项；服务尚未响应，请检查 .local/service.error.log。'
fi
`;
  await writeFile(installer,script,{mode:0o700});await chmod(installer,0o700);
  await exec('/usr/bin/plutil',['-lint',staged]);
  await exec('/bin/bash',['-n',installer]);
  return {installer,target,staged,command:`sudo /bin/bash ${quote(installer)}`};
}
