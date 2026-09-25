# dsh-xiaozhi 架构决策评审（v2）——ADR 裁定 + 模块/接口规格 + 风险

> **评审对象**：`docs/architecture-adr.md`（下文简称 **v1**，742 行，12 条 ADR）与 `docs/settings-ux-walkthrough.md`。
> **评审方式**：只做定点取证（不重读全项目）；每条裁定附**可复核的证据**（文件行号 / 实测命令）。
> **范围**：架构层。不含实现代码；类型签名只给声明，不给函数体。
> **本文件可独立落地**：§1 的每一条 ADR 都是完整决策（决策/备选/理由/代价），不需要回读 v1；§2 的规格对 v1 的差异做了显式标注。

---

## 0. 结论先行

**一句话**：v1 的骨架（结构化替身、能力表单一事实源、SSE→可拉取降级、grouped 工具面、可选依赖用 `ctx.inject`）经复核**成立**；但有 **1 处协议方向错误、1 处基于不存在的环境变量的事实错误、1 处可自证的工作量冗余、1 处复制即故障的共存缺陷、1 处潜伏 OOM**。先修这 5 处，再动代码。

### 0.1 对 v1 的逐条裁定

| v1 | 议题 | v1 结论 | 本次裁定 | 一句话理由（证据见对应 ADR） |
|---|---|---|---|---|
| — | **协议消息方向** | 隐含"插件是 MCP client，发 initialize + tools/list，同时又被 tools/call 调用"（§2.6 + §2.4 自相矛盾） | **推翻，改为 H1：插件是 MCP server（应答 initialize/tools/list/tools/call，主动发 notifications/initialized）；并实现对称派发器容错 H2** | 参考实现在同一条"连出"的 socket 上**只应答**这三条、并**发送** notifications/initialized（`WebSocketMCP.cpp:199-252`）；且"被动响应 tools/call"+"平台清洗我们的工具名"本身就要求我们是工具提供方 |
| ADR-001 | 双角色 | `endpoint\|server\|both`，默认 endpoint | **采纳**（`both` 收窄为显式开发用途） | 两 adapter 已是独立模块，边际成本≈0 |
| ADR-002 | server 传输 | streamable-HTTP 为主，WS upgrade 为次 | **采纳**，但 WS upgrade 必须按约束**保留同一 `server.path`**且默认关 | 平台连出形式是 SSE/streamable-http；WS 连出未证实 |
| ADR-003 | 执行路径 | 结构化替身 + 能力表 | **采纳**，补两条契约：**ALS 契约**与**流式响应/背压契约** | 替身当前实现会 OOM：`createReadStream().pipe(res)` 在 `write()` 恒返回 `true` 时无背压（`files.ts:224`、`fs.ts:165`、`skills.ts:132`） |
| ADR-004 | 模块划分 | 单向分层，`api/*` 不认识 MCP | **采纳**，补 3 条硬规则 | "REST 层跟随上游"是长期最大成本 |
| ADR-005 | 配置持久化 | `$DSH_PROFILE_DIR/dsh-xiaozhi/config.json`，字段标 `scope: deploy\|user` | **推翻**：`$DSH_PROFILE_DIR` **在 DSH 中不存在**；主通道改为 **`ctx.settings`**（profile patch 的 `base`/`user` 分层 + revision 校验 + `role('secret')` 脱敏），sidecar JSON 降为回退 | 枚举 DSH 0.1.7-rc.2 全部 `DSH_*` 变量无 `DSH_PROFILE_DIR`；`SettingsDescriptor` 自带 `base`/`user`/`revision`/`secrets` |
| ADR-006 | 自研 WS | 自研 RFC6455，仅 client 角色用 | **收缩**：client 角色用 **Node 内置 `globalThis.WebSocket`**（已实测可用、零依赖），自研 framing **只在"平台连我们的 WS server"这一未证实分支**按需实现 | Node v22.19.0 实测：连本地 upgrade 服务成功、子协议协商成功、`headers` 选项生效；且 MCP 的 `ping` 是**协议级请求**，无需 WS 控制帧 ping |
| ADR-007 | SSE 降级 | 事件环形缓冲 + 两段式 ask + 二进制不映射 | **采纳**，补 3 处（重试去重、结果读游标、结构化摘要） | 方向正确，闭环缺 3 个 |
| ADR-008 | 并发背压 | 三级限流 + requestId 幂等 | **采纳**，补写侧背压与断线收敛细节 | — |
| ADR-009 | 工具面 | grouped 18 + flat 可切 | **采纳**，但 flat 必须**显式 include + 上限**，并删掉与 `dsh_ask` 重复的 `dsh_agent`（18→17） | flat≈51 与 ADR-009 自己的理由（"51 项 LLM 选不对"）冲突 |
| ADR-010 | 可选依赖 | 顶层 `inject` 不含 webServer，用 `ctx.inject(['webServer'], cb)` | **采纳（已实测该 API 存在且语义就是"服务可用时回调"）** | `cordis/lib/types/registry.d.ts` 明确 `Inject = (keyof M)[] \| { [K]: config }`，**无 optional 语义**；`ctx.inject(deps, cb)` 存在 |
| ADR-011 | 管理面鉴权 | per-process adminToken 经 `webserver/index-inject` 注入 | **部分采纳**：token 机制保留；但**配置读写改走 `ctx.settings`**，admin REST 只剩 status/actions；并补 `ctx.settings.configure({auto:false})` | 平台已自带鉴权+revision+脱敏的配置通道，自建一套是重复劳动且多一个未鉴权面 |
| ADR-012 | token 处理 | 掩码 + redact + 401 即 fatal | **采纳**，落地方式改为 `role('secret')` + `SettingsForms.mutate` 路径写 | 脱敏由平台保证，不靠我们自己写正则 |

### 0.2 必须先做的两项"实测探针"（在写业务代码之前，各 30 分钟内）

| # | 探针 | 要回答的问题 | 判定后的动作 |
|---|---|---|---|
| **P-A** | 用一个哑 token 连 `wss://api.xiaozhi.me/mcp/?token=…`，把**双向原始帧**打日志（不改代码，抓 60s） | ① 谁先发 `initialize`？② 平台是否发 `tools/list`（带 cursor 吗）？③ 平台 `ping` 的形状（有无 `jsonrpc`、id 类型）？④ 平台 HTTP 状态码/close code 对无效 token 的表示？⑤ 平台是否发 `notifications/cancelled`？ | 决定 ADR-101/102 的默认分支；把观测值写回本条 ADR 的"已实测"栏 |
| **P-B** | `ctx.settings.describe({redactSecrets:true})` + `ctx.fiber.entry?.options.id` 各打一行日志 | ① 本插件的 settings namespace 能否稳定解析（entry id 是否等于插件的 Loader row id）？② `descriptor.schema` 是否就是本模块 `Config` 的同一实例（可用于身份匹配）？③ `writable` 在真实 profile 下是否 true？ | 决定 ADR-106 的主/备通道与 `Config` 字段的 secret 标注 |

**探针未跑之前，不要实现 `lib/ws/*`、也不要写死握手方向。** 这两件事都是"猜错就全废"的。

### 0.3 本次评审的取证清单（可复核）

| 证据 | 来源 | 结论 |
|---|---|---|
| `WebSocketMCP.cpp:199-252` | 参考工程 | 连接方**应答** `ping`/`initialize`/`tools/list`/`tools/call`，并在回完 initialize 后**发送** `notifications/initialized` |
| `WebSocketMCP.h:252` / `.cpp:148` | 参考工程 | `PING_INTERVAL=10s`；>2min 无 ping 视为断连 |
| `node -v` → v22.19.0；`wsprobe.mjs` | 本机实测 | 内置 `WebSocket` 连本地 upgrade 成功；`protocols:['mcp']` 协商成功；`{headers:{…}}` 生效；默认发 `Sec-WebSocket-Extensions: permessage-deflate` |
| `dsh-host-webserver/lib/types/index.d.ts` | DSH 0.1.7-rc.2 | `register({kind:'exact'\|'prefix'})`、`registerUpgrade({path})`（**仅 exact path**，重复即 throw）、`registerFallback`、事件 `webserver/index-inject` |
| `dsh-settings/lib/types/index.d.ts` | 同上 | `SettingsForms.describe/update/replace/mutate/configure`、`SettingsDescriptor{ns,schema,value,revision,base,user,secrets,applies}`、`SettingsConflictError` |
| `dsh-settings/lib/index.js:11-25` | 同上 | `role('secret')` 字段在 `describe` 中被结构性剥离，只返回"是否已设置" |
| `dsh-experimental-speech-to-text/lib/index.js:16-20,119-127` | 同上 | 插件用 `ctx.fiber.entry?.options.id` 得到自己的 namespace，再 `settings.update(ns, patch)` |
| `dsh-home-paths/lib/index.js` | 同上 | home 解析优先级：显式配置 > `$DSH_HOME` > `~/.dsh`；**无 profile 目录环境变量** |
| `cordis/lib/types/registry.d.ts:13-20,104-112` | cordis 4 | `Inject` 数组/对象均表示必需；`ctx.inject(deps, cb)` = "服务可用时运行回调，服务变化时卸载重跑" |
| `dsh-web-service/src/*.ts` | 参考插件 | 51 条路由；`res.*` 实际成员仅 8 个、`req.*` 仅 5 个（见 ADR-104）；`streaming.ts:320` 订阅先于 `:564` 提交；`user-questions.ts:80/81/139`（ALS 归属 / agent 兜底 / `prepend:true`） |

---

## 1. ADR 列表

### ADR-101 协议消息方向与握手形状（**新增，最高优先；推翻 v1 §2.6**）

**状态**：提议中 —— **必须先跑探针 P-A 才能"接受"**

**背景/冲突**
用户给的流程是"插件依次**发** initialize → notifications/initialized → tools/list，**被动响应** ping 与 tools/call"。但标准 MCP 2024-11-05 中，`initialize`/`tools/list` 是 **client→server 的请求**，`tools/call` 是 **client 调 server**。若我们发 `tools/list`，我们就是 client，则平台无从调用我们的工具；而需求又明确"被动响应 tools/call"且"工具名被平台清洗"。**两者不能同时成立。**

**证据**：参考工程在**同一条连出的 socket** 上，只做三件被调用的事（应答 `ping`/`initialize`/`tools/list`/`tools/call`），并主动发 `notifications/initialized`（`WebSocketMCP.cpp:199-252`）。即"物理上连出"与"协议上是 server"是**两件事**，参考实现选的是后者。

**决策**
1. **H1（默认按此实现）**：插件在 `endpoint` 模式下是 **MCP server**，只是由我们发起 TCP/TLS/WS 连接。职责：
   - 应答 `initialize` → `{protocolVersion:'2024-11-05', capabilities:{tools:{listChanged:true}}, serverInfo:{name:'dsh-xiaozhi', version}}`；
   - 应答后**主动发** `notifications/initialized`（对齐参考实现；若平台自身也发该通知，忽略即可）；
   - 应答 `tools/list`（支持 `cursor` 分页）；
   - 应答 `tools/call`（`result.content[].type==='text'`）；
   - 应答 `ping` → `{"jsonrpc":"2.0","id":<同型 id>,"result":{}}`；
   - 收 `notifications/cancelled` → 按 `requestId` 取消（映射到 job cancel）。
2. **对称派发器（必须）**：`handleIncoming(msg)` 按 `method` 分派，不按"角色"分派；同时识别"响应帧"（有 `id` 且无 `method` 且有 `result`/`error`）并交给 pending-request 表（H2 时用）。表里同时容纳：`initialize`、`initialize 结果`、`tools/list`、`tools/list 结果`、`tools/call`、`ping`、`notifications/*`、未知 method（记 debug 日志、若是请求则回 `-32601`）。
3. **H2 容错**：若探针显示平台确实要求我们"先发 initialize 再被 tools/call"（非标准混合型），只需翻转 `protocol.direction` 一个配置值，派发器与工具层不动。
4. **不得声明未实现的能力**：我们**不发** `capabilities.roots/sampling/elicitation`（v1 §2.6 建议发 `roots.listChanged`+`sampling`，会让平台给我们发 `sampling/createMessage`，我们只能回 -32601）。

**备选**

| 方案 | 优 | 劣 |
|---|---|---|
| (a) 严格标准角色（插件=server，只应答） | 与参考实现一致、可预测 | 若平台接入点真是"由连接方发起 initialize"的非标准形态，握手失败 |
| (b) 严格按用户原话（插件=client 发 initialize/tools/list） | 贴合用户描述 | 与"被动响应 tools/call"自相矛盾，工具面无法发布 |
| (c) **对称派发器 + 方向配置**（采纳） | 两种假设同一份代码；探针出结果后只改默认值 | 多约 30 行分派逻辑与一张方向表 |

**代价**：`ConnectionState` 的 `syncing` 语义要重定义（从"我们取平台工具"改为"我们发布工具、等待平台首次 tools/list"）；v1 §2.6 的状态机与 §2.8.3 的测试项需按此重写（见 §2.5）；`notifications/tools/list_changed` 的发送时机改为"平台已向我们发过 tools/list 之后"。

---

### ADR-102 角色模型：双角色 vs 单角色（复议 v1 ADR-001）

**决策**：保留 `config.mode = 'endpoint' | 'server' | 'both'`，默认 `endpoint`。两者是**平级 adapter**，共享 ToolCatalog / CapabilityRegistry / 替身执行器，`mode` 只决定挂载哪些 adapter。
`both` 的定位收窄为**开发期自测**：默认关闭，开启时 `system_status` 标记 `mode:'both'` 并要求显式确认（防止生产环境两套入口同时对外）。

**备选**：①只做 endpoint（失去"小智连我"）；②二值 mode（联调要重启）；③拆两个包（两套 patch/设置页/能力层重复）。

**理由**：v1 的判断成立——adapter 已独立，多一个枚举值成本≈0；而"不支持同时"必然引出"再加一个 mode"的返工。

**代价**：`both` 下共享 `submissionRegistry` 与环形缓冲，必须禁止同一逻辑请求被两条链路重复计入并发与幂等；设置页需分区展示"我连平台"与"平台连我"两组字段（`settings-ux-walkthrough.md` 屏 9 已覆盖）。

---

### ADR-103 server 角色传输：streamable-HTTP 为主（复议 v1 ADR-002，采纳）

**决策**：`server.transports: ('stream-http' | 'ws' | 'legacy-sse')[]`，默认 `['stream-http','ws']`。
- `stream-http`（主）：`ctx.webServer.register({ kind:'exact', path: server.path })`，同一 handler 按 method 分派：`POST`（JSON-RPC；`Accept` 含 `text/event-stream` 则回 SSE 单帧，否则回 JSON）、`GET`（SSE 上行通道，可选）、`DELETE`（结束会话）；会话 id 走 `Mcp-Session-Id`，缺失则无状态降级。
- `ws`（**按约束保留**）：`ctx.webServer.registerUpgrade({ path: server.path, handler })`，与上面**同路径可共存**（HTTP 路由表与 upgrade 表是两张表）；**默认关闭**，探针 P-A 证实平台会 WS 连出后才打开。
- `legacy-sse`：默认关。
- `server.standalonePort > 0`：另起 `node:http`（与参考插件同款），只挂 MCP 面。

**硬约束（实测）**：`registerUpgrade` 只接受**绝对 pathname、无尾斜杠**，且同一路径重复注册会 **throw**；`register({kind:'exact'})` 同一 (kind,path) 重复也 throw。因此 `server.path` 必须避开参考插件已占用的前缀，并在挂载失败时把异常转成 `DSH_XZ_1015`（而非让插件整块加载失败）。

**备选**：①只做 WS upgrade（平台是否支持未证实 → 可能"代码全对、平台连不上"）；②只做老式 `GET /sse`+`POST /messages`（与 streamable-http 是两套，两者都挂在 `server.path` 的不同子路由上最稳）；③只做独立端口（跨源、鉴权多一套）。

**理由**：功能可用性优先。HTTP 传输把"帧编解码/掩码/分片/控制帧/反代 Upgrade 透传"整块风险从 server 角色移走，并天然复用 DSH 的 webServer 与反代配置。

**代价**：需实现 `Mcp-Session-Id` 生命周期与两种响应形态；三套传输统一到 `ServerTransport{onMessage,send,close,sessionCount}`，每个只做编解码。**上线前用平台自带 MCP 调试面板做一次真实握手**，把 `Accept`/`Mcp-Session-Id` 观测值写回本 ADR。

---

### ADR-104 执行路径：进程内替身（唯一路径）+ 两条新契约（复议 v1 ADR-003，采纳并补强）

**决策**
1. **结构化接口替代伪造类实例**（沿用 v1）：把复制层 handler 签名改为 `RouteRequest`/`RouteResponse`，两个适配器 `fromNodeHttp`（真实流量）与 `createDoubles`（进程内）。**不伪造 `new IncomingMessage/ServerResponse`**（依赖未文档化的 `OutgoingMessage` 内部行为）。
   实测复制层真正用到的面很小：`res` = `{statusCode, setHeader, headersSent, write, end, flushHeaders, writableEnded, destroy}`（8 个）；`req` = `{url, method, headers, on, destroy}`（5 个）。
2. **新增契约 A：ALS 契约。** 复制层的 `streaming.ts` 用 `askSessionStorage.run({sessionId}, …)` 让反问桥认领归属（`streaming.ts:22/213/409`，`user-questions.ts:80`）。因此**替身不是"伪造 req/res"这么简单**：`invoke()` 对 `sessions.prompt*` / `chat.completions` 能力必须在 `askSessionStorage.run({sessionId})` 内执行，否则"反问"会归属失败 → 工具永久挂起。契约写进 `InvokeOptions{ alsSessionId?: string }`。
3. **新增契约 B：流式响应/背压契约。** 下载类路由用 `createReadStream().pipe(res)`（`files.ts:224`、`fs.ts:165`、`skills.ts:132`）。`Readable.pipe` 依据 `write()` 返回值决定是否暂停、并在 `'drain'` 时恢复——所以替身 `res` **必须是真正可 `write` 且会 `drain` 的对象**（用 `Writable`/`PassThrough` 实现），否则：
   - `write()` 恒返回 `true` → 无背压 → 大文件全部堆进捕获缓冲 → **OOM**；
   - 若恒返回 `false` 又不发 `'drain'` → **永久挂起**。
   规格：`RouteResponse` 是 `Writable`，带 `maxCaptureBytes`（默认 8 MiB，超出即 `destroy(err)` 并回 `DSH_XZ_1009`）与 `signal` 驱动的 `destroy()`。
4. **能力表单一事实源**（沿用 v1）：`cap(router, spec, handler)` 同时登记路由与能力元数据；REST 面与 MCP 工具目录（含 flat 派生）都从它生成；启动自检"无孤儿路由、清洗后无重名"。

**备选**

| 方案 | 优 | 劣 |
|---|---|---|
| (a) 环回 HTTP `fetch('http://127.0.0.1:'+port+prefix+path)` | 语义 100% 真实；**可作为等价性测试的 oracle** | 依赖 webServer 存在（headless/纯 endpoint 组合直接失效）；端口发现；需自注入 apiKey；`localhost` 双栈可能解析到 `::1` 而服务只听 `127.0.0.1`；大 body 与超时 |
| (b) 直调 `ctx.get('sessionController')` 等 | 无中间层，最快 | 等于重写 51 条路由的参数映射；`ownTurn` 差量补推、历史 cursor、统计推断、技能目录校验这些**已验证细节**必然漂移；两套面长期分叉 |
| (c) 伪造 `new IncomingMessage(socket)` | 复用现有类型 | 类型要 `as any`；写行为未文档化；升级 Node 踩雷 |
| (d) **结构化替身（采纳）** | 契约被编译器固化；可单测 | 需逐文件小改签名 + 承担等价性测试义务 |

**理由**：(a) 的失败模式是"环境相关、难复现"，对无人值守长期运行的语音插件不可接受；(b) 让"拷贝参考插件"的收益归零；(c) 把不确定性藏进类型断言。

**代价**：复制层每个文件都要改（类型注解 + `cap()` 登记 + `trusted` 派发），改动必须收敛为可复核的三类（见 ADR-105 与 §3 R9）；必须写**等价性测试**（51 条能力：真实临时端口 vs 替身，断言 `status` + body 深相等，剔除 `timestamp`）。

---

### ADR-105 模块划分与依赖方向（复议 v1 ADR-004，采纳 + 3 条硬规则）

**决策**：单向分层，禁止反向 import。

```
index(apply/Config) ─┬─→ config ───────────────────────────────┐
                     ├─→ admin ─────→ capability ──→ api ──→ ctx services(DSH)
                     ├─→ transport ─→ mcp ────────→ capability │
                     └─→ mcp(tool-catalog)                      │
                                    （config 可被所有层读，不反向依赖）
```

硬规则（新增 3 条，纳入 code review 检查项）：
1. `lib/api/*` 内**不得出现** `fetch`/socket/`process.env`（保持可被替身执行、且不引入第二配置源）。
2. `lib/api/*` 内 handler **只能用** `RouteRequest`/`RouteResponse` 的成员集合；新增成员必须先改接口 + 两个适配器（用一个 5 行的静态扫描脚本在 CI 里挡住 `req.socket`/`res.socket` 之类越界访问）。
3. `capability/invoke` 是**唯一**同时知道"能力表"与"替身"的模块；`transport/*` 不 import `api/*`。

**理由**：本插件最大的长期成本是"参考插件的 REST 层继续版本漂移"。把 `api/*` 做成**不认识 MCP** 的一层，未来整目录覆盖跟进时冲突面只在 `cap()` 登记处。
**代价**：多一层间接；新增能力要同时写 route + 元数据 → 用单次 `cap()` 消除漏登记，并在 `system_status.orphanRoutes` 暴露自检结果。

---

### ADR-106 配置分层与持久化（**推翻 v1 ADR-005**）

**事实更正**：**`$DSH_PROFILE_DIR` 在 DSH 中不存在。** 枚举 `@deepseek-ai/*` 全部 `DSH_*` 变量（`dsh-home-paths`、`dsh-shell-env`、`dsh/lib/bin.js` 等）得到的是 `DSH_HOME`（唯一 home 覆盖变量）、`DSH_HOME_DIR_NAME`、`DSH_AGENTS_HOME`、`DSH_BUNDLED_SKILL_DIR`，以及一批进程内 key（`DSH_PROFILE_KEY`/`DSH_PROFILE_DIR_KEY`，非环境变量）。home 解析优先级实测为：**显式配置 > `$DSH_HOME` > `~/.dsh`**。

**决策：配置走平台通道，状态才走 sidecar。**

| 层 | 载体 | 谁写 | 用途 |
|---|---|---|---|
| L0 内置默认 | `Config`（schemastery） | 代码 | 所有字段有默认值 |
| L1 部署意图 | profile patch 的 **`base`** 段（`cordis.patch.yml`） | 人/部署脚本 | mode、路径、端口、工具编织、并发上限 |
| L2 用户覆盖 | profile patch 的 **`user`** 段 | **`ctx.settings.update/replace/mutate`** 或设置页 | endpoint.url/token、waitMs、缓冲、工具组开关 |
| L3 环境 | `DSH_XIAOZHI_*` | 运维 | 最高优先级、只读、覆盖之上全部 |
| — | **运行期状态**（非配置）：`<dshHome>/xiaozhi/state.json` | 插件 | 最近一次连接质量、平台能力探测结果、lastError；**不含用户可编辑配置、不含明文 token** |

- **secret**：`endpoint.token` 声明为 `z.string().role('secret')`，`describe({redactSecrets:true})` 只回"是否已设置"；设置页写入用 **`SettingsForms.mutate(ns, [{op:'set',path:['endpoint','token'],value}])`**——路径写正是为"只拿到脱敏视图的页面"设计的，避免整段 replace 把其它 secret 抹掉（官方注释即此意）。或按 DSH 惯例退一步：只存**凭证引用**（env 变量名）+ `ctx.credentials` 存值。
- **namespace 解析**：优先 `ctx.fiber.entry?.options.id`（与 `dsh-experimental-speech-to-text` 同一手法），**但该成员不在 cordis 公开类型里** → 必须有回退：①用 `describe()` 返回的 `schema` 与本地 `Config` 实例做**同一性比较**定位自己的 descriptor；②两者都失败则整体降级到 sidecar（并在 `system_status.configChannel='file'` 里明说）。这是探针 P-B 要回答的问题。
- **并发写**：`update/mutate` 带 `expectedRevision`；捕获 `SettingsConflictError` → 重读后重放（UI 侧提示"配置已被其它窗口修改"）。
- **`writable===false` 的 profile**：直接切 sidecar，不报错。

**备选**：①（v1）`$DSH_PROFILE_DIR/...config.json` 自建文件 + 自定 `scope: deploy|user` 分层 → **否决**：路径变量不存在，且 `base`/`user` 分层、revision 校验、secret 脱敏、冲突检测平台已全有；②只放 patch config（设置页无法保存）；③全局单文件 `$DSH_HOME/dsh-xiaozhi.json`（多 profile 抢写、token 串扰）；④写进插件安装目录（升级即被覆盖）。

**理由**：v1 手搓的三件事——**分层、脱敏、冲突**——恰好是 `SettingsForms` 的三项既有能力（`SettingsDescriptor{base,user,revision,secrets}`、`redactSecrets`、`SettingsConflictError`）。少写一套配置系统 = 少一类"改了不生效"的支持工单。

**代价**：①依赖 DSH settings 服务的 API 与 peer 版本范围（需写进 `peerDependencies` 并用 `ctx.get('settings')` 守卫，服务缺失即降级 sidecar）；②namespace 解析走了一条非公开成员（有回退，但要写测试）；③sidecar 仍要保留（headless/只读 profile），因此**两条路径都要测**，只是其中一条是冷路径。

---

### ADR-107 自研 WebSocket 的范围（**收缩 v1 ADR-006**）

**实测结论（Node v22.19.0）**：`globalThis.WebSocket` 存在且可用；`new WebSocket(url, {headers:{…}, protocols:['mcp']})` **可用**（undici 的非标准扩展），握手成功、子协议协商成功、默认发 `Sec-WebSocket-Extensions: permessage-deflate`（undici 自实现压缩）。原型上没有 `ping()`（WHATWG 语义），但**这不需要**：小智的保活就是 **MCP 协议级 `ping` 请求**（参考实现每小时刻在 `WebSocketMCP.cpp:200-211`）；undici 也会自动回对端 ping。

**决策**
1. **client 方向（endpoint 角色的物理连接）用内置 `globalThis.WebSocket`**。理由：零依赖（满足"只用 Node 内置模块"），把 TLS、HTTP Upgrade、掩码、分片重组、UTF-8 校验、permessage-deflate、`Accept` 校验整块从我们的代码里移除——**v1 计划自研的这 350–450 行 + 黄金向量测试，其唯一收益是"能服务端"**，而 client 方向不需要它。
2. **自研 RFC6455 framing 只在"必须是 WS server"时实现**：即 ADR-103 的 `transports` 含 `'ws'` 时。而 ADR-103 已把 WS 降为默认关 → **自研协议代码从"主线必做"变为"按需分支"**。
3. 保留 `WsTransport` 接口与 `ws/frame.js` 的位置，但**排期在探针 P-A 之后**；实现范围仍按 v1 钉死（无压缩协商、无二进制、控制帧 ≤125 且 FIN=1、RSV 必须 0、单消息 ≤1 MiB、close code 语义、5s 尾帧丢弃窗口）。
4. 运行期**特性探针**：`typeof WebSocket === 'function'` 为假（Node <21）时，`system_status` 报 `transport:'unsupported-node'` 并给出 Node 版本要求；不做静默降级。

**备选**：①`ws` 包（违反零依赖约束）；②全自研（v1 方案，收益仅服务端方向，代价是 TLS+握手+掩码+分片全自测）；③内置 WebSocket + 自研 framing 仅在 server 方向（**采纳**）。

**代价**：①client 方向失去"观测 ping/pong 帧"的能力 → 半开检测改为**协议级探测 + 静默看门狗**（见 §2.5），默认保守（只降级不误断）；②失去自实现 CONNECT 隧道的能力（代理支持改由 undici 的全局 `dispatcher` 承担，反而更强，但需文档说明如何配）；③依赖 Node ≥21 的 undici 行为，需在 `package.json` 的 `engines` 与 README 里写明；④`{headers}` 是非标准扩展，`@types/node` 可能不接受该重载 → 需一处类型断言（并在注释里写明原因）。

---

### ADR-108 SSE 类能力在 MCP 上的语义降级（复议 v1 ADR-007，采纳 + 补 3 处）

**决策**（沿用 v1 三层）：
1. **事件从"推送"变"可拉取"**：插件内常驻**一个** `ctx.on('session/event')` 监听器（不是每次调用订阅），写入有界环形缓冲 `Map<sessionId, RingBuffer<EventRecord>>`；`dsh_events{sessionId, sinceSeq?, limit?}` 返回 `{events, nextSeq, truncated}`。HTTP 面 `GET /sessions/:id/events` 保持原 SSE 形态。
2. **`prompt-stream` → 两段式 `dsh_ask`**：`submissionRegistry` 记 `requestId → {sessionId, submittedAtSeq}`；订阅在**提交之前**建立并忽略 `seq ≤ submittedAtSeq`（复用参考实现已修正的 `ownTurn` 语义，抽成共享模块 `api/turn-waiter.ts`）；等待窗口 `waitMs`（默认 15s，上限 `maxWaitMs` 60s）；超窗返回 `TIMEOUT_PARTIAL` + 部分文本 + `taskId`，且 **`isError:false`**（语义是"还在跑"）。
3. **二进制不映射为文本**：`files/download`、`fs/download`、`skills/:name/archive` 统一回**元数据 + 一次性签名下载链接**（含 `bytes/mime/sha256`，TTL 5min，HMAC，单次有效，路径白名单限定在该会话 cwd 内），并标 `mcp.expose:'metadata-only'`。上传优先 `path`（同宿主本地文件），`base64` 仅小文件（≤1 MiB）。

**补 3 处（v1 缺）**
4. **无 `requestId` 的平台重试去重**：语音平台重发同一条 `tools/call` 时，`jsonrpc.id` 很可能变（它未必实现幂等键），`requestId` 也可能不传。因此再加一层**内容指纹**去重：指纹 = `hash(sessionId + prompt + 5s 时间窗)`；命中则返回既有 taskId 并以文本明确说明"上一次同样的请求正在处理中"，**绝不第二次 `followup`**。这是"重复下发把代码改坏"的唯一兜底。
5. **结果可不落内存**：`dsh_task{action:'result'}` 优先从**会话历史**（`GET /sessions/:id/history`，`seq` 游标稳定）取回最终助手消息，环形缓冲只作为快路径。理由：DSH 的会话状态是持久的，而**我们的内存状态会随重启消失**——用平台已有状态做真相源，插件重启后 taskId 仍可读（taskId 编码为 `sessionId + turnSeq` 即可）。
6. **返回文本必须"可念"**：所有工具结果统一经 `render()`：长 JSON 先折叠为"一句话结论 + 至多 3 条要点 + 需要时说'要听详情吗'"；`textLimit` 默认 1200 字符，截断处显式标注并给续读游标（`dsh_task{action:'result', offset}`）。结构化数据放在 `structuredContent`（平台可选忽略），**文本通道永远是自然语言**。

**备选**：①依赖 `notifications/progress`/`notifications/message` 推进度（平台支持未知；语音助手没有异步播报通道，架构上**不依赖**，仅 best-effort）；②单一阻塞式 ask（等 60–180s：平台超时 + LLM 重试 + 无法取消，参考实现 `executePromptAndWait` 的 `timeoutMs||180000` 正是这个形状，`streaming.ts:511`）；③用 MCP sampling 承载反问（支持未知，语义与超时不可控）。

**理由**：语音链路的可用性上限是"人能等多久"。降级后每次调用 ≤20s 且可幂等重试，是唯一同时满足"平台超时未知 / 用户不愿等 / 真实回合可能 10 分钟"的形状。

**代价**：taskId 生命周期管理（TTL 30min，按会话 + requestId 双索引）；长任务体验退化为"稍后再问"；必须有语音友好截断与续读。

---

### ADR-109 并发与背压（复议 v1 ADR-008，采纳 + 写侧）

**决策**
- **读循环绝不 await 业务**：收帧 → 解析 → 入队 → 立刻回到读；所有 handler 在 `ToolCallQueue` 执行。
- **三级限流**：全局 `maxInFlightTools=4`、单连接 `perConnectionInFlight=2`、队列 `queueDepth=16`；队列满或排队超 `queueWaitMs=5000` → 立刻 `isError:true` + `[DSH_XZ_1010] BUSY`（**显式拒绝，不静默丢弃**）。
- **写侧背压（新增）**：出站帧进有界队列（`outQueueDepth=64`，`maxOutMessageBytes=256 KiB`）；`send` 遇对端积压 → 等待并在 `writeDeadlineMs=5000` 内未缓解则判连接不健康（进 `backoff`），**不得无界堆积**。
- **预算分离**：`admissionTimeoutMs=5000`（`resolveAgent` + `followup` 的准入）与 `waitMs`（回合等待）分开；`waitMs` 到点**返回部分结果而非抛错**。
- **幂等**：key = `(connectionId, requestId ?? jsonrpc.id)`，**外加 ADR-108.4 的内容指纹**；命中即回既有状态。
- **会话互斥**：同会话已有 in-flight ask → `[DSH_XZ_1004] SESSION_BUSY`，显式 `mode:'steer'` 才插话（对应 `agent.steer`，`streaming.ts:484`）。
- **断线收敛**：非 `ready` 状态下 in-flight 一律以 `[DSH_XZ_1012]` 结束且**不回放**；DSH 侧回合继续跑，结果留给 `dsh_task`。
- **多客户端**：每连接独立队列/计数；`server.maxConnections=8`（超出 503）；共享 `submissionRegistry` 与环形缓冲。

**备选**：无限并发（三条语音指令即可打满 DSH）；全串行 1（毫秒级"查状态"被长任务堵死）；再引入进程内 worker 队列（DSH 已有会话级串行语义，再加一层只增加状态与超时层数）。

**代价**：`maxInFlight` 需按机器调参；`BUSY`/`SESSION_BUSY` 会被小智 LLM 当作失败播报 → **必须写进工具描述**："遇到 BUSY 先 `dsh_task` 查看，不要重复提交"。

---

### ADR-110 工具面编织（复议 v1 ADR-009，采纳 + 2 处收紧）

**决策**：`tools.face: 'grouped'（默认）| 'flat' | 'both'`；`tools.groups` 逐组开关；`tools.namePrefix` 默认 `dsh_`。

**收紧 1 —— flat 必须显式列举且封顶**：flat 从能力表派生，但**默认只暴露白名单组**，且 `tools.flat.maxTools` 默认 **24**（v1 的"≈51 个"与它自己的理由冲突：语音场景 LLM 从 51 项里选必错）。派生规则沿用 v1：`namePrefix + lower(method) + '_' + path（去前导 `/`，`/`→`_`，`:param`→param）`。
**收紧 2 —— 命名冲突不许"自动 `_2`"**：清洗/长度归一后的重名一律**判为配置错误**（`DSH_XZ_1015`，`listTools` 返回前即失败并在设置页高亮），因为静默改名会让程序化调用者指向错误的端点，比拒绝更难查。
**收紧 3 —— flat 的稳定性声明**：flat 名字**绑定上游路径**，上游一改就变；因此 flat 明确标注"程序化/调试用，未来可能重命名"，而 grouped 的 17 个名字**冻结为兼容契约**（改名走 minor 版本 + `notifications/tools/list_changed`）。
**工具目录并入 1 项**：删除 v1 的 `dsh_agent`（与 `dsh_ask` 无 sessionId 时的 `chat/completions` 路径重复，两个工具覆盖同一能力只会让 LLM 纠结），**grouped 定为 17 个**（§2.4）。
**命名/描述硬约束（沿用）**：名字 `^[a-z0-9_-]{1,40}$`、全小写、必带前缀、禁中文；**描述内不得引用其它工具名**（平台会清洗描述里的名字）；启动自检"清洗后无重名 + 描述不含工具名"。
**自描述**：`dsh_help{action:'tools'|'docs'|'openapi'|'groups'}`；`openapi.json` 不进文本通道，只回 URL + 端点计数 + 关键词检索结果。
**目录变更**：平台声明 `capabilities.tools.listChanged` 时，运行期改配置后发 `notifications/tools/list_changed`（**且只在平台已发过 `tools/list` 之后**）；否则 `tools.face`/`groups` 的变更标记 `restartRequired` 并在设置页提示。

**备选**：只用 flat（51 项误选率高、描述总量大）；只用 grouped（程序化场景表达力不足）；单一 `dsh_do{intent,text}` 万能派发（把路由决策推回平台 LLM，schema 约束等于放弃）。

**代价**：grouped 的 `action` 枚举要映射多条能力 → 错误语义必须归一（`action` 拼错 → `INVALID_ARGS` 并回列合法枚举）；两种编织测试矩阵翻倍 → 用"flat 为基准、grouped 只测派发"的策略控制成本。

---

### ADR-111 可选依赖的表达方式（**采纳 v1 ADR-010，已实测**）

**实测**：`cordis/lib/types/registry.d.ts:13` 的 `Inject = (keyof M)[] | { [K in keyof M]?: M[K] }` —— **数组与对象形式都表示必需，没有 required/optional 语义**；`registry.d.ts:104-112` 明确 `ctx.inject(deps, callback)`："服务可用时运行回调；所需服务变化时回调被卸载并重跑"。

**决策**
- 顶层 `export const inject` **不含 `webServer`**（本插件为 `[]`，若保留 DSH 侧信息工具则 `['tools']`）。→ **这是对约束①的一处技术修正，需用户确认**：约束写的是 `inject=['webServer']`，那会让纯 headless/无 webServer 的组合里插件整块不激活，**endpoint 角色（架构上不依赖 DSH HTTP 服务）被连带禁用**。
- `webServer` 的可选性用 `ctx.inject(['webServer'], (ctx) => { … })`：服务出现时挂 server 角色、管理路由、index 注入；消失时 fiber 自动回滚。
- 所有 DSH 服务访问一律 `ctx.get('x')` 守卫，缺失项登记进 `system_status.degradedDependencies`（形如 `[{service:'sessionController', affects:['dsh_ask','dsh_session']}]`）。
- index 注入用结构化行 `ctx.on('webserver/index-inject', t => t.push({kind:'global', name:'__DSH_XIAOZHI__', value:{…}}))`（`IndexInjection` 类型已实测存在），不用 `tapIndex` 字符串改 HTML。

**代价**：失去静态依赖可视化（由 `degradedDependencies` 运行期补偿）；`ctx.inject` 回调内的资源必须用 `ctx.effect` 注册以便回滚，容易漏写 → 纳入 code review。

---

### ADR-112 配置/状态通道与鉴权（**修正 v1 ADR-011**）

**决策**
- **配置读写走 `ctx.settings`（ADR-106）**，不再自建 `/admin/config` 的写通道；设置页优先使用平台设置表单/命名空间（自带鉴权、revision、脱敏、CSRF 路径）。
- **插件自有 REST 只保留两类**：①`status`（只读快照：连接状态、生效配置的 `{effective, source, locked}`、工具目录预览、degradedDependencies、孤儿路由、命名冲突）；②`actions`（`reconnect`/`disconnect`/`test_connection`/`refresh_tools`/`rotate_token`（写 token 走 settings）/`set_group`）。
- **鉴权**：每进程 `adminToken = randomUUID()`，仅经 `webserver/index-inject` 注入到同源页面（`{kind:'global', name:'__DSH_XIAOZHI__'}`），所有 admin 路由要求 `X-DSH-Xiaozhi-Admin` 且用 `crypto.timingSafeEqual` 比较；不落盘、不进日志、不返回给任何 MCP 工具。**无 index 注入能力的环境（`standalonePort` 直连）默认关闭 admin 面**，除非显式配 `admin.token`。
- **能力面（复制层 REST）默认只允许 loopback**（或要求 `apiKey`/adminToken）：`webServer` 绑定 `0.0.0.0` 时，`/dsh-xiaozhi/api/**` 等于把"改配置、读历史、读日志"暴露给局域网。
- **设置页座位**：`settings.section`（约束⑥），注册 `{id:'dsh-xiaozhi', order:40, label:'小智语音'}`；**同时调用 `ctx.settings.configure({auto:false})`** 抑制平台为同一 namespace 自动生成的配置表单——否则用户会看到两个编辑同一份配置的页面，其中一个是"沉默否决"的元凶（`settings-ux-walkthrough.md` §4.3 已经踩过这个坑）。

**备选**：①（v1）配置读写全走自建 REST + 自建 adminToken（能用，但重复实现持久化/脱敏/冲突，且 adminRest 是唯一未鉴权面）；②Origin/Host 校验（反代与 `0.0.0.0` 场景易误判，且不防同机其它进程）；③复用 `apiKey`（浏览器页面无法安全持有长期密钥）；④不鉴权（LAN 内等于开放）。

**代价**：admin 面在进程重启后旧 token 失效 → 页面 401 时需提示"请重新加载页面"；`__DSH_XIAOZHI__` 出现在 HTML 里属可接受暴露（同源页面本就能访问 API），但必须写进 README。
**新增代价（v1 无）**：设置页与 `ctx.settings` 的版本耦合；`ctx.fiber.entry` 这条非公开路径要有回退（ADR-106）。

---

### ADR-113 token 与出境数据治理（复议 v1 ADR-012，采纳 + 落地方式变更）

**决策**
- **存储**：token 为 `Config.endpoint.token`（`role('secret')`）→ 由平台脱敏；或按 DSH 惯例只存**凭证引用**（env 名）+ `ctx.credentials` 存值。**不落自建 JSON 明文**（v1 的 0600 明文文件不再是必需项）。
- **展示**：`status` 只回 `tokenConfigured: boolean` + `tokenSource:'env'|'profile'|'none'`（**连掩码都不必回**，平台脱敏已给出"已设置"语义）。
- **日志/错误**：统一 `redact()` 兜底（过滤 `?token=`、`Bearer `、`Authorization`），即使平台已脱敏也保留（防我们自己拼错误信息时把 URL 带出去）。
- **工具目录不含 URL/路径/密钥**（目录会出境到平台）：`dsh_status` 只回 `endpointHost:'api.xiaozhi.me'` 这类主机名，不回完整 URL。
- **失败即停**：HTTP 401/403 或 close 4401/4403 → `fatal`，**停止自动重连**，`status.lastError='TOKEN_INVALID'`，设置页引导"重新粘贴 token"。
- **轮换**：`actions.rotate_token` 写 settings → 触发 `reconnect`（旧连接优雅关闭）。
- **出境数据清单（新增，必须写进 README）**：①所有 `dsh_ask` 的 prompt 全文；②所有工具返回文本；③工具目录（名字+描述+JSON Schema）；④会话标题/路径片段（若被工具返回）。**不进境**：token、本地绝对路径（工具参数里的 `path` 会出境——需明说）、日志原文。

**代价**：无自动刷新 token（平台是否提供刷新接口未知），过期需人工；README 必须写清出境面；`path` 参数出境是**设计上的隐私折衷**，只能靠"默认关掉 files 组"来降低。

---

## 2. 模块与接口规格

> 以下相对 v1 的差异全部标注 **[=v1]**（沿用）/ **[+新]** / **[改]**。v1 §2.2 未在此重述的类型按 v1 执行。

### 2.1 文件清单（每个一句话职责）

```
dsh-xiaozhi/
├── package.json                  # [+] dsh.bundle.patch + dsh.client{platform:'web'} + exports('./client','./locale/*') + peerDeps(cordis,schemastery,dsh-host-webserver,dsh-settings)
├── cordis.patch.yml              # [=] insert 一行：name=@dsh-external/dsh-xiaozhi, config:{}
├── icon.svg / locale/{zh,en}.json# [=] 插件卡片图标与文案
├── src/index.ts                  # [改] apply(ctx,config)+Config+分阶段挂载；inject 不含 webServer（ADR-111），webServer 用 ctx.inject
├── src/config/schema.ts          # [+] schemastery Config；token 标 role('secret')；字段分组与 restartRequired 标注
├── src/config/settings-bridge.ts # [+] namespace 解析（entry id → schema 同一性 → sidecar 回退）、update/mutate、SettingsConflictError 重放
├── src/config/sidecar.ts         # [+] <dshHome>/xiaozhi/state.json 读写（原子 tmp+rename，0600，只存运行期状态）
├── src/obs/log.ts                # [=] 有界日志环形缓冲 + redact() + 结构化事件（供 admin/logs 与 status）
├── src/mcp/protocol.ts           # [=] JSON-RPC 信封编解码、id 类型回显、错误码常量、协议版本常量
├── src/mcp/dispatch.ts           # [+] 对称派发器（ADR-101）：按 method 分派 + 响应帧路由 + 未知 method 策略 + direction 开关
├── src/mcp/session.ts            # [改] 服务端视角的会话状态机：await-initialize → initialized → tools-published → ready（§2.5）
├── src/mcp/tool-catalog.ts       # [=] ToolSpec 注册表、grouped/flat 编织、名称归一与冲突即失败、描述渲染与"可念"文本 render()
├── src/mcp/tools/{system,workspace,session,prompt,models,files,skills,flat}.ts  # [改] 17 个工具（§2.4），flat 生成器带走白名单与上限
├── src/capability/registry.ts    # [=] cap() 装饰器：注册路由 + 登记能力元数据 + 启动自检（孤儿/重名/越界 res 成员）
├── src/capability/http-double.ts # [改] RouteRequest/RouteResponse 接口 + fromNodeHttp + createDoubles（Writable 语义 + maxCaptureBytes + signal→destroy）
├── src/capability/invoke.ts      # [改] invoke(id,args,opts)：替身执行 → 归一 {status,ok,data,error}；opts.alsSessionId 包裹（ADR-104 契约 A）
├── src/capability/events-ring.ts # [=] 全局 session/event 环形缓冲 + sinceSeq 游标 + LRU 淘汰 + 单条截断
├── src/api/*.ts                  # [改] 复制层 10 个模块 + router.ts（签名改结构化接口、trusted 内部派发）；不含任何 fetch/socket/env
├── src/api/turn-waiter.ts        # [=] 抽取共用：提交前置订阅 + ownTurn 归属 + 增量补推 + 超窗返回部分文本
├── src/api/user-questions.ts     # [改] 答复桥：只认领自己的 ALS 会话、改 append（非 prepend）、answerBridge: 'own-only'|'auto'|'off'
├── src/api/README-COPY.md        # [=] 逐文件改动清单（收敛为三类），便于跟随上游
├── src/admin/routes.ts           # [改] 只留 status/actions/logs/tool-face-preview + adminToken 校验（配置写走 settings）
├── src/admin/index-inject.ts     # [=] webserver/index-inject 注入 __DSH_XIAOZHI__（adminBase/apiBase/version/adminToken）
├── src/transport/endpoint-link.ts# [改] endpoint 编排：连接、方向配置、握手、发布工具、保活看门狗、断线收敛
├── src/transport/server-link.ts  # [=] server 编排：会话表、并发上限、standalone 端口
├── src/transport/stream-http.ts  # [=] streamable-HTTP 传输（POST/GET/DELETE + Mcp-Session-Id + SSE 单帧）
├── src/transport/legacy-sse.ts   # [=] 老式 HTTP+SSE 传输（默认关）
├── src/ws/frame.ts               # [+] 自研 RFC6455 framing（**仅 server 方向需要，按需实现**，ADR-107）
├── src/ws/upgrade.ts             # [+] upgrade 握手（仅 server 角色 transports 含 ws 时）
└── client.js                     # [=] 设置页客户端模块：__ModuleLoader__.load({id,factory})，settings.section 座位
```
**与 v1 的净差异**：删 `ws/client.js`（改内置 WebSocket，ADR-107）；新增 `config/settings-bridge.ts`、`config/sidecar.ts`、`mcp/dispatch.ts`；`user-questions.js`/`http-double.js`/`invoke.js`/`admin/routes.js` 为**必须修改**而非原样复制。

### 2.2 关键类型签名（只列差异与新增）

```ts
// ── 协议方向（ADR-101）────────────────────────────────────
type ProtocolDirection = 'serve' | 'initiate'      // serve=H1(默认) / initiate=H2(非标准混合型)
interface DispatchTable {                          // 对称派发器：请求、通知、响应三类分流
  onServerRequest: Map<string, (params: unknown, ctx: CallContext) => Promise<unknown>>
  onNotification: Map<string, (params: unknown, ctx: CallContext) => void>
  pending: Map<string, { resolve(r: unknown): void; reject(e: unknown): void; deadline: number }>
}

// ── 替身契约（ADR-104）────────────────────────────────────
interface RouteResponse extends Writable {         // 【改】必须是真 Writable：pipe() 依赖 write() 返回值与 'drain'
  statusCode: number; headersSent: boolean; writableEnded: boolean
  setHeader(n: string, v: string | number | string[]): void
  write(chunk: string | Buffer): boolean
  end(chunk?: string | Buffer): void
  flushHeaders?(): void
}
interface DoublesOptions {
  method: string; url: string; headers: Record<string, string | string[] | undefined>
  body?: Buffer | string
  maxCaptureBytes?: number        // 默认 8 MiB；超出 → destroy(err) → DSH_XZ_1009
  signal?: AbortSignal            // abort → req.destroy() → 触发 'close' → SSE/下载清理
  alsSessionId?: string           // 契约 A：prompt/chat 类能力必须在 askSessionStorage.run 内执行
}
interface HttpDoubles { req: RouteRequest; res: RouteResponse
                        result: Promise<{ status: number; headers: Record<string,string>; body: Buffer }>
                        sse: Array<{ event: string; data: unknown }>
                        dispose(): void }

// ── 配置通道（ADR-106）─────────────────────────────────────
type ConfigChannel = 'settings' | 'file'
interface SettingsBridge {
  readonly channel: ConfigChannel
  readonly writable: boolean
  resolveNamespace(): string | undefined            // entry id → schema 同一性 → undefined(降级 sidecar)
  read(): Promise<{ value: Config; revision?: number; source: 'env'|'profile-user'|'profile-base'|'default' }>
  write(patch: object, expectedRevision?: number): Promise<void>          // 普通字段
  writeSecret(path: readonly string[], value: unknown, rev?: number): Promise<void> // mutate + path op
}
interface EffectiveField<T> { effective: T; source: 'env'|'profile-user'|'profile-base'|'default'; locked: boolean }

// ── 任务（ADR-108）──────────────────────────────────────────
/** taskId = base64url(`${sessionId}#${turnSeq}`) —— 可编码、可跨插件重启复原（真相源是会话历史） */
type TaskId = string
interface Submission { key: string; fingerprint: string; sessionId: string; turnSeq: number
                       requestId?: JsonRpcId; submittedAtSeq: number; state: 'running'|'done'|'cancelled'|'failed'
                       partialText: string; finalText?: string; usage?: Record<string, number> }
interface TaskRegistry {
  admit(s: Omit<Submission,'state'|'partialText'>): { existing?: Submission; admitted: boolean }  // 幂等 + 指纹去重
  get(id: TaskId): Submission | undefined
  cancel(id: TaskId): Promise<boolean>
}

// ── 传输（ADR-107）──────────────────────────────────────────
interface ClientSocket {                            // 内置 WebSocket 的薄包装（client 方向）
  send(text: string): void; close(code?: number, reason?: string): void
  readonly readyState: 'open'|'closing'|'closed'; onMessage(cb: (t: string) => void): void
}
interface ServerTransport {                         // server 方向：三实现共用一个接口
  readonly kind: 'stream-http'|'legacy-sse'|'ws'
  onMessage(cb: (sessionId: string, text: string) => void): void
  send(sessionId: string, text: string): void
  close(sessionId: string, code?: number): void
  readonly sessionCount: number
}
```

### 2.3 错误码表（v1 基础 + 2 项新增；协议层沿用）

**协议层**（JSON-RPC `error`）：`-32700` PARSE_ERROR｜`-32600` INVALID_REQUEST｜`-32601` METHOD_NOT_FOUND（含 `resources/*`、`prompts/*`、未声明的 `sampling/*`）｜`-32602` INVALID_PARAMS｜`-32603` INTERNAL_ERROR。

**能力层**（`result.content[0].text` 以 `[CODE] ` 开头 + `isError`，并在 `_meta` 携带 `{code, retryable}`）：

| code | 名称 | isError | 触发 | 建议 LLM 行为（写进描述） |
|---|---|---|---|---|
| DSH_XZ_1001 | INVALID_ARGS | true | 参数缺失/类型错/`action` 非法 | 修正参数重试（并回列合法枚举） |
| DSH_XZ_1002 | NOT_FOUND | true | 会话/工作区/文件/技能不存在 | 先列清单 |
| DSH_XZ_1003 | UNAUTHORIZED | true | 平台侧 token 无效或未配置 | 提示用户重新授权 |
| DSH_XZ_1004 | SESSION_BUSY | true | 该会话已有 in-flight ask | 用 `dsh_task` 查看，勿重复提交 |
| DSH_XZ_1005 | TIMEOUT_PARTIAL | **false** | 超 `waitMs`（**仍在跑**） | 播报部分结果，稍后 `dsh_task` |
| DSH_XZ_1006 | CANCELLED | true | 被 `dsh_task{cancel}` 或 `notifications/cancelled` 取消 | — |
| DSH_XZ_1007 | UPSTREAM_ERROR | true | DSH 服务抛错（message 已 redact） | 播报失败原因 |
| DSH_XZ_1008 | UNSUPPORTED_IN_MCP | true | 二进制/流式语义不可映射 | 提示去 DSH Web 端 |
| DSH_XZ_1009 | TOO_LARGE | true | base64 上传/参数/响应捕获超限 | 改用 `path` 或分段 |
| DSH_XZ_1010 | BUSY | true | 全局/单连接并发或队列超限 | 稍后重试，勿并发轰炸 |
| DSH_XZ_1011 | DUPLICATE_REQUEST | **false** | 内容指纹命中正在跑的同一请求 | 告诉用户"上次同样的请求还在处理"，**不要重发** |
| DSH_XZ_1012 | CONNECTION_LOST | true | 断线导致 in-flight 终止 | 重连后 `dsh_task` 取回 |
| DSH_XZ_1013 | DEPENDENCY_MISSING | true | 所需 DSH 服务当前不可用 | 提示能力暂不可用 |
| DSH_XZ_1014 | RATE_LIMITED | true | 主动限流（防 LLM 循环调用） | 停止重试 |
| DSH_XZ_1015 | TOOLFACE_INVALID | true | 工具名冲突/超上限/描述引用工具名（启动期拒载 + 设置页高亮） | — |
| DSH_XZ_1016 | RESTART_REQUIRED | true | 该配置项需重启（`tools.face`/`groups` 且平台不支持 listChanged） | 提示用户重启后生效 |

**传输/连接层**（只进日志与 `status`）：`XZ_2001 WS_HANDSHAKE_FAILED`｜`XZ_2002 WS_PROTOCOL_ERROR`（含 close code）｜`XZ_2003 WS_UNAUTHORIZED`（HTTP 401/403）｜`XZ_2004 RECONNECT_EXHAUSTED`（仅 UI 提示）｜`XZ_2005 TLS_ERROR`｜`XZ_2006 HTTP_SESSION_INVALID`（`Mcp-Session-Id` 不识别）｜`XZ_2007 TRANSPORT_UNSUPPORTED`（Node 无内置 WebSocket）。

### 2.4 工具目录（grouped = 17）

| # | 工具名 | 覆盖能力 | 关键入参 | 说明 |
|---|---|---|---|---|
| 1 | `dsh_status` | GET /system/status | — | 连接快照 + 生效配置来源 + 工具面摘要 + degradedDependencies（**不含 token/完整 URL**） |
| 2 | `dsh_workspace` | workspaces 6 条 | `action:list\|get\|create\|rename\|delete\|sessions`, `id?`, `path?`, `title?` | 工作区一族 |
| 3 | `dsh_session` | sessions list/get/create/update/delete | `action`, `id?`, `workspaceId?`, `title?`, `provider?`, `model?` | 会话一族（**不触发回合**） |
| 4 | `dsh_session_history` | GET /sessions/:id/history | `id`, `maxMessages?≤200`, `throughSeq?`, `beforeSeq?` | 历史（文本化 + 可念） |
| 5 | `dsh_session_stats` | GET /sessions/:id/stats | `id` | 运行态/耗时/turn 数 |
| 6 | `dsh_session_todos` | GET /sessions/:id/todos | `id` | 待办 |
| 7 | `dsh_session_skills` | GET /sessions/:id/skills | `id`, `q?` | 会话可用技能 |
| 8 | `dsh_session_cancel` | POST /sessions/:id/cancel | `id` | 打断当前回合（"停下"） |
| 9 | `dsh_questions` | questions / answers | `action:list\|answer`, `id`, `answers?` | 反问桥（语音回答） |
| 10 | `dsh_ask` | prompt / prompt-stream / chat.completions | `prompt`, `sessionId?`, `waitMs?`, `mode?:'normal'\|'steer'`, `requestId?` | **核心**；无 `sessionId` 时走 chat/completions 一次性问答（**吸收 v1 的 `dsh_agent`**） |
| 11 | `dsh_task` | 会话历史 + agents 运行态 | `action:status\|result\|wait\|cancel`, `taskId`, `offset?`, `waitMs?≤10000` | 唯一续查通道；`wait` 做长轮询（≤10s，压住语音停顿） |
| 12 | `dsh_events` | GET /sessions/:id/events（降级） | `sessionId`, `sinceSeq?`, `limit?≤100` | 增量事件拉取 |
| 13 | `dsh_models` | models/providers/presets + models/default | `action:list\|providers\|presets\|default_get\|default_set`, `provider?`, `model?`, `reasoningEffort?` | 模型一族 |
| 14 | `dsh_settings` | GET /settings, PATCH /settings/:namespace | `action:get\|patch`, `namespace?`, `value?` | DSH 设置读写（`patch` 为 mutating，命名空间白名单） |
| 15 | `dsh_file` | files list/upload/download + fs 目录 | `action:list\|read\|upload\|deliver`, `sessionId`, `path?`, `name?`, `dest?` | 上传优先 `path`；`deliver` 回一次性签名链接；`read` 只回文本且截断 |
| 16 | `dsh_skill` | skills 7 条 | `action:list\|get\|create\|update\|delete\|archive`, `name`, `body?`, `root?` | 技能管理 |
| 17 | `dsh_help` | docs / openapi.json | `action:tools\|docs\|openapi\|groups\|endpoints`, `q?` | 自描述目录；`endpoints` 用关键词检索 51 条路由（**不整篇返回 openapi.json**） |

**组开关**：`system`、`session`（3-8）、`prompt`（10-12）、`question`、`model`、`settings`、`file`、`skill`、`docs`；`dsh_status`/`dsh_help`/`dsh_task` 为**强制组**（job 协议依赖）。

### 2.5 连接状态机（endpoint 角色，**按 ADR-101 重写**）与重连退避参数

```
disabled ─(配置出现 url)─→ idle ─→ connecting ─(101 + Accept 校验 ok)─→ open
                                                                        │
                                       (收到平台 initialize 请求)  ────────┤
                                                                        ↓
                                        replying  ─(已回 initialize result)─→ initialized
                                                                        │
                                          (已发 notifications/initialized)│
                                                                        ↓
                                        serving  ⇄ degraded      (工具面对外可用)
                                             │
                    (首次收到平台 tools/list 并成功应答后) → tools_published  ⇄ ready
                                             │
      ┌─────────── error / close / 看门狗判死 / 配额拒绝持续 ────────────┘
      ↓
   closing ─→ backoff ─(nextRetryAt)─→ connecting
      │
      └─(401/403 或 close 4401/4403 或 Accept 连续 3 次不匹配)─→ fatal ─(admin reconnect/rotate_token/配置变更)─→ idle
```

| 迁移 | 触发 | 动作 / 参数 |
|---|---|---|
| `idle→connecting` | 启动或配置变更 | 解析 URL；`connectTimeoutMs=10000`（内置 WebSocket 无独立握手超时，用 `open` 事件超时兜） |
| `connecting→open` | `open` 事件 | **不主动发 initialize**（H1）。`direction='initiate'` 时才发（H2） |
| `open→replying` | 收到 `initialize` 请求 | 回 `{protocolVersion:'2024-11-05', capabilities:{tools:{listChanged:true}}, serverInfo}`；`initializeWaitMs=0`（不设超时，平台可延迟初始化；仅记"open 但未初始化"指标） |
| `replying→initialized` | 回包已写出 | **主动发** `notifications/initialized`（对齐参考实现；若平台也发，忽略） |
| `initialized→serving` | — | 工具面可对外应答（`tools/list`/`tools/call` 均可）；启动保活看门狗 |
| `serving→tools_published` | 首次成功应答 `tools/list` | 记录平台分页次数/游标形状；此后允许 `list_changed` |
| `→degraded` | 写队列持续满 / 部分 DSH 依赖缺失 / `dsh_task` 读不到历史 | 保持读；UI 黄灯；短查询继续服务 |
| `→closing` | close 帧、socket error、看门狗判死 | 回 close（1000/1001），等对端 1s 后 `socket.close()` |
| `closing→backoff` | close 完成 | `attempt++`；`delay = min(60000, 1000 × 1.8^(attempt-1)) × jitter(0.7–1.3)`；写 `nextRetryAt` |
| `backoff→connecting` | `now ≥ nextRetryAt` | 重连**必须重跑全部握手**（MCP 会话无状态） |
| `ready` 持续 ≥60s | — | `attempt=0`（退避复位） |
| 任意→`fatal` | 401/403、close 4401/4403、Accept 连续 3 次不匹配 | **停止自动重连**；仅 admin `reconnect`/`rotate_token`/配置变更回 `idle` |
| 断线时 in-flight | — | 一律 `DSH_XZ_1012` 结束，**不回放**（靠 requestId/指纹幂等） |

**保活与看门狗参数（v1 的"WS ping"改为协议级）**

| 参数 | 默认 | 说明 |
|---|---|---|
| `keepalive.mode` | `'passive'` | `passive`=只依赖平台 ping + TCP 错误；`'active-rpc'`=我们周期性发 JSON-RPC `ping` 请求并等 `{}`（**探针 P-A 证实平台会回应后才打开**） |
| `keepalive.activePingIntervalMs` | 20000 | 仅 `active-rpc` 模式 |
| `keepalive.pingResponseTimeoutMs` | 10000 | 未回应 → 记 `unhealthy` |
| `keepalive.silenceDegradeMs` | 90000 | 静默超此值 → 进 `degraded`（**只降级，不断连**，避免误判平台静默） |
| `keepalive.deadAfterMs` | 180000 | 静默 + 写失败 → 判死 → `closing→backoff`（对齐参考实现 >2min 判死的量级） |
| `closeGraceMs` | 1000 | close 握手等待 |
| `staleFrameWindowMs` | 5000 | close 后残留帧一律丢弃并记日志（防把上一条连接的 tail 当新会话响应） |
| `maxMessageBytes` | 1 MiB | 超限：内置 WebSocket 走 `close` 后重连；自研 framing 回 close 1009 |
| `backoff` | base 1000 / factor 1.8 / max 60000 / jitter 0.7–1.3 / resetAfterReadyMs 60000 | 见上表 |

**并发参数**：`maxInFlightTools=4`、`perConnectionInFlight=2`、`queueDepth=16`、`queueWaitMs=5000`、`admissionTimeoutMs=5000`、`outQueueDepth=64`、`maxOutMessageBytes=256 KiB`、`maxCaptureBytes=8 MiB`、`server.maxConnections=8`。

### 2.6 配置字段与分层（对 v1 §2.7 的差异）

| 字段 | 层 | 默认 | env | 备注 |
|---|---|---|---|---|
| `mode` | base | `endpoint` | `DSH_XIAOZHI_MODE` | `both` 仅开发用 |
| `apiPrefix` | base | `/dsh-xiaozhi/api` | — | 复制层挂载点（**不与 `/api/v1` 冲突**；`register` 重复即 throw，需捕获转 `DSH_XZ_1015`） |
| `endpoint.url` | user | `''` | `DSH_XIAOZHI_ENDPOINT_URL` | 只回 host |
| `endpoint.token` | **user(secret)** | `''` | `DSH_XIAOZHI_ENDPOINT_TOKEN` | `role('secret')`；路径写（mutate）；**不落自建明文文件** |
| `protocol.direction` | base | `'serve'` | — | **ADR-101**：探针 P-A 的开关 |
| `keepalive.*` | base | 见 §2.5 | — | |
| `server.transports` | base | `['stream-http','ws']`（ws 默认 **off**） | — | ADR-103 |
| `server.path` / `standalonePort` | base | `/mcp/xiaozhi` / `0` | — | exact 路由 + upgrade 同路径 |
| `tools.face` | base（restartRequired） | `grouped` | — | ADR-110 |
| `tools.groups` | base（restartRequired） | 除 file/settings 外全 true | — | 按隐私默认收紧 file |
| `tools.flat.{include,maxTools}` | base | `[]` / `24` | — | **新增** |
| `tools.textLimit` / `waitMs` / `maxWaitMs` | user / user / base | 1200 / 15000 / 60000 | — | |
| `tasks.ttlMs` / `dedupeWindowMs` | user | 1800000 / 5000 | — | **新增**：指纹去重窗口 |
| `events.ringPerSession` / `ringSessions` | user | 200 / 64 | — | |
| `config.channel` | base | `auto`(`settings`→`file`) | — | **新增**（ADR-106） |
| `admin.enabled` / `admin.token` | user | `true` / `''` | — | standalone 场景必须显式配 |

### 2.7 最小测试集（v1 §2.8 + 3 项新增）

1. **等价性测试（守门人）**：51 条能力用同一 fixture 分别经真实临时端口与替身执行，断言 `status` + body 深相等（剔除 `timestamp`）；SSE 类断言事件序列相等。
2. **替身契约测试（新）**：`pipe()` 大文件 → 断言背压生效（`write()` 返回 false 后暂停）且超 `maxCaptureBytes` 走 `DSH_XZ_1009`；`signal.abort()` → 断言 `req 'close'` 触发且 SSE 订阅被释放（**监听器计数归零**）；`alsSessionId` 缺失时 prompt 类能力必须报明确错误而非挂起。
3. **协议方向测试（新）**：断言插件能**应答** `initialize`/`tools/list`(带 cursor)/`tools/call`/**`ping`（含无 `jsonrpc` 字段、字符串 id）**，且收到 `initialize` 回包后主动发 `notifications/initialized`；`direction='initiate'` 下断言相反路径；未知 method 请求 → `-32601` 且连接存活。
4. **幂等/去重测试（新）**：同 `requestId` 连发 3 次 → 只 1 次 `followup`；不同 `jsonrpc.id` 但同 prompt 在 5s 窗口内连发 3 次 → 只 1 次 `followup`，其余回 `DSH_XZ_1011`（`isError:false`）。
5. **自研 framing 黄金向量**（仅在启用 WS server 时）：RFC6455 §5.7 示例、掩码往返、126/127 长度、分片重组、控制帧穿插、close 1002/1007/1009。
6. **命名自检**：全部工具名匹配 `^[a-z0-9_-]{1,40}$`、归一后无重名、描述不含任何工具名；flat 冲突必须**失败**而非自动改名。
7. **admin 鉴权**：无/错 adminToken → 401；正确 → 200；`rotate_token` 后旧连接关闭且新连接使用新 token。
8. **重连/看门狗测试**：本地 stub 依次注入 close、静默、401 → 断言状态迁移与退避序列（401 → `fatal` 不再重连；静默 90s → `degraded` 而非断连）。
9. **schema 扁平化 lint**：`inputSchema` 不得出现 `$ref`/`$defs`/`oneOf`/`anyOf`；目录总字节告警阈值 64 KiB。
10. **共存测试（新）**：与参考插件同时安装时，断言我们的反问桥**不认领**非本插件 ALS 归属的提问（另一插件的 REST 提问仍由它自己答复）。

---

## 3. 风险清单与缓解

> ✅=沿用 v1 并复核成立；⬆=沿用但加强；🆕=本次新增。

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 ⬆ | **endpoint token 泄漏** | 他人可对这台 DSH 下发语音指令 | `role('secret')`（平台脱敏）+ 只回 `tokenConfigured` + `redact()` 兜底 + 工具目录不含 URL + README 写威胁模型 + 401 即 `fatal` |
| R2 ✅ | **平台 tools/call 超时未知** | 超时→LLM 重试→重复执行 | 两段式 + `isError:false` 的"进行中" + requestId 幂等 + **内容指纹去重（新增）** + 描述写明"超时先 `dsh_task`" |
| R3 ✅ | **工具过多 → LLM 选错** | 答非所问 | grouped 17 + 组开关 + flat 白名单/上限 + `dsh_help` 自查 |
| R4 ✅ | **平台 tool 名清洗** | 调用落到不存在工具 | 只用 `[a-z0-9_-]`、前缀、启动自检、描述禁引用工具名、预览页展示"平台看到的最终名字" |
| R5 ⬆ | **替身与真实 HTTP 语义偏差** | 两面行为不一致；**OOM/挂起** | 结构接口编译期约束 + **Writable/drain 背压 + maxCaptureBytes + signal→destroy**（新增）+ 等价性测试进 CI |
| R6 ✅ | **多客户端并发** | 打满 DSH；同会话抢占；幂等碰撞 | 三级限流 + `maxConnections=8` + `SESSION_BUSY` + 键含 connectionId + 共享环形缓冲 |
| R7 ✅ | **平台 schema 兼容** | 参数被拒/截断 | 扁平 JSON Schema 子集 + lint + 描述限长 + 目录总字节告警 |
| R8 🆕 | **管理面/能力面在 LAN 暴露**（`webServer` 绑 `0.0.0.0`） | 局域网可改配置、读历史与日志 | adminToken（只进同源 HTML）+ 能力面默认仅 loopback 或需 apiKey + standalone 默认关 admin |
| R9 ✅ | **复制层版本漂移** | 跟上游更新冲突 | `README-COPY.md` 逐文件改动清单 + 改动收敛为三类 + 等价性测试 |
| R10 ⬆ | **配置"改了不生效"** | 用户困惑、反复改 | 平台 `base`/`user` 分层 + 每字段 `{effective,source,locked}` + `explain_config` + **`configure({auto:false})` 消除双入口** |
| R11 ✅ | **事件环形缓冲内存** | 长期运行内存增长 | 只缓存有语义事件（丢 `assistant/chunk` 逐 token），每会话 200 条 + LRU 64 + 单条 8 KiB 截断 |
| R12 ✅ | **图片/语音附件语义未知** | 能力误用或静默失败 | 只接受本地 `path` 或 ≤1 MiB base64；README 说明语音链路不做图像输入 |
| R13 🆕 | **复制层反问桥抢占**（与参考插件/浏览器共存时，`prepend` + agent 兜底会把别人的提问认领进我们的 pending，导致**对方集成永久挂起**；证据 `user-questions.ts:80/81/139` 的 `prepend:true` 与 agent 反查分支） | 另一集成静默死锁，极难定位 | 只认领**自己 ALS** 的会话（删 agent 兜底）；注册改 `prepend:false`；配置 `answerBridge:'own-only'`（默认）；`status` 暴露"检测到第二个答复桥" |
| R14 🆕 | **内置 WebSocket 的行为依赖**（Node ≥21；无 ping 观测；`{headers}` 为非标准扩展；代理需配全局 dispatcher） | 在旧 Node 上直接不可用；半开检测变弱 | 运行期特性探针 + `engines` 声明 + `TRANSPORT_UNSUPPORTED` 明确报错 + 探测与静默看门狗组合 + README 写代理配置 |
| R15 🆕 | **flat 工具名随上游路径漂移** | 程序化调用者指向错误端点 | flat 标注"可能重命名"；grouped 17 个名字冻结为兼容契约；重命名走 minor + list_changed |
| R16 🆕 | **协议方向猜错**（ADR-101） | 握手失败、工具面无法发布 | 对称派发器 + `protocol.direction` 开关 + 探针 P-A 前置 |
| R17 🆕 | **`ctx.fiber.entry` 为非公开成员**（用于 settings namespace 解析） | DSH 升级后配置通道失效 | schema 同一性匹配回退 + sidecar 最终回退 + 探针 P-B + 单测覆盖三条解析路径 |
| R18 🆕 | **出境数据面被低估**（prompt 全文、工具返回、工具目录、路径参数全部经平台） | 隐私/合规 | README 写清出境清单；file 组默认关；`path` 出境显式告知；工具返回默认脱敏摘要而非原文堆 |

---

## 4. 最可能出错 / 最需改的 3 个点及替代设计

### P1（最高）——**协议消息方向猜错：v1 的状态机是一个自相矛盾的混合体**

**为什么最可能出错**
v1 §2.6 让插件"发 `initialize` → 收 result → 发 `tools/list` → 记录平台工具数"，同时在 §2.4 声明"工具是我们注册的、被平台调用"。**这两件事不能同时为真**（发 `tools/list` 的一方是 client，client 不提供工具）。而参考工程在"连出"的同一 socket 上，**只应答** `initialize`/`tools/list`/`tools/call` 并**主动发** `notifications/initialized`（`WebSocketMCP.cpp:199-252`）——即"物理连出、协议上做 server"。这一处判错不是局部返工，而是**整个 endpoint 链路的握手、状态机、测试项三处全废**，且线上表现为"连上了但工具列表是空的 / 平台说没有可用工具"，非常难归因。

**替代设计（建议采纳）**
1. **先跑探针 P-A**（§0.2）：哑 token 连上，双向原始帧打 60s 日志。这一步的产出直接写进 ADR-101 的"已实测"栏。
2. **实现对称派发器**：`handleIncoming` 只看 `method` 与"是否为响应帧"，不假设角色；`initialize`/`tools/list`/`tools/call`/`ping` 一律当"可被请求的方法"实现，响应帧交给 pending 表。成本≈30 行，换来"两种假设都能跑"。
3. **`protocol.direction: 'serve' | 'initiate'`** 作为唯一开关；默认 `serve`（对齐参考实现）。
4. **只声明我们真有的能力**：不发 `roots`/`sampling`/`elicitation`（v1 建议发 `sampling:{}`，等于承诺实现 `sampling/createMessage`）。
5. **兼容参考实现的怪癖**：回完 `initialize` 后**主动发** `notifications/initialized`，同时**容忍**收到对端同款通知（标准角色下是平台发，非标准下是我们发；两边都容忍即无脑兼容）。
6. 状态机按 §2.5 重画：`open → replying → initialized → serving ⇄ tools_published`，`syncing` 这个"我去取平台工具"的语义彻底删除。

---

### P2——**替身的"流式响应 + ALS"契约缺失（v1 的 P1 精确化到会 OOM 的那一处）**

**为什么最可能出错**
v1 抓对了大方向（结构化接口替代伪造类实例），但把风险描述为"订阅泄漏"，漏掉了**更早爆的那颗**：
- 三个下载路由用 `createReadStream().pipe(res)`（`files.ts:224`、`fs.ts:165`、`skills.ts:132`）。`pipe()` 依据 `dest.write()` 的返回值做背压、靠 `'drain'` 恢复。v1 的 `RouteResponse.write(): boolean` 若恒 `true` → **整个文件堆进捕获缓冲 → OOM**；若恒 `false` 又不发 `'drain'` → **永久挂起**。这类 bug 在联调（小文件）时永不出现。
- **ALS 不是可选细节**：`streaming.ts` 用 `askSessionStorage.run({sessionId}, …)` 让反问桥认领归属（`streaming.ts:22/213/409`；桥侧读取见 `user-questions.ts:80`）。替身若不携带会话上下文，`ask_user_question` 会**永久挂起**（这正是参考实现注释里写的失败模式："没有浏览器 → 工具直接报错，问题永远得不到回答"）。
- **共存缺陷**：`user-questions.ts` 以 `{global:true, prepend:true}` 注册 waterfall，并在 ALS 缺失时用 `request.agent` 反查归属（`user-questions.ts:80/81/139`）。若参考插件同时在装，我们的桥会把**它的**提问认领进**我们的** pending 表——只有 MCP 客户端能答复，于是对方集成永久挂起（反之亦然）。

**替代设计（建议采纳）**
1. `RouteResponse` 落实为真 `Writable`（或 `PassThrough`）；`createDoubles` 带 `maxCaptureBytes`（默认 8 MiB）与 `signal` → `req.destroy()`。
2. `invoke()` 的 `DoublesOptions` 显式带 `alsSessionId`；prompt/chat 类能力**必须**在 `askSessionStorage.run` 内执行，否则直接报 `INVESTIGATE`（明确错误，不挂起）。
3. `dispose()` 走 `req.destroy()` 让 `'close'` 必然触发，**并在测试中断言监听器计数归零**（把"泄漏"变成可测断言，而不是靠长时间运行观察）。
4. 复制层 `user-questions.ts` **必须改**（不许原样拷）：只认领自己 ALS 的会话、去掉 agent 兜底、注册改 `prepend:false`、配置 `answerBridge:'own-only'`（默认）。
5. 等价性测试 + 契约测试（§2.7.1–2.7.2）进 CI 门禁；**没有这两组测试就不允许加新的复制路由**。
6. 更进一步的收敛（可选）：把 `dsh_ask`/`dsh_task`/`dsh_events` 这三条**长任务/SSE 语义最重**的工具改为直接调用 `turn-waiter` + `events-ring` + `ctx` 服务（不走替身），把替身偏差的危险面限制在 CRUD 类能力上。代价是出现两条执行路径（与 ADR-104 的"唯一路径"原则冲突），因此**只在契约测试无法覆盖某个语义时才启用，并登记例外清单**。

---

### P3——**长任务闭环仍缺两环：平台重试去重 + 取消/停下的可达性**

**为什么最可能出错**
v1 的两段式方向正确，但闭环差两环：
1. **去重只挂在 `requestId` 上**。语音平台重发同一条指令时，`jsonrpc.id` 很可能变，`requestId` 也未必传（它是我们发明的参数，平台不会替用户填）。于是"平台超时 → LLM 重发"仍会**打第二次 `followup`**——在"让小智改代码"的场景里这是破坏性的（重复执行、重复改文件）。
2. **"停下"不可达**：用户说"别弄了"时，链路是 `tools/call` → 平台超时/取消 → 我们并不知道该取消什么。`notifications/cancelled` 是否下发未证实；若不发，则只能靠用户显式说"取消任务 N"，而语音用户不会记得 taskId。

**替代设计（建议采纳）**
1. **双层幂等**：`(connectionId, requestId ?? jsonrpc.id)` + **内容指纹**（`hash(sessionId + prompt + 5s 窗口)`）；命中返回 `DSH_XZ_1011`（`isError:false`，文本明说"上一次同样的请求还在处理中"），**绝不二次提交**。
2. **taskId 编码化**：`taskId = base64url(sessionId#turnSeq)`，**真相源是 DSH 会话历史**，环形缓冲只做快路径。好处：插件重启后 taskId 仍可读、多客户端天然共享、内存状态不再是唯一副本。
3. **`dsh_task` 增加 `action:'wait'`（长轮询 ≤10s）**：把"两段式"在体验上压回"一问一答"，同时不碰平台超时。响应式地，"还在跑"的回答从"你再问一次"变成"（停 8 秒后）好了，是这些…"。
4. **取消可达**：`dsh_task{action:'cancel'}` → `POST /sessions/:id/cancel`；同时实现 `notifications/cancelled` 处理；**再加"最近任务"语义**：`dsh_task{action:'cancel'}` 允许不传 `taskId`（默认取消该会话最近一个 in-flight 任务），让"停下"这种极短的语音指令可用。
5. **`dsh_ask` 的返回文本永远回显 taskId 的自然语言形式**（"任务号 12"），并写进描述："用户说'停下'时用 `dsh_task` 取消最近的任务"。
6. 保留 v1 的 best-effort 进度推送（若平台支持 `_meta.progressToken`），但**架构上不依赖它**。

---

## 附：本次评审未覆盖 / 需用户确认的 3 件事

1. **约束①的 `inject=['webServer']` 建议改为 `inject=[]` + `ctx.inject(['webServer'], cb)`**（ADR-111，已实测 Cordis 无语义 optional）。若坚持原约束，则纯 headless 组合下 endpoint 角色不可用——需用户确认哪个是真实意图。
2. **约束③的 `/mcp/xiaozhi` 用 `registerUpgrade`**：建议按约束**保留该路径与实现位置**，但默认关闭并把主传输设为 streamable-HTTP（ADR-103）；若用户已确认平台会 WS 连出，则把 `ws` 打开、并把自研 framing 提到主线。
3. **协议方向（ADR-101）与设置页配置通道（ADR-106/112）**：前者取决于探针 P-A，后者取决于探针 P-B；两者都是"猜错就返工"的点，建议先跑探针再进实现。
