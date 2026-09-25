# dsh-xiaozhi · 小智语音接入 DSH

把小智（Xiaozhi）语音助手接入 **DeepSeek Harness（DSH）Web**：DSH 作为 **MCP 工具提供方**，
通过 WebSocket 上的 JSON-RPC 2.0 把工作区、会话、模型、设置、文件等能力封装成工具，供小智语音调用。

**中文** · [**English**](./README.md) · [安装与验证](./INSTALL.md) · [工具清单](./docs/TOOLS.md)

> 把小智（Xiaozhi）语音助手接入 DSH Web：DSH 作为 MCP 工具提供方，把 35 个 DSH Web 接口封装成 16 个
> 语音友好工具，自带 DSH Web 设置页。
> Connect the Xiaozhi voice assistant to DSH Web as an MCP tool provider — 35 endpoints, 16 voice-friendly tools.

> 实施前的设计提案（架构 ADR、v2 复核、设置页 UX 走查）归档在 [docs/design/](./docs/design/)，其中与实际交付不一致的地方已逐条注明。

---

## 1. 它解决什么问题

DSH Web 的能力都在 HTTP REST 接口上，而小智只认 **MCP**（Model Context Protocol）。
本插件坐在两者中间：

```
 你说一句话
     │
     ▼
┌─────────────┐   MCP(JSON-RPC 2.0 / WebSocket)   ┌──────────────────────────┐
│  小智助手    │ ◄───────────────────────────────► │  dsh-xiaozhi (Host 半边)  │
│ (App/硬件)   │   initialize / tools/list / call   │  ├ MCP 会话与工具注册表    │
└─────────────┘                                    │  ├ 能力→REST 路由映射      │
                                                   │  └ LocalInvoker(进程内调用)│
                                                   └───────────┬──────────────┘
                                                               │ 不走网络，直接调用
                                                               ▼
                                                   ┌──────────────────────────┐
                                                   │  DSH Web REST 路由(内置副本)│
                                                   └──────────────────────────┘
```

三个关键设计决定：

1. **DSH 永远是 MCP 的“服务端/工具提供方”。** 两种传输方式下都由 DSH 应答
   `initialize` / `ping` / `tools/list` / `tools/call`，从不主动发起这些请求。
2. **默认主动外连（`endpoint` 模式）。** DSH 作为 WebSocket 客户端连到小智官方
   MCP 接入点，所以**不需要**公网 IP、端口映射或反向代理。
3. **进程内调用，而不是回环 HTTP。** 工具调用通过 `LocalInvoker` 直接打到内置的
   DSH REST 路由，无需猜测 DSH 自身的 host/port/鉴权，也不依赖外部服务。

---

## 2. 快速开始（3 步）

**前提**：DSH Web 已经在跑（`dsh web`，默认 `http://127.0.0.1:3080`）；你有小智账号并能打开它的
「MCP 接入点」页面。

1. **安装插件**（在本仓库目录下执行）：

   ```bash
   dsh plugin add /Users/tsbj/feyanggit/DHS-test/dsh-xiaozhi
   ```

   也可以在 DSH Web 的「设置 → 插件」里用「安装本地目录」选择该目录。

2. **拿到接入点地址并粘贴**：打开 DSH Web →「设置 → **小智接入**」→「接入配置」，
   把小智后台的 MCP 接入点 WebSocket 地址（形如
   `wss://api.xiaozhi.me/mcp/?token=…`）填进「小智 MCP 接入点地址」，点「保存并重载」。

3. **看状态**：回到「状态」页签，连接状态应为 `connected`，并显示已连接客户端数。
   点一次「测试连接」可以看到真实握手结果。

   然后在手机上对小智说：**“用 dsh 看一下我的会话列表”** 或 **“让 DSH 汇报一下运行状态”**。

> 接入点地址含 token，属于敏感信息。设置页读回时只显示 `token=***`，
> 保存时也会被识别为「未修改」，不会把掩码写进配置。详见 §7。

---

## 3. 两种传输方式

| | `endpoint`（默认，推荐） | `server`（自建服务端） |
| --- | --- | --- |
| 谁发起连接 | DSH 主动外连小智接入点 | 小智服务端连到 DSH |
| 需要公网可达吗 | 不需要 | 需要（或反向代理 / 内网同段） |
| 主要配置 | `endpointUrl`、`endpointHeaders` | `serverPath`、`serverPort`、`serverToken` |
| 适用场景 | 小智官方 MCP 接入点、家用/办公本机 | 自建 `xiaozhi-esp32-server`、内网统一网关 |

两种方式可以同时开启：`mode` 决定**主**通道，`serverPort > 0` 时会额外在 `0.0.0.0` 上
监听一个独立端口。

**断线重连**：`endpoint` 模式带指数退避（`reconnectMinMs` → `reconnectMaxMs`，含 ±20% 抖动）
和 `heartbeatMs` 心跳；「状态」页的「重连次数」和日志可以看到全部过程。

---

## 4. 工具暴露方式：grouped（默认）还是 flat

小智的工具名会被清洗成 `[A-Za-z0-9_\-中文]`，本插件的所有工具名都是该规则的**不动点**
（例如 `dsh_session_history`），因此不会在平台侧被改名。

| 模式 | 工具数 | 说明 |
| --- | --- | --- |
| `grouped`（默认） | **16**（关闭工具组后更少） | 按能力域合并，用 `action` 参数选择具体动作 |
| `flat` | **35** | 每个接口一个工具，名字与接口一一对应 |

**默认选 grouped 的原因**：语音模型在 35 个工具里挑一个的准确率明显低于在 16 个里挑。
超过 24 个工具时设置页会给出提示。完整对照表见 [docs/TOOLS.md](./docs/TOOLS.md)。

**工具组开关**：可在「接入配置 → 工具组开关」里关掉暂时不用的域（例如 `docs`、`files`）。
关闭整组会让对应工具（或分组工具里的对应动作）直接不可用。

**写入开关**：`allowWriteTools = false` 时，创建/修改/删除/发送类动作会被拒绝并返回一句
可直接朗读的中文说明，**只读动作照常可用**（即使它们和写动作合并在同一个 grouped 工具里）。

---

## 5. 能力覆盖

**35 个接口全部可达**，两种工具模式下都覆盖 35/35：

| 能力域 | 能力数 | 对应接口 |
| --- | --- | --- |
| 系统状态 | 1 | `GET /system/status` |
| 工作区 | 6 | `/workspaces`、`/workspaces/:id`、`/workspaces/:id/sessions` |
| 会话 | 13 | `/sessions`、`/sessions/:id`、`history`、`stats`、`todos`、`skills`、`questions`、`answers`、`cancel`、`events` |
| 文件 | 3 | `/sessions/:id/files`、`/files/download` |
| 对话 | 3 | `/sessions/:id/prompt`、`/prompt-stream`、`/chat/completions` |
| 模型与预设 | 5 | `/models`、`/models/default`、`/providers`、`/presets` |
| 系统设置 | 2 | `/settings`、`/settings/:namespace` |
| 接口文档 | 2 | `/docs`、`/openapi.json` |

其中 4 个能力在 MCP 语义下做了**降级**（不是缺失，但仍需你知情），详见下一节。

---

## 6. MCP 语义降级（务必阅读）

MCP 的 `tools/call` 是**一问一答**的，没有增量流式通道，而原 REST 接口里有几个是流式的。
本插件选择「尽量保住语义、并如实告知」而不是假装支持：

| 能力 | 原本形态 | 在 MCP 上的行为 | 你需要知道 |
| --- | --- | --- | --- |
| `conversation.promptStream`<br>（`dsh_say` / `dsh_conversation_promptstream`） | `text/event-stream`，增量推送 | DSH 在服务端**收集完整个流**后一次性返回结果文本 | 语音端不会逐步流式；`promptTimeoutMs` 决定等待上限，超时返回「已提交、仍在运行」而不是错误 |
| `sessions.events`<br>（`dsh_session_watch`） | 常驻 SSE 事件流 | 只在**有限时间窗**内（1–30 秒）收集事件后返回 | 只能当“看一眼最近的动静”，不能当实时监听；需要持续监听请用 `sessions.stats` 轮询 |
| `files.download` | 二进制文件流 | 文本文件回传正文（截断到 `maxVoiceChars`）；**二进制只回传摘要**（大小、类型、路径） | 语音播报二进制内容本来也没有意义；需要真文件请走 DSH Web 界面或内置 REST 层 |
| `docs.openapi` | 完整 OpenAPI JSON | 返回**结构摘要**（`openapi` 版本、`title`、路径数、最多 100 条路径、字节数、原始 URL） | 完整规范请直接访问 `apiBase/openapi.json` |

另外两点：

* `dsh_say(wait=false)` 用于「把话转给会话、不等结果」：它在约 1.5 秒预算内提交
  `prompt-stream`，超时就静默返回「已提交」并附上会话当前状态，不会让你干等。
* 所有工具结果都会按 `maxVoiceChars` 截断成**单个 text 块**，避免语音播报冗长。

---

## 7. 安全模型（请按自己的部署范围核对）

| 面 | 默认 | 保护 |
| --- | --- | --- |
| DSH Web 设置页 API `/dsh-xiaozhi/admin` | 仅本机可访问（DSH 默认绑定 `127.0.0.1`） | ①跨站 `Origin` 拒绝 ②`sec-fetch-site: cross-site` 拒绝 ③**每个请求**（含读取）都必须带 `x-dsh-xiaozhi-admin: 1` 自定义头；跨站表单/图片无法设置自定义头，跨域 `fetch` 会触发预检而本路由 `cors: false` 从不放行 ④若宿主存在 `connection` 服务，先由它做浏览器 cookie + Host/Origin 判定（401/403） |
| 内置 DSH REST 层 `/dsh-xiaozhi/api/v1` | 默认开启 | 设置 `apiKey` 后需 `Authorization: Bearer …` 或 `X-API-Key`；**未设置密钥时会给出警告** |
| MCP 工具（对外） | 默认开启，默认允许写 | `allowWriteTools=false` 关闭全部写操作；`disabledGroups` 缩小攻击面 |
| `server` 模式独立端口 | 默认关闭（`serverPort=0`） | 填端口会在 `0.0.0.0` 监听，**必须**设置 `serverToken`，否则设置页会警告 |

**密钥掩码**：设置页读回配置时，`apiKey`、`serverToken`、接入点 URL 里的 `token=` 以及
`endpointHeaders` 的所有**值**都被替换成掩码（`••••••` / `***`），但会保留 header **名字**。
保存时掩码会被识别为“未修改”并丢弃，**不会**用掩码覆盖真实密钥。

**`endpointHeaders` 只能新增/覆盖，不能通过设置页删除**（底层是合并写入）。
要删掉某个请求头，手工编辑 `settings.json`。

---

## 8. 配置项

配置分三层，优先级从低到高：

1. 代码默认值（`src/config.ts` 的 `DEFAULTS`）
2. 插件行的 `config`（profile 的 `cordis.patch.yml`）
3. 设置页保存的覆盖（`<homeDir>/settings.json`）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后小智无法调用任何工具 |
| `mode` | `endpoint` | `endpoint` / `server` |
| `endpointUrl` | `''` | 小智 MCP 接入点（`ws://`/`wss://`，须含 `/mcp/`） |
| `endpointHeaders` | `{}` | 接入点附加请求头（合并写入） |
| `serverPath` | `/mcp/xiaozhi` | `server` 模式的路径（须含 `/mcp/`） |
| `serverPort` | `0` | `0` 复用 DSH Web 服务器；`>0` 额外监听 `0.0.0.0` |
| `serverToken` | `''` | `serverPort>0` 时强烈建议设置 |
| `toolMode` | `grouped` | `grouped` / `flat` |
| `disabledGroups` | `[]` | 关闭的能力域 |
| `allowWriteTools` | `true` | 是否允许写操作 |
| `promptTimeoutMs` | `120000` | 语音指令等待上限（须小于内置 REST 层的 180000） |
| `maxVoiceChars` | `700` | 单条回复截断长度 |
| `listLimit` | `10` | 列表类结果条数 |
| `heartbeatMs` | `30000` | 心跳间隔 |
| `reconnectMinMs` / `reconnectMaxMs` | `1000` / `30000` | 重连退避区间 |
| `apiPathPrefix` | `/dsh-xiaozhi/api` | **内置 REST 层**前缀（设置页 API 固定在 `/dsh-xiaozhi/admin`） |
| `exposeDshApi` | `true` | 是否挂载内置 DSH REST 层 |
| `apiKey` | `''` | 内置 REST 层鉴权密钥 |
| `cors` | `false` | 内置 REST 层是否允许跨域 |
| `defaultCwd` | `''` | 创建会话的默认目录 |
| `maxUploadBytes` | `104857600` | 上传上限 |
| `homeDir` | `''` | **只能**在插件行 `config` 里设置（见下） |
| `logToolCalls` | `true` | 记录每次工具调用 |
| `sendInitializedNotification` | `true` | MCP 握手后发送 `notifications/initialized` |
| `serverName` | `DSH` | 对外声明的服务名 |

> **为什么 `homeDir` 不在设置页里？** 它决定设定文件本身放在哪，如果允许从该文件里读，
> 就会出现“设置页显示新目录、覆盖却仍写旧目录”的自相矛盾。因此 `homeDir` 固定只从插件行
> `config` 读取，设置页只做只读展示。环境变量 `DSH_XIAOZHI_HOME` 亦可指定。

---

## 9. 设置页

DSH Web →「设置 → 小智接入」，共 5 个页签：

* **状态**：连接状态徽标、传输方式、接入点（已掩码）、已连接客户端数、重连次数、最近错误、
  需要注意的警告、对外地址、工具/能力计数、各工具组开关状态；可「测试连接」「立即重连」「刷新」。
* **接入配置**：基础项 + 工具组开关 + 折叠的高级项；「保存并重载」会写覆盖文件并重启运行时，
  「恢复默认」清空全部覆盖。
* **工具清单**：当前实际暴露的工具、读写属性、覆盖的能力数。
* **能力清单**：35 个能力按域列出，含方法与路径。
* **日志**：插件环形日志（默认 300 条），可打开 5 秒自动刷新。

页面只用 DSH 主题 token（`--dsw-alias-*`）着色，**不依赖** `dsh-client-ui-primitives`，
因此明暗主题都跟随宿主，样式不会和宿主冲突。

---

## 10. 开发与验证

```bash
cd dsh-xiaozhi
bash scripts/build.sh                     # 需要 DSH 源码 checkout 提供 tsc（自动探测）
node --test --test-timeout=30000 "test/*.test.mjs"
```

测试覆盖（**107 个用例**）：

| 文件 | 覆盖内容 |
| --- | --- |
| `test/protocol.test.mjs` | MCP 报文、工具名清洗不动点、信封解析 |
| `test/ws.test.mjs` | RFC 6455 分帧、掩码方向、分片、关闭握手 |
| `test/config.test.mjs` | 三层配置合并、密钥掩码、`homeDir` 不可覆盖 |
| `test/coverage.test.mjs` | **35 个接口逐条钉住**；两种工具编织都全覆盖；工具名是清洗不动点 |
| `test/dispatcher.test.mjs` | 进程内调用：JSON、查询串、请求体、流式响应、404、超时 504 |
| `test/mcp-session.test.mjs` | 真实 socket 上的握手 → `tools/list` → `tools/call`，含并发与协议错误 |
| `test/routes.test.mjs` | 用**真实**路由表验证 35 个能力都命中已注册路由；分组工具端到端 |
| `test/client.test.mjs` | 浏览器半边的常量一致性、双语字典完整性、helpers、`react-dom/server` 渲染 |
| `test/admin.test.mjs` | 设置页 API：页面调用的每个路由都必须以正确方法可达；三层守卫；密钥掩码剥离 |
| `test/docs.test.mjs` | 文档与代码一致性：工具名/能力/计数不得漂移 |

`src/dshapi/` 是上游 `@dsh-external/dsh-web-service` v0.1.11 的**逐字拷贝**（BSD-3-Clause），
唯一的新文件是把它组装成单个路由的 `src/dshapi/service.ts`，这样上游更新时仍是干净的三方 diff。
详见 [NOTICE](./NOTICE)。

---

## 11. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 状态一直是 `disconnected` | 接入点地址没填或填错（必须是 `ws://`/`wss://` 且含 `/mcp/`，且**不能**含 `key`/`call` 字样）；看「日志」页首个错误 |
| 小智能看到工具但调用失败 | 检查 `allowWriteTools`；写入类动作被关闭时会返回明确的中文说明 |
| 小智看不到任何工具 | `enabled=false`，或所有工具组都被关闭 |
| 语音里会话/工作区 id 说不清 | grouped 工具返回的 id 都做了缩短（如 `sess-123`）；也可以用名称调用 |
| 局域网里的自建小智连不上 | `server` 模式且 `serverPort=0` 时只监听 DSH 服务器（默认仅本机）；填端口并设置 `serverToken` |
| 修改 `apiPathPrefix` 后设置页没变 | 符合预期：设置页 API 固定在 `/dsh-xiaozhi/admin`，`apiPathPrefix` 只影响内置 REST 层 |

---

## 12. 许可

BSD-3-Clause。派生自 `@dsh-external/dsh-web-service` v0.1.11（Copyright © 2026 toddpan 潘祖继），
同一许可。见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
