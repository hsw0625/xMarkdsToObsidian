# X → Obsidian PoC

支持 **自动轮询书签 → 仅增量入队 → 正文提取 → Markdown → 本地图片 → Obsidian 属性 → 可选中文翻译与原文对照**。
使用 Node.js + curl。读取私人书签需要你本机的 X 登录态；已验证的两个公开内容样例不需要 Cookie。无需付费 X API 或运行中的 Obsidian。
目前已验证指定样例及一次真实新增书签，不能据此承诺所有 X 页面都可匿名读取。

## 自动监听：首次只建基线，之后只处理新增

前台运行：

```sh
npm run watch
```

打开 <http://127.0.0.1:8765>，按页面说明从 X 开发者工具 Network 复制 **Bookmarks GET 请求 → Copy as cURL (bash)**，粘贴到本机配置页，点击“验证并启动增量监听”。不要把该请求贴到聊天、终端命令行或代码文件中。

程序仅解析这段文本，不执行命令。只提取 Bookmarks 请求地址与必要请求头，去除分页游标和无关 Cookie。登录凭据不会在页面、日志或进程命令行回显，仅发往 `https://x.com`，不跟随带认证请求的重定向。

行为：

- 首次分页读取已有书签的 ID，建立基线，**不抓取历史正文、不下载历史图片**。基线完成后才开始处理新发现的书签。大型收藏库可能需要多轮扫描。
- 默认每 300 秒检查一次。每轮最多 5 页；未扫完会保存游标，30 秒后续扫。增量扫描遇到一整页已知 ID 或列表结束后，把本轮新增 ID 原子写入持久队列。
- 按帖子 ID 判断增量，**不按发帖时间**。今天收藏很早的文章也会处理；已经记录过的同 ID 取消收藏后再次收藏不会重复写入。
- 一轮最多处理 10 个任务。抓取、图片失败按 1 分钟起、最多 1 小时的退避时间等待后续轮询重试。取消收藏不会删除本地笔记。
- 自动同步要求图片全部下载成功才发布笔记，避免将缺图任务误判为完成。笔记以临时文件加原子链接发布，不覆盖同名笔记。
- 队列在抓正文前落盘；重启恢复扫描和任务。如果进程在笔记写入后、任务完成标记前退出，下一轮发现笔记已存在就跳过，不覆盖。
- 登录过期、接口响应格式变化或明显接口错误会暂停书签请求。重新复制当前 Bookmarks 请求到本机页面可以更新参数并重试。不会把登录页或错误 JSON 当作空收藏列表。

macOS 登录后自动运行：

```sh
npm run service -- install
npm run service -- status
npm run service -- stop
```

`install` 注册本项目独有的 LaunchAgent，立即启动，并在 macOS 登录后自动启动；电脑需保持运行和联网。
`stop` 停止本次登录会话的服务，下次登录仍会启动。如需永久停用，停止后删除终端安装输出对应的 `~/Library/LaunchAgents/com.xmarks-to-obsidian.*.plist`。
不要同时运行前台监听和 LaunchAgent；同一状态目录有进程锁。

### 系统开机自启（无需登录用户桌面）

`npm run service -- prepare-boot` 会生成并校验 `.local/install-boot-service.sh` 和私有的系统 plist，然后输出一条 `sudo /bin/bash ...` 安装命令。准备命令本身不切换正在运行的服务；需要在本机终端执行输出的安装命令，完成管理员授权。

安装器将任务放入 `/Library/LaunchDaemons/`，设置 `RunAtLoad`，通过 `UserName` 以准备配置时的普通用户身份运行。会捕获当前代理环境和本机直连规则，因此系统启动不依赖登录 shell 设置。安装成功后将旧登录启动项备份到 `.local/` 并移出 LaunchAgents，避免两个实例并存；失败会尝试恢复原服务。[Apple 的 LaunchDaemon 说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

安装后用 `npm run service -- status` 查看模式和进程。系统服务的重启、停止需要管理员权限，命令中的服务标签以项目实际输出为准：

```sh
sudo launchctl kickstart -k system/com.xmarks-to-obsidian.49d93e15
sudo launchctl bootout system/com.xmarks-to-obsidian.49d93e15
```

`bootout` 仅停止当前运行，下次开机仍启动。需要更新系统启动配置（如代理地址）时重新执行 `prepare-boot` 和生成的安装命令。不要移动项目或 Node 可执行文件；服务使用其绝对路径。是否能在未登录时联网还取决于网络和所用代理服务是否已启动。

后台服务以 `--use-env-proxy` 启动 Node，使翻译和连接测试读取继承的 `HTTP_PROXY/HTTPS_PROXY`（或小写版本）。安装器会保留已有 `NO_PROXY/no_proxy` 规则并追加 `localhost/127.0.0.1/::1/[::1]`，使本机服务直连。规则只写入本项目 LaunchAgent，不修改系统全局环境；curl 抓取也继承同一套代理与直连规则。代理地址仍来自 launchd 环境，修改启动环境后需重启服务；仅在终端 shell 配置文件里设置变量不会自动影响 LaunchAgent。

本地配置位于 `.local/`（Git 已忽略）：

| 文件 | 用途 |
| --- | --- |
| `config.json` | Vault、目录、轮询间隔和批次限制；目录在页面保存后立即生效，其他手工修改需重启 |
| `credentials.json` | 必要登录字段；明文存储，文件权限 0600，目录权限 0700 |
| `state.json` | 已见 ID、分页检查点、待处理/已完成任务与错误码 |
| `llm.json` | 多套翻译服务配置及密钥，0600 权限；通过本机页面修改 |
| `translation-state.json` | 独立翻译任务、原文快照、分批检查点与错误码，0600 权限 |
| `service.log` / `service.error.log` | 运行状态与错误码，不记录请求、Cookie 或响应正文 |

默认仍为项目 `output/vault/Inbox/X`，图片为 `output/vault/attachments/x/`。

### 配置输出目录

本机页面的“输出目录”可配置：笔记库绝对路径（支持 `~/`）、笔记子目录和图片子目录（均为库内相对路径）。保存时创建并验证可写目录，立即生效，不用再次重启。中文译文与原文保存在相同笔记目录；原始 Markdown 备份固定在库内 `Originals`。

切换目录只改变之后归档任务的目标位置，保留已有书签基线、去重和队列。已有笔记、图片不移动或复制；旧的待翻译任务仍在原文所在目录完成，避免图片相对路径失效。“翻译当前目录已有笔记”仅扫描新选择的笔记目录。若希望迁移已有笔记，可另行处理，不要直接改配置文件绕过页面的状态更新。

目录变更使用 `.local/output-change.json` 恢复日志；若保存途中进程退出，下次启动会完成配置与状态更新。校验失败不切换配置（已创建的空目录可能保留）。目录若通过符号链接指向库外，会拒绝保存。
会话以 `auth_token` 的 SHA-256 指纹绑定状态，防止换账号时把旧收藏误当增量。相同 token 的请求参数/ct0 更新可直接保存；**重新登录使 auth_token 改变时，当前版本需要新的状态目录重新建立基线**，旧笔记和旧队列不会自动迁移。可停止旧服务后使用 `npm run watch -- --state-dir .local/new-session`；新目录默认也保存到测试 Vault。

手动执行一轮（先停后台服务）：`npm run sync`。无凭据时明确报告 `SETUP_REQUIRED`。

本地实测记录不随源码发布；可运行 `npm test` 验证归档、同步与翻译流程。

## 运行

需要 Node.js 22+ 和 curl。在本项目目录执行：

```sh
npm ci --ignore-scripts
npm run clip -- 'https://x.com/addyosmani/status/2117512471930167377'
npm run clip -- 'https://x.com/xiaojingcanxue/status/2118065161290616833'
npm test
node src/verify-samples.mjs
```

默认输出是项目内的 `output/vault/`，不会自行查找或修改正式 Obsidian Vault。
可在 Obsidian 中将此目录作为测试库打开，或把完整目录结构复制到测试库。

指定路径与标签：

```sh
npm run clip -- 'https://x.com/USER/status/ID' \
  --vault '/absolute/path/to/test-vault' \
  --notes 'Inbox/X' \
  --attachments 'attachments/x' \
  --tag 'X收藏' --tag 'AI'
```

`--notes` 和 `--attachments` 必须在 Vault 内。不要把不可信符号链接目录用作输出路径。
标签由参数提供，本轮不做 AI 标签生成。

离线重放已保存的 HTML（仍会联网下载尚未归档笔记的图片）：

```sh
npm run clip -- 'https://x.com/addyosmani/status/2117512471930167377' \
  --html output/raw/2117512471930167377.html
```

普通外链文章 URL 走 Mozilla Readability 提取；本轮尚待用户的真实外链样例验证。

## 输出

```text
output/
  raw/<id>.html                     原始公开 HTTP 响应
  verification.json                两条真实样例的正文与图片校验结果
  vault/
    Inbox/X/<文章标题>.md          阅读笔记，使用本地图片相对路径
    attachments/x/<id>/<hash>.*     图片，按实际文件签名识别扩展名
    Originals/<id>.md              原文 Markdown，保留远程图片 URL 作来源记录
    Originals/<id>.report.json     抓取信息、图片哈希、失败记录
```

笔记包含 `tags`、`source`、`created`、`aliases`、`author`、`tweet_id` 等属性。
阅读笔记按文章标题命名；同名文件存在时附加 `(ID)`，不覆盖其他笔记。非法文件名字符转换为对应全角字符，过长标题按文件系统字节限制截短，完整标题仍保留在正文和别名中。去重读取属性中的 `tweet_id/archive_id`，不依赖文件名；兼容旧数字文件名和用户手动改名。图片、原始响应及备份仍按 ID 管理。
`created` 是保存时间，ISO 8601 UTC 格式，并非发帖时间。
`original_language: zh` 为中文字符占比启发式判断；其他内容暂记 `und`（未判定）。
英文样例 `translation_status: pending`；中文样例 `not-needed`。

## 多服务中文翻译

打开本机 [配置页](http://127.0.0.1:8765/)，在“中文翻译”中操作：

后台重启后，新版页面会自动更新过期的表单验证令牌，并仅在操作尚未执行的 CSRF 拒绝时重试一次，保留输入。升级前已打开的旧页面需刷新一次。

1. 展开“添加翻译服务”，填写名称、接口类型、Base URL、模型 ID 和 API Key。可保存多套配置，留空密钥可保留原密钥；更换接口地址或类型须重新输入密钥。
2. 保存后点击该服务的“测试连接”，会发送一次短请求。保存配置本身不调用 LLM。
3. 选择“首选服务”、勾选“启用自动翻译”，保存设置。非中文新增笔记会进入独立翻译队列，原文先保存成功，翻译失败不会导致收藏正文丢失。
4. 如需处理已保存的英文样例，点击“翻译当前目录已有笔记”。按属性识别已归档笔记，支持标题和旧数字文件名；不抓取历史书签，不覆盖已有译文。

支持的接口：

| 类型 | Base URL 示例 | 请求方式 |
| --- | --- | --- |
| OpenAI 兼容 | `https://api.openai.com/v1` 或服务商提供的地址 | Chat Completions；多数兼容服务使用 `max_tokens`，OpenAI 新模型可选择 `max_completion_tokens` |
| Claude / Anthropic | `https://api.anthropic.com/v1` | Messages API |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | GenerateContent |
| 本机 OpenAI 兼容服务 | `http://127.0.0.1:端口/v1` | 支持免密；远程服务要求 HTTPS 和密钥 |

模型 ID 由你填写，不强制绑定具体型号。参考协议：[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Claude Messages](https://platform.claude.com/docs/en/api/messages/create)、[Gemini GenerateContent](https://ai.google.dev/api/generate-content)。Azure 特有认证、Responses-only 模型与其他私有协议暂不支持。

翻译产物：

```text
Inbox/X/<文章标题>.md            原文阅读笔记，使用本地图片
Inbox/X/<翻译后的标题>.zh-CN.md  中文译文，链接原文，末尾可展开原文嵌入对照
Originals/<id>.md        原始 Markdown 备份，继续保留
```

译文继承 `tags/source/created/aliases` 等属性，补充中文标题别名及 `language/translated_at/translation_provider/translation_model/original_note`。原笔记中的状态属性保留归档时的值；当前翻译结果以中文文件及配置页队列为准。中文文件与原文在同目录，共用本地图片，不重复下载。

长文按行保持段落位置，分批翻译。代码、图片和链接目标用占位符保护；输出必须包含完整的分段 ID 和占位符，截断或缺失会失败并重试。成功批次按模型配置独立保存检查点，重启后可继续同一模型的进度；切换到其他模型使用独立缓存，不混合不同模型的译文。只在全部完成后原子发布中文文件，不覆盖人工修改。此校验保证结构，不能保证模型每句话都准确；译文提供原文对照。

配置与队列：`.local/llm.json` 存多套服务（含明文密钥，0600 权限）；`.local/translation-state.json` 存任务、原文快照、已完成批次和错误码（0600）。页面和状态只返回是否有密钥，不回显密钥。启用前不发送文章；启用后先尝试首选服务，失败立即按添加顺序尝试其余配置，成功即停止。所有配置均失败时，任务保留并按原有退避机制稍后重试；每轮每个配置最多尝试一次（长文每个模型仍分批请求）。页面显示实际顺序，修改配置不会改变顺序。连接测试只调用对应配置。译文属性记录实际成功的服务与模型，原文始终保留。中文判断仍为启发式，混合语言可能需要人工核对。

验证：44 项测试通过，包括三个协议适配器、结构保护、分批续传、原文不变、重复译文保护、失败恢复、模型依次回退及缓存隔离、输出目录切换、CSRF 重启恢复、标题文件名及冲突处理、X Article 多正文块与穿插代码块提取，以及使用临时模拟 LLM 的完整本机 HTTP 流程。自动测试不验证真实模型的翻译质量，也不写入用户 Vault。

## 本轮边界

- **已实测**：X Article 正文、单条中文帖子、图片本地化与位置保留、可解析 YAML、重复导入保护。
- **已实测**：真实书签接口、首次建立基线后自动保存新增书签、后台轮询和 LaunchAgent。
- **已实现待真实服务实测**：多 Provider 中文翻译、原文对照、独立翻译队列与本机配置入口。
- **未实现**：交互式 X 登录、Thread 拼接、AI 标签、视频下载。
- X 提取器针对本轮观察到的 SSR DOM 属性。登录墙、缺正文、明显截断会报错，不把摘要冒充全文。
- HTTP 正文与 Markdown 一致不等于服务端一定返回了原作者全部内容，因此默认仍记录 `extraction_status: body-extracted-unverified`。
- 单次 `clip` 图片下载失败会保留远程 URL，记录 `media_status: partial`；自动监听则暂不发布缺图笔记，并留在队列重试。已有缺图笔记不会自动改写。
- 同 ID 重复导入跳过整份笔记，保护手写内容。监听器包含进程锁和持久检查点，但尚未经过长期运行验证。
- 外链正文使用通用 Readability/Turndown；复杂表格、数学公式、懒加载及付费内容尚未验证。
- 原始响应、笔记与图片在 `output/` 下，默认被 Git 忽略。

## 验证依据

本地实测记录不随源码发布。真实样例验证脚本独立比较原始 HTML 正文与 Markdown 渲染文本，检查本地图片存在且文件签名有效。
