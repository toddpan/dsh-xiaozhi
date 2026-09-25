# dsh-xiaozhi 架构决策记录（ADR）与模块/接口规格

> 范围：架构层。不含实现代码。
> 已依据的事实来源：`dsh-web-service` 源码（路由注册表、router/streaming/sessions 内部实现、package.json 与 cordis.patch.yml）、`@deepseek-ai/dsh-host-webserver` 类型声明（`register` / `registerUpgrade` / `tapIndex` / `webserver/index-inject`）、`@deepseek-ai/cordis` 的 `Inject` 类型、`xiaozhi-esp32-mcp`（PING_INTERVAL=10s、DISCONNECT_TIMEOUT=60s、backoff 1s→60s）、`dsh-prompt-enhancer` 的客户端 slot 与 `$DSH_HOME` 口径。
> 小智平台侧行为（tools/call 超时值、是否支持 progress notification、streamable-HTTP 客户端细节）标记为**待实测**，规格中已给出兼容分支。

---

## 0. 结论先行

1. **角色**：单进程双角色成立，但 `mode` 建议扩为 `endpoint | server | both`（默认 `endpoint`）；两个角色做成独立 adapter，共享「能力表 + 工具目录 + 调用层」。
2. **server 角色的传输必须改**：平台已被证实能以 MCP client 连出到第三方 server（SSE / streamable-http），**未经证实支持 WS 连出**。server 角色主传输应为 **streamable-HTTP**（复用 `ctx.webServer.register({kind:'exact'})`），WS upgrade 降级为实验开关。这同时把自研 RFC6455 的面积收缩到「仅客户端」。
3. **不要伪造 Node 的 `IncomingMessage`/`ServerResponse` 类实例**：把复制来的路由层 handler 签名换成结构化接口 `RouteRequest`/`RouteResponse`，再写两个适配器（真实 HTTP / 进程内替身）。替身用 `Readable` 子类，靠 `destroy()` 天然产出 `close` 事件，避免订阅泄漏。
4. **加一层能力表（Capability Registry）作为单一事实源**：`cap()` 在注册 REST 路由的同时登记能力元数据；REST 面与 MCP 工具目录（含 flat 模式）都从它派生，杜绝两套面漂移。
5. **SSE 三件套降级为「可拉取」语义**：全局事件环形缓冲 + `dsh_events(sinceSeq)`；`prompt-stream` → `dsh_ask` 两段式（短等待 + `taskId` 续查）；二进制下载不映射为文本。
6. **长任务与超时是一号风险**：默认「提交即返回 + 短等待 + 幂等 requestId + 轮询」，禁止 DSH 侧自动重试，避免平台重试导致重复 prompt。
7. **配置持久化**：`$DSH_PROFILE_DIR/dsh-xiaozhi/config.json`（回退 `$DSH_HOME/dsh-xiaozhi/config.json`），字段按 `scope: deploy|user` 分层，`cordis.patch.yml` 只承载部署意图，插件**永不改写 patch 文件**。
8. **`webServer` 的可选性要用 `ctx.inject(['webServer'], cb)` 表达**，不能写进顶层 `inject`——Cordis 的 `Inject` 对象形式是「服务名 → intercept config」，**没有 required/optional 语义**，数组与对象形式都表示必需。

---

## 1. ADR 列表

### ADR-001 角色模型：双角色（mode 三值）

**状态**：提议中

**决策**
保留 `config.mode`，取值扩为 `endpoint`（默认）| `server` | `both`。代码结构上两个角色是**平级 adapter**，不是 if/else 分支：

```
EndpointLink (client) ─┐
                       ├─→ ToolCatalog ─→ CapabilityRegistry ─→ api/*（复制层）─→ ctx services
ServerLink   (server) ─┘        ↑
                          invoke/ 替身执行
```

`mode` 只决定「挂载哪些 adapter」。

**备选**
| 方案 | 优 | 劣 |
|---|---|---|
| (a) 只做 endpoint | 工作量最小，语音主场景够用 | 失去「小智连过来」的能力；无法用平台自带调试面板 |
| (b) `mode` 仅二值 | 配置心智最简单 | 本地联调/双通道必须重启切换 |
| (c) 拆成两个插件包 | 依赖隔离最好 | 两套 bundle/patch/设置页，能力层重复，违背「拷贝参考插件在其上改」 |

**理由**
`both` 的真实场景是联调（一边连平台验证语音，一边让平台连本地看 tools/list）。两个 adapter 已经是独立模块，多一个枚举值的边际成本接近零，而「不支持同时」会直接引出「再加一个 mode」的返工。

**代价**
`both` 下两条链路共享同一 ToolCatalog 与 submissionRegistry，必须禁止同一逻辑请求被双通道重复计入并发预算；文档要写明 `both` 只建议开发期使用；`server` 的路径/端口与 `endpoint` 的 token 属不同配置域，UI 需分区展示。

---

### ADR-002 server 角色传输：streamable-HTTP 为主，WS upgrade 为次

**状态**：提议中（**建议覆盖原约束③的 server 部分**）

**决策**
`server.transports: ('stream-http' | 'ws')[]`，默认 `['stream-http']`。

- `stream-http`（主）：`ctx.webServer.register({ kind:'exact', path: server.path })`，一个 handler 内按 `req.method` 分派：`POST`（JSON-RPC 请求，`Accept: application/json` 时直接回 JSON，含 `application/json, text/event-stream` 时回 SSE 单帧）、`GET`（SSE 长连接通道，可选）、`DELETE`（结束 session）。会话用 `Mcp-Session-Id` 头，缺失时降级为**无状态模式**（每次请求独立处理，initialize 结果不缓存）。
- `ws`（次/实验）：`ctx.webServer.registerUpgrade({ path: server.path, handler })`，与 `stream-http` 同路径可共存（HTTP 路由表与 upgrade 表是两张表）。
- `server.standalonePort > 0` 时另起 `node:http` server（与 `dsh-web-service` 同款做法），供反向代理直接暴露。

**备选**
| 方案 | 优 | 劣 |
|---|---|---|
| (a) 只做 WS upgrade（原约束） | 与 endpoint 共用帧编解码 | 平台是否支持 WS 连出**未知**；若不支持则整个 server 角色不可用；需自研 upgrade 握手 + 帧编解码 |
| (b) 只做老式 HTTP+SSE（2024-11-05 的 `GET /sse` + `POST /messages?sessionId=`） | 协议简单，历史实现多 | 与「streamable-http」是两套；平台到底用哪套未实测 → 建议两者都挂在同一路径的不同子路由上 |
| (c) 只做独立端口 HTTP | 反向代理简单 | 与 DSH 主站不同源，设置页/鉴权要多一套 |

**理由**
功能可用性优先于代码量：server 角色的目的是「小智主控台能连上我们」，而平台对第三方 MCP server 的支持形式已明确是 SSE / streamable-http。HTTP 传输直接把「帧编解码 + 掩码 + 分片 + 控制帧」这一整块风险从 server 角色移除（body 由 `node:http` 解析好），并且天然复用 DSH 的 webServer、鉴权、CSP、反代配置。

**代价**
需要实现 `Mcp-Session-Id` 生命周期与 SSE 单帧/多帧两种响应形态；三套传输（stream-http / legacy-sse / ws）若全开有维护成本 → 用统一的 `ServerTransport` 接口收敛为「收消息 / 发消息 / 关闭」，每个传输只做编解码。**上线前必须实测平台客户端实际发的 `Accept` 与是否需要 `Mcp-Session-Id`**，因此规格里两个分支都要可运行。

---

### ADR-003 能力执行：能力表单一事实源 + 结构化替身

**状态**：提议中

**决策**
三点：

1. **改签名，不伪造类实例。** 复制来的 `router.ts` 及各路由模块，把 handler 签名从
   `(req: IncomingMessage, res: ServerResponse, params, query, body) => …`
   改为结构化接口
   ```ts
   interface RouteRequest extends Readable {   // 只声明原代码真正用到的成员
     method?: string; url?: string; headers: Record<string, string | string[] | undefined>
   }
   interface RouteResponse {
     statusCode: number; headersSent: boolean; writableEnded: boolean
     setHeader(n: string, v: string | number | string[]): void
     getHeader(n: string): unknown
     write(chunk: string | Buffer): boolean
     end(chunk?: string | Buffer): void
     flushHeaders?(): void
   }
   ```
   两个适配器：`fromNodeHttp(req, res)`（真实流量，零成本包装）与 `createDoubles({ method, url, headers, body })`（进程内）。
2. **能力表。** 新增 `capability/registry.ts`，`cap(router, spec, handler)` 一次调用完成「注册路由 + 登记能力」：
   ```ts
   cap(router, { id:'sessions.history', method:'GET', path:'/sessions/:id/history',
                 summary:'读取会话历史', inputSchema, mutating:false, longRunning:false,
                 group:'session', mcp:{ tool:'dsh_session_history', expose:true } }, handler)
   ```
   REST 面与 MCP 工具目录（含 flat 派生）都从这里生成。
3. **MCP 侧调用**走 `invoke(capabilityId, args, opts)` → 组装替身 → 执行同一份 handler → 收集 `statusCode + headers + body`，`trusted: true` 跳过 API key 校验（进程内调用没有 `Authorization` 头，若沿用真实中间件会被 401）。

**备选**
| 方案 | 优 | 劣 |
|---|---|---|
| (a) 环回 HTTP `fetch('http://127.0.0.1:'+port+prefix+path)` | 语义 100% 真实 | 依赖 webServer 在跑（endpoint 模式在无 webServer 组合下直接失效）；端口发现/自注入 apiKey/大 body/超时；`localhost` 在双栈机器可能解析到 `::1` 而服务只监听 `127.0.0.1`（经典失败）；每次调用真实往返 |
| (b) 绕过 REST 直接调 `ctx.get('sessionController')` 等 | 无中间层，性能最好 | 等于重写 ~51 条路由的参数映射；技能目录解析、历史 cursor、差量补推、统计推断等已验证细节必然漂移；两套面长期分叉 |
| (c) 原样伪造 `new IncomingMessage(socket)` / `new ServerResponse(req)` | 复用现有类型 | `OutgoingMessage` 无 socket 时的写行为未文档化（依赖 Node 内部实现）；类型上也要 `as any` 硬转；升级 Node 有踩雷风险 |

**理由**
(a) 的失败模式是「运行环境相关、难以复现」，对一个要靠语音长期无人值守运行的插件不可接受；(b) 会让本次「拷贝参考插件」的收益归零；(c) 是把不确定性藏进类型断言。结构化接口方案让替身成为**契约的一部分**：handler 只用接口成员，替身与真实适配器都必须满足它，编译器保证不漂移。

**代价**
需要逐个文件小改复制来的代码（类型注解 + `cap()` 登记），并承担一条硬性测试义务：**等价性测试**——对每个能力用同一份参数 fixture 分别经（真实 `node:http` 临时端口）与（MCP 替身）执行，断言 `status` 与响应体深相等（剔除 `timestamp`），SSE 类断言事件序列相等。约 51 条能力的回归用例表。

---

### ADR-004 模块划分与依赖方向

**状态**：提议中

**决策**
单向分层，禁止反向 import：

```
index ─┬─→ config ──────────────────────────────┐
       ├─→ admin ──→ capability ──→ api ──→ ctx services（DSH）
       ├─→ transport ──→ mcp ──→ capability     │
       └─→ mcp（tool catalog）                  │
                                        （config 可被所有层读，不反向依赖）
```

硬规则：
- `transport/*` 不 import `api/*`，只认 `mcp/*` 与 `capability/invoke`；
- `api/*` 不 import `mcp/*`（它只是「被复制的 DSH 能力层」）；
- `capability/invoke` 是唯一同时知道「能力表」和「替身」的模块；
- `api/*` 内不得出现任何 `fetch`/socket（保持可被替身执行）。

**备选**
- 扁平结构（index 直接 require 所有模块）：改动快，但「MCP → DSH」的耦合方向失控，三个月后无法替换 REST 层。
- 能力层放在 `api/*` 内部：会导致 `api/*` 依赖 MCP 元数据（如 `mcp.tool`），破坏「REST 层可整体跟随上游更新」的目标。

**理由**
本插件最大的长期成本是「参考插件的 REST 层会继续版本漂移」。把 `api/*` 做成**不认识 MCP** 的一层，未来用 `git merge`/目录覆盖方式跟上游更新时，冲突面只在 `cap()` 登记处。

**代价**
多一层间接；新增能力要同时写 route + 元数据 → 用单次 `cap()` 调用消除漏登记（并提供启动期自检：所有 route 必须有对应能力条目，否则启动日志告警并进 `/admin/status.orphanRoutes`）。

---

### ADR-005 配置分层与持久化位置

**状态**：提议中

**决策**

**位置**：`$DSH_PROFILE_DIR/dsh-xiaozhi/config.json`；`DSH_PROFILE_DIR` 未设置时回退 `$DSH_HOME/dsh-xiaozhi/config.json`；`DSH_HOME` 也未设置再回退 `~/.dsh/dsh-xiaozhi/config.json`。写入方式：`tmp + rename` 原子替换，文件权限 `0o600`，JSON 内含 `{"version":1,"updatedAt":…,"values":{…}}`。

**分层与优先级**（每个字段在 schema 上标注 `scope`）：

| scope | 含义 | 生效优先级 |
|---|---|---|
| `deploy` | 部署结构（mode / 路径 / 端口 / 工具编织 / 并发上限） | **patch 行 config（显式给出时）** > 文件 > 内置默认；UI 只读并标注 source |
| `user` | 运行期可调（endpoint.url / endpoint.token / waitMs / 缓冲大小） | **文件** > patch 行 config > 内置默认 |
| 任意 | 环境变量覆盖（最高优先级、只读） | `DSH_XIAOZHI_*` > 以上全部 |

**与 `dsh.patch.yml` 的关系**：patch 是「部署意图」层，插件**只读、永不改写**（改 patch 需要重启与人工编辑，这是有意的摩擦）；可写状态只落 `config.json`。`/admin/config` 的响应必须逐字段返回 `{effective, source: 'env'|'file'|'patch'|'default', locked: boolean}`，让设置页能解释「为什么我改了没生效」。

**备选**
| 方案 | 优 | 劣 |
|---|---|---|
| (a) 只放 patch config | 单一来源 | 设置页无法保存，功能不存在 |
| (b) 用 DSH 的 `settingsController` 存储 | 与 DSH 设置体系统一 | 耦合 DSH 内部 schema；endpoint token 属插件私有密钥，进全局设置键空间不合适 |
| (c) `$DSH_HOME/dsh-xiaozhi.json` 全局单文件 | 路径最简单 | 多 profile 抢写、token 串扰；profile 是 DSH 安装与配置的自然边界 |
| (d) 写进插件安装目录 `$DSH_PROFILE_DIR/node_modules/…` | 与代码同处 | 升级/重装被覆盖，npm 目录不宜做数据目录 |

**理由**
`$DSH_PROFILE_DIR/node_modules/dsh-xiaozhi` 就是本插件的安装位，profile 目录天然拥有「这个插件实例」；把 sidecar 数据放在同一 profile 下，多 profile 并存时互不串扰，同时 `$DSH_HOME` 回退保证无 profile 启动（Electron / 直接 `dsh`）也能持久化。

**代价**
两处路径解析 + 一个回退分支需覆盖测试；`deploy` 类字段「UI 改不动」需要 UI 明确标注，否则用户会反复尝试；token 明文落盘（0600），威胁模型（同机同用户可读）必须写进 README。

---

### ADR-006 WebSocket 自研（范围钉死）

**状态**：已接受（受「仅 Node 内置依赖」约束）

**决策**
自研 RFC6455，但把支持面钉死：

- **只在 client 角色使用**（server 角色的 WS 是可选实验项，见 ADR-002）。
- 传输层：`wss:` → `node:tls`，`ws:` → `node:net`；`handshakeTimeoutMs=10000`；`rejectUnauthorized` 默认 `true`（`endpoint.allowInsecureTls` 才关）。
- 不支持 permessage-deflate（不发 `Sec-WebSocket-Extensions`）；不发子协议（`endpoint.subprotocol` 显式配置才发）。
- 只处理文本消息（opcode 1 / 0 续帧）；收到 opcode 2 → close 1003。
- 校验：`RSV1..3 == 0` 否则 close 1002；控制帧必须 `FIN=1` 且 payload ≤ 125；客户端发出的帧必须掩码，服务端发来的帧必须未掩码；`Sec-WebSocket-Accept == base64(sha1(key + 258EAFA5-E914-47DA-95CA-C5AB0DC85B11))`。
- 上限：单消息 `maxMessageBytes=1 MiB`（超限 close 1009）；分片累计上限同上；文本帧 UTF-8 非法 → close 1007。
- 保活：每 `pingIntervalMs=10000` 发 WS ping；`livenessTimeoutMs=45000` 内未收到任何帧 → 主动 close 并重连（对齐参考实现的 10s/60s 量级）。
- 关闭握手：收到 close → 回 close 并等对端或 1s 超时后 `socket.destroy()`。
- **关闭后必须留 5s 的「重放窗口保护」**：`close` 之后到达的残留帧一律丢弃并记日志（防止把上一条连接的 tail 当成新会话的响应）。

**备选**
| 方案 | 优 | 劣 |
|---|---|---|
| (a) `ws` 包 | 成熟、10 年打磨 | 违反「仅 Node 内置依赖」约束；引入 bundle peer 依赖与版本矩阵 |
| (b) Node 内置 `WebSocket` 全局 | 零依赖、零代码 | **仅客户端**，无法包装已被 `registerUpgrade` 升级的 socket；无法做服务端；无 ping/退避控制 |
| (c) `undici` 的 WebSocket | 内置依赖 | 同上，仅客户端，且不能拿到底层 socket 做自定义保活 |

**理由**
(a) 被约束排除；(b)(c) 都解决不了「服务端 + 精细保活」的需求——而这两点正是 endpoint 角色最需要的（长连、平台静默、需主动探测）。自研的代价可控在于**范围极窄**（无压缩、无二进制、无扩展、单帧上限 1 MiB）。

**代价**
约 350–450 行协议代码 + 必须有的黄金向量测试（RFC6455 §5.7 示例帧、掩码往返、分片重组、控制帧穿插、126/127 长度分支、close code 语义），以及 `Sec-WebSocket-Accept` 计算与 HTTP 升级响应解析的逐字节健壮性（不得依赖 `node:http` 解析一个已经 upgrade 的 socket）。**这块代码必须写单测，不能只靠联调。**

---

### ADR-007 SSE 类能力在 MCP 上的语义降级

**状态**：提议中

**决策** 三层降级：

1. **事件从「推送」变「可拉取」。** 插件内常驻**一个**全局监听器 `ctx.on('session/event', …)`（不是每个调用订阅一次），写入有界环形缓冲 `Map<sessionId, RingBuffer<EventRecord>>`（默认 200 条/会话，LRU 64 会话，可配）。MCP 侧暴露
   `dsh_events{sessionId, sinceSeq?, limit?≤100}` → 返回 `{events:[{seq,type,data,time}], nextSeq, truncated}`。
   HTTP 面 `GET /sessions/:id/events` 保持原 SSE 形态不变（它被真实浏览器/三方客户端用）。
2. **`prompt-stream` → 两段式 `dsh_ask`。**
   - 阶段一：`submissionRegistry` 记录 `requestId → {sessionId, submittedAtSeq, turnId?}`，订阅在**提交之前**建立，忽略 `seq <= submittedAtSeq` 的事件（复用参考实现里已修正的 `ownTurn` 语义，抽成共享模块 `api/turn-waiter.ts`，SSE 路由与 MCP 工具共用一份）。
   - 等待窗口 `waitMs`（默认 15000，上限 `maxWaitMs` 60000，绝不等于「等到结束」）。
   - 阶段二：窗口内拿到本回合 `turn/end` → 返回最终文本 + `usage` + `taskId(已完成)`；超窗 → 返回 `[DSH_XZ_1005] TIMEOUT_PARTIAL` + 已累积的部分文本 + `taskId`，`isError:false`（**语义是「还在跑」，不是「失败」**）。
   - `dsh_task{action:'status'|'result'|'cancel', taskId}` 续查/取消；`status` 读 agents 运行态（参考实现已有 `liveRunningState`），`result` 取环形缓冲里该回合的最终文本。
3. **二进制/下载类不映射为文本。** `files/download`、`skills/:name/archive`、`fs/download` 三者在 MCP 面统一返回元数据：`{path, bytes, mime, sha256, hint:'语音无法播报文件，请在 DSH Web 端查看'}`，并把 `capability` 标为 `mcp.expose:'metadata-only'`。上传类接受 `path`（同宿主本地文件，推荐）或 `base64`（≤1 MiB，避免 JSON 膨胀）。

**备选**
| 方案 | 优 | 劣 |
|---|---|---|
| (a) 依赖 MCP progress notification / `notifications/message` 推送进度 | 体验最好 | 平台是否支持未知；`tools/call` 本质是请求-响应；语音助手没有「异步播报」通道，进度发出去也无人念 |
| (b) 单一阻塞式 `ask`（等 60–180s） | 实现最简，体验「一问一答」 | 平台 tools/call 超时值未知且大概率远小于一个真实编码回合 → 平台超时、LLM 重试、用户重复提交；且超时后我们无法取消已提交的 DSH 回合 |
| (c) 用 MCP sampling 把 DSH 的 `user_questions` 反问转成语音采样 | 理论上能实现「反问用户」 | 平台 sampling 支持程度未知；把协作式反问塞进语音往返链路，语义与超时都不可控 |

**理由**
语音交互的可用性上限是「人能等多久」。降级后**每次工具调用都 ≤ 20s 且可幂等重试**，这是唯一能同时满足「平台超时未知」「用户不会等待」「DSH 回合可能跑 10 分钟」三个约束的形状。

**代价**
需要 taskId 生命周期管理（TTL 30min，按会话与 requestId 双索引）；长任务体验退化为「小智说还在处理，稍后再问一次」；必须给出**语音友好截断**策略（默认 1200 字符，保留答案尾部 + 明确提示「已截断，可让我读下一段」，用 `dsh_task{action:'result', offset}` 续读）。

---

### ADR-008 并发与背压

**状态**：提议中

**决策**
- **读取循环绝不 await 业务**：WS/HTTP 收帧 → 解析 → 入队 → 立刻回到读。所有 handler 在 `ToolCallQueue` 里执行。
- **三级限流**：全局 `maxInFlightTools=4`、单连接 `perConnectionInFlight=2`、队列 `queueDepth=16`；队列满或排队超过 `queueWaitMs=5000` → 立即返回 `isError:true` + `[DSH_XZ_1010] BUSY`（不静默丢弃）。
- **超时预算严格分离**：`admissionTimeoutMs=5000`（把消息交给 agent：`resolveAgent` + `followup`）与 `waitMs` 分开；`waitMs` 到点返回部分结果而非抛错。
- **幂等**：`(connectionId, arguments.requestId ?? jsonrpc.id)` 为 key 建 `submissionRegistry`；同 key 重复到达 → 返回既有 task 状态，**绝不二次 `followup`**（这是防「平台重试 → 重复跑一整轮」的唯一手段）。
- **会话互斥**：同一 session 已有 in-flight ask 时，第二次 `dsh_ask` 默认返回 `[DSH_XZ_1004] SESSION_BUSY`；显式 `mode:'steer'` 才允许插话（对应 `agent.steer`）。
- **断线收敛**：非 `ready` 状态下的 in-flight 调用一律以 `[DSH_XZ_1012] CONNECTION_LOST` 结束并**不回放**；DSH 侧的回合继续跑，结果留在环形缓冲里，重连后可用 `dsh_task` 取回。
- **多客户端**：每连接独立队列/计数器，共享 `submissionRegistry` 与环形缓冲；server 角色 `maxConnections=8`（超出回 503）。

**备选**
- 无限并发：一个语音助手连发三条指令就能把 DSH 打满（每个 session 回合都很贵）。
- 全串行（1 并发）：简单，但「查状态」这类毫秒级工具会被长任务堵死，语音体验明显变差。
- 引入进程内 job 队列 + worker：DSH 本身已有会话级串行语义，再加一层队列只增加状态与超时层数。

**理由**
长任务与短查询混在同一条链路上，必须让短查询能插队（因此是「队列 + 限制」而不是「串行」），同时必须让拒绝是显式错误码而不是静默超时（否则 LLM 会反复重试）。

**代价**
`maxInFlight` 需按机器调参；`BUSY`/`SESSION_BUSY` 会被小智 LLM 当作失败播报，因此**必须在工具描述里写明**「遇到 BUSY 请先调用 `dsh_task` 查看是否已在运行，不要重复提交」。

---

### ADR-009 工具面编织：grouped 默认 + flat 可切 + 分组开关

**状态**：提议中

**决策**
`tools.face: 'grouped'（默认）| 'flat'`；`tools.groups` 逐组开关；`tools.namePrefix` 默认 `dsh_`。

- **grouped**：18 个工具，按语音意图聚合，同族 CRUD 用 `action` 枚举而不是动词爆炸（清单见 §2.4）。
- **flat**：从能力表自动派生，1:1 对应路由（当前参考实现实测 **51 个注册项**；README 口径 47，差异来自后续新增的 `fs/*` 与 resumable 上传路由）。其中 streaming 三件套按 ADR-007 降级，不额外增加工具名。
- **命名规范（硬约束）**：`^[A-Za-z0-9_-]{1,64}$`、全小写 snake_case、必带 `namePrefix`、**不得使用中文**（平台允许中文残留，但语音识别与跨 server 合并时更易冲突）、启动期自检「清洗后无重名」。
- **描述规范（硬约束）**：描述里**不得引用其它工具名**——平台会把描述中出现的工具名做 `[^a-zA-Z0-9_\-\u4e00-\u9fff]→_` 清洗，引用会指错；改用「何时使用 / 何时不要用」的自然语言。
- **自描述工具**：`dsh_help{action:'tools'|'docs'|'openapi'}` 返回当前已发布的工具目录（含每个工具的入参说明），让 LLM 能自查能力边界。
- **目录变更**：`initialize` 结果里若平台声明 `capabilities.tools.listChanged`，则运行时改配置后发 `notifications/tools/list_changed`；否则标记 `restartRequired` 并在设置页提示重连。

**备选**
| 方案 | 优 | 劣 |
|---|---|---|
| 只用 flat（51 个） | 与 REST 完全同构，实现零决策 | 远超语音场景的 LLM 选择能力（平台侧要在一轮内从 51 项里挑），描述总长度大，误选率高 |
| 只用 grouped（18 个） | 语音友好 | 程序化/调试场景表达力受限（无法逐条精确调用） |
| 单一 `dsh_do{intent, text}` 万能派发 | 工具数最少 | 把路由决策推回平台 LLM，等价于放弃 schema 约束，参数校验失效 |

**理由**
语音场景的瓶颈是「LLM 在一轮里从 N 个工具中选对」，而不是接口数量。grouped 把 N 压到 18，同时 `action` 枚举让每个工具的意图空间显式可枚举（比让 LLM 自由填参更稳）；flat 作为逃生舱保留精确控制。

**代价**
grouped 的 handler 需要把 `action` 枚举映射到多条能力（一次工具调用可能触发多条 REST），错误语义要归一（`action` 拼错 → `[DSH_XZ_1001] INVALID_ARGS` 并回列合法枚举）；两种编织的测试矩阵翻倍 → 用「flat 为基准、grouped 只测派发」的测试策略控制成本。

---

### ADR-010 可选依赖的表达方式（对约束①的技术修正）

**状态**：提议中

**决策**
- 顶层 `export const inject` 只声明**真正必需**的服务：本插件为 `[]`（若保留 DSH 侧信息工具则为 `['tools']`）。
- `webServer` 的「可选」用 **`ctx.inject(['webServer'], (ctx) => { … })`** 表达：服务出现时挂载 server 角色、管理路由与 index 注入；服务消失时 fiber 自动回滚。
- 所有 DSH 服务访问一律 `ctx.get('x')` 守卫（沿用参考插件风格），并把缺失项登记进 `/admin/status.degradedDependencies`（形如 `[{service:'sessionController', affects:['dsh_session','dsh_ask']}]`）。
- index 注入用 `ctx.on('webserver/index-inject', (table) => table.push({ kind:'global', name:'__DSH_XIAOZHI__', value:{…} }))`（结构化行，官方推荐的 `tapIndex` 替代）。

**备选**
- 顶层 `inject = ['webServer','tools']`（参考插件做法）：在没有 webServer 的组合里（纯 endpoint/headless）插件整块不激活 → endpoint 角色直接失效。
- `inject = { webServer: { optional: true } }`：**不成立**。Cordis 的 `Inject` 对象形式是「服务名 → intercept config」，没有 required/optional 字段；数组与对象形式都表示必需。

**理由**
endpoint 角色在架构上完全不依赖 DSH 的 HTTP 服务，它不该因为 webServer 缺席而不可用。用 `ctx.inject` 把「webServer 出现」当成一个事件来处理，是本框架里表达可选依赖的正确方式。

**代价**
失去静态依赖可视化（由 `degradedDependencies` 在运行时补偿）；`ctx.inject` 回调内的资源必须用 `ctx.effect` 注册以便回滚，容易漏写 → 纳入 code review 检查项。

---

### ADR-011 管理面（设置页）的安全与发现

**状态**：提议中

**决策**
- 每进程生成 `adminToken = randomUUID()`，只通过 `webserver/index-inject` 注入到页面：
  `{kind:'global', name:'__DSH_XIAOZHI__', value:{adminBase, apiBase, version, adminToken}}`。
- `/dsh-xiaozhi/api/admin/*` 全部要求头 `X-DSH-Xiaozhi-Admin: <token>`，用 `crypto.timingSafeEqual` 比较；不落盘、不进日志、不返回给任何工具。
- 无 index 注入能力的环境（`server.standalonePort` 直连）默认**关闭** admin 面，除非显式配置 `admin.token`。
- 设置页：`settings.section` 插槽，`window.__ModuleLoader__.load({id, factory})`，`ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id:'dsh-xiaozhi', order:40, label:()=>'小智语音', locale:'dsh-xiaozhi'}, Section))`；只用 react 与 `--dsw-alias-*` 令牌；数据全部走本插件 admin REST。

**备选**
- Origin/Host 校验：反代与 `0.0.0.0` 绑定场景易误判，且不防同机其它进程。
- 复用 `apiKey`：浏览器页面无法安全持有长期密钥（要落到 localStorage）。
- 不鉴权：`webServer` 绑定 `0.0.0.0` 时等于把「改插件配置、看对话历史」暴露给局域网。

**理由**
`adminToken` 随进程生成、只进同源 HTML，天然满足「只有能加载 DSH 页面的浏览器才能管理」，无需引入登录态；同时对 LAN 扫描者不可读。

**代价**
页面刷新后若进程重启过会 401，需要页面在 401 时提示「请重新加载页面」；`__DSH_XIAOZHI__` 出现在 HTML 里属于可接受暴露（同源页面本就能访问 API），但必须在 README 说明。

---

### ADR-012 endpoint token 的处理

**状态**：提议中

**决策**
- token 来源按 ADR-005 优先级解析（env > 文件 > patch），`endpoint.tokenSource` 为只读派生值（`'env' | 'file' | 'patch' | 'none'`）。
- `/admin/status` 只返回 `tokenMasked`（前 6 后 4）与 `tokenSource`，永不回明文；日志/错误统一过 `redact()`（过滤 `token=`、`Bearer `、`?token=`）。
- 工具目录与描述**不含任何 URL/路径/密钥**（工具目录会出境到平台）。
- 收到 HTTP 401/403（或 close code 4401/4403）→ 状态置 `fatal`，**停止重连**，`/admin/status.lastError = TOKEN_INVALID`，设置页显示「重新粘贴 token」。
- `/admin/actions { action:'rotate_token', token }` 写入配置文件并触发 `reconnect`。
- README 必须写明出境数据：**所有 prompt 与工具返回文本都会经过小智平台**，默认 `redact` 与「只暴露必要工具组」是隐私控制手段。

**备选**
- token 放 patch config（会被 git 提交/被 profile 快照带走）。
- 自动刷新 token：平台是否提供刷新接口未知，不做；留 `rotate_token` 手工通道。

**理由**
token 是设备身份，泄漏等于他人可对这台 DSH 下发语音指令。掩码 + 不入境日志 + 失败即停，是成本最低的三道闸。

**代价**
无自动刷新，过期需人工介入（UI 必须给出明确引导）；明文落盘（0600）。

---

## 2. 模块与接口规格

### 2.1 文件清单

```
dsh-xiaozhi/
├── package.json                     # dsh.bundle.patch + dsh.client(platform:web, inject runtime/locale) + exports(./client, ./package.json, ./locale/*)
├── cordis.patch.yml                 # insert 一行：name=@dsh-external/dsh-xiaozhi, config:{}
├── icon.svg                         # 插件卡片图标（≤256KiB，包内相对路径）
├── locale/zh.json, locale/en.json    # 卡片标题/描述与页面文案
├── lib/index.js                      # host 入口：apply(ctx, config) + Config + 分阶段挂载（endpoint/server/admin）
├── lib/config.js                     # schemastery Config、scope 分层解析、env 覆盖、原子读写 config.json、来源标注
├── lib/log.js                        # 有界日志环形缓冲 + redact() + 结构化事件（供 /admin/logs）
├── lib/mcp/protocol.js               # JSON-RPC 信封编解码、id 策略、错误码常量、协议版本协商
├── lib/mcp/session.js                # 单连接 MCP 会话状态机：initialize→initialized→tools/list→ready，能力探测
├── lib/mcp/tool-catalog.js           # ToolSpec 类型、注册表、grouped/flat 编织、名称清洗自检、描述渲染
├── lib/mcp/tools/system.js           # dsh_status / dsh_help 工具
├── lib/mcp/tools/workspace.js        # dsh_workspace（list/get/create/rename/delete/sessions）
├── lib/mcp/tools/session.js          # dsh_session / _history / _stats / _todos / _skills / _cancel / _questions
├── lib/mcp/tools/prompt.js           # dsh_ask / dsh_task / dsh_events（两段式与轮询）
├── lib/mcp/tools/models.js           # dsh_models（models/default/providers/presets）/ dsh_settings
├── lib/mcp/tools/files.js            # dsh_file（list/upload/download-metadata）
├── lib/mcp/tools/skills.js           # dsh_skill（list/get/create/update/delete）
├── lib/mcp/tools/flat.js             # flat 模式生成器：从能力表派生工具（含命名/描述模板）
├── lib/ws/frame.js                   # RFC6455 帧编解码、掩码、分片、控制帧、close code、上限校验
├── lib/ws/client.js                  # 客户端握手（net/tls）+ 保活 + 关闭握手 + 退避（EndpointLink 的传输层）
├── lib/ws/upgrade.js                 # 服务端 upgrade 握手（实验传输）
├── lib/transport/endpoint-link.js    # endpoint 角色编排：连接、initialize、tools/list、断线重连、in-flight 收敛
├── lib/transport/server-link.js      # server 角色编排：会话表、请求派发、并发上限、standalone 端口
├── lib/transport/stream-http.js      # streamable-HTTP 传输（POST/GET/DELETE，Mcp-Session-Id，SSE 单帧）
├── lib/transport/legacy-sse.js       # 老式 HTTP+SSE 传输（GET /sse + POST /messages），可选
├── lib/capability/registry.js        # 能力表：cap() 装饰器、能力元数据、启动期自检（孤儿路由/重名）
├── lib/capability/http-double.js     # RouteRequest/RouteResponse 接口 + fromNodeHttp 适配器 + createDoubles 替身
├── lib/capability/invoke.js          # invoke(capabilityId, args) → 替身执行 → 归一化 {status, ok, data, error}
├── lib/capability/events-ring.js     # 全局 session/event 环形缓冲、游标读取、LRU 会话淘汰
├── lib/api/router.js                 # 复制层：HttpRouter（签名改为结构化接口 + trusted 内部派发）
├── lib/api/workspaces.js             # 复制层：工作区 CRUD + 会话列举
├── lib/api/sessions.js               # 复制层：会话 CRUD/历史/统计/todos/skills/cancel
├── lib/api/streaming.js              # 复制层：prompt / prompt-stream / events / chat/completions（保留 SSE 形态）
├── lib/api/turn-waiter.js            # 抽取共用：提交前置订阅 + ownTurn 归属 + 超窗返回部分文本
├── lib/api/models.js                 # 复制层：models/providers/presets/settings
├── lib/api/files.js                  # 复制层：文件列表/上传/download/resumable 上传
├── lib/api/fs.js                     # 复制层：fs 列表/download/mkdir/remove
├── lib/api/skills.js                 # 复制层：技能 CRUD/body/archive
├── lib/api/skill-utils.js            # 复制层：技能目录解析与校验
├── lib/api/user-questions.js         # 复制层：ask_user_question 答复桥 + questions/answers 路由
├── lib/api/openapi.js                # 复制层：/docs 与 /openapi.json
├── lib/api/types.js                  # 复制层：共享类型（ApiResponse/SessionItem/…）
├── lib/api/README-COPY.md            # 复制来源与本地改动清单（逐文件），便于跟随上游更新
├── lib/admin/admin-routes.js         # 管理面：status/config/actions/logs/tool-face-preview（adminToken 鉴权）
├── lib/admin/index-inject.js         # 通过 webserver/index-inject 注入 __DSH_XIAOZHI__
└── client.js                         # 设置页客户端模块：__ModuleLoader__.load({id, factory})，settings.section
```

### 2.2 关键类型签名

```ts
// ── MCP 信封 ─────────────────────────────────────────────
type JsonRpcId = number | string
interface JsonRpcRequest      { jsonrpc:'2.0'; id:JsonRpcId; method:string; params?:unknown }
interface JsonRpcNotification { jsonrpc:'2.0'; method:string; params?:unknown }
interface JsonRpcSuccess<T>   { jsonrpc:'2.0'; id:JsonRpcId; result:T }
interface JsonRpcErrorObject  { code:number; message:string; data?:unknown }
interface JsonRpcError        { jsonrpc:'2.0'; id:JsonRpcId|null; error:JsonRpcErrorObject }
type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess<unknown> | JsonRpcError

interface InitializeParams {
  protocolVersion: string                    // 期望 '2024-11-05'
  capabilities: { roots?:{listChanged?:boolean}; sampling?:object; elicitation?:object }
  clientInfo: { name:string; version:string }
}
interface InitializeResult {
  protocolVersion: string                    // 协商结果：不支持则回我们支持的最高版本
  capabilities: { tools:{ listChanged:boolean } }
  serverInfo: { name:string; version:string }
  instructions?: string
}
interface PlatformCapabilities {             // 从 initialize 请求里记录，决定推送/重连策略
  listChanged: boolean; sampling: boolean; elicitation: boolean; protocolVersion: string
}
interface ContentBlock { type:'text'; text:string }      // 只产出 text
interface ToolCallResult { content:ContentBlock[]; isError:boolean; structuredContent?:unknown }
interface ToolCallParams { name:string; arguments?:Record<string,unknown>; _meta?:{ progressToken?:string|number } }

// ── 工具与能力 ────────────────────────────────────────────
type ToolGroup = 'system'|'workspace'|'session'|'prompt'|'models'|'files'|'skills'|'docs'|'admin'
/** 只用 JSON Schema 的扁平子集：type/properties/required/enum/items/default/description；禁止 $ref/$defs/oneOf */
type FlatJsonSchema = { type:'object'; properties:Record<string,unknown>; required?:string[]; additionalProperties?:boolean }

interface ToolSpec {
  name: string                     // 已满足 ^[A-Za-z0-9_-]{1,64}$，带 namePrefix
  description: string              // 不得引用其它工具名；含「何时不要用」
  inputSchema: FlatJsonSchema
  group: ToolGroup
  mutating: boolean                // 是否改变状态（供 UI 与审计；不参与鉴权决策）
  longRunning: boolean             // 是否可能超出 waitMs（决定是否强制 requestId）
  timeoutMs: number                // 该工具自身的最大等待预算
  meta: { capabilityIds:string[]; face:'grouped'|'flat'; voiceExamples?:string[] }
  handler(args:Record<string,unknown>, call:CallContext): Promise<ToolCallResult>
}
interface CallContext {
  connectionId: string; requestId: JsonRpcId; requestKey: string   // 幂等键
  deadline: number; signal: AbortSignal; log:(e:string, f?:unknown)=>void
  transport:'endpoint'|'stream-http'|'legacy-sse'|'ws-upgrade'
}

type HttpMethod = 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'
interface Capability<Out=unknown> {
  id: string                       // 'sessions.history'
  method: HttpMethod; path: string // '/sessions/:id/history'
  summary: string
  inputSchema: FlatJsonSchema      // 由 :params + query + body 合成
  mutating: boolean; longRunning: boolean
  mcp: { expose:true|false|'metadata-only'; tool?:string; group?:ToolGroup }
  invoke(args:Record<string,unknown>, opts:InvokeOptions): Promise<InvokeResult<Out>>   // 由 cap() 生成
}
interface InvokeOptions { trusted:boolean; signal?:AbortSignal; rawBody?:boolean; timeoutMs?:number }
interface InvokeResult<Out=unknown> {
  status:number; ok:boolean; data?:Out
  error?:{ code:string; message:string }
  sse?: Array<{ event:string; data:unknown }>   // 命中 SSE 能力时收集的事件序列
}

// ── 结构化 HTTP 接口（替代 IncomingMessage/ServerResponse）──
interface RouteRequest extends Readable { method?:string; url?:string; headers:Record<string,string|string[]|undefined> }
interface RouteResponse {
  statusCode:number; headersSent:boolean; writableEnded:boolean
  setHeader(n:string,v:string|number|string[]):void; getHeader(n:string):unknown
  write(c:string|Buffer):boolean; end(c?:string|Buffer):void; flushHeaders?():void
}
interface HttpDoubles { req:RouteRequest; res:RouteResponse; result:Promise<{status:number;headers:Record<string,string>;body:Buffer}>
                        dispose():void }   // dispose() → req.destroy() → 触发 'close'，释放 SSE 订阅

// ── 连接状态 ──────────────────────────────────────────────
type ConnectionState = 'disabled'|'idle'|'connecting'|'handshaking'|'syncing'|'ready'|'degraded'|'closing'|'backoff'|'fatal'
interface ConnectionSnapshot {
  state:ConnectionState; since:number; attempt:number; nextRetryAt?:number
  endpointMasked?:string; platform?:{name:string;version:string;protocolVersion:string}
  capabilities?:PlatformCapabilities; toolsPublished:number
  stats:{ calls:number; errors:number; timeouts:number; busyRejects:number; avgLatencyMs:number; p95LatencyMs:number }
  lastError?:{ code:string; message:string; at:number }
}
interface BackoffPolicy { baseMs:number; factor:number; maxMs:number; jitterRatio:number; resetAfterReadyMs:number }

// ── 配置（节选，完整见 §2.7）─────────────────────────────
interface Config {
  mode:'endpoint'|'server'|'both'
  apiPrefix:string
  endpoint:{ url:string; token:string; subprotocol:string; allowInsecureTls:boolean
             connectTimeoutMs:number; handshakeTimeoutMs:number
             pingIntervalMs:number; livenessTimeoutMs:number; backoff:BackoffPolicy }
  server:{ transports:Array<'stream-http'|'legacy-sse'|'ws'>; path:string; standalonePort:number
           maxConnections:number; token:string }
  tools:{ face:'grouped'|'flat'; groups:Record<ToolGroup,boolean>; namePrefix:string
          textLimit:number; waitMs:number; maxWaitMs:number
          maxInFlight:number; perConnectionInFlight:number; queueDepth:number; queueWaitMs:number }
  events:{ ringPerSession:number; ringSessions:number; taskTtlMs:number }
  admin:{ enabled:boolean; token:string }
  log:{ level:'debug'|'info'|'warn'|'error'; ringSize:number }
}
interface EffectiveField<T> { effective:T; source:'env'|'file'|'patch'|'default'; locked:boolean }
```

### 2.3 错误码表

**协议层失败**（走 JSON-RPC `error` 对象；仅当请求本身无法处理时）：

| code | 名称 | 场景 |
|---|---|---|
| -32700 | PARSE_ERROR | 帧/body 不是合法 JSON |
| -32600 | INVALID_REQUEST | 缺 `method`、`id` 类型非法（非 number/string） |
| -32601 | METHOD_NOT_FOUND | 未实现的 method（含 `resources/*`、`prompts/*`） |
| -32602 | INVALID_PARAMS | `tools/call` 缺 `params.name` |
| -32603 | INTERNAL_ERROR | 未捕获异常 |

**能力层失败**（走 `result.content[0].text` + `isError:true`，文本以 `[CODE] ` 开头；**语音链路必须让 LLM 读到原因，不能只回 JSON-RPC error**）：

| code | 名称 | 触发 | 建议 LLM 行为（写进描述） |
|---|---|---|---|
| DSH_XZ_1001 | INVALID_ARGS | 参数缺失/类型错/`action` 非法 | 修正参数重试 |
| DSH_XZ_1002 | NOT_FOUND | 会话/工作区/文件/技能不存在 | 先列清单 |
| DSH_XZ_1003 | UNAUTHORIZED | 平台侧 token 无效或未配置 | 提示用户重新授权 |
| DSH_XZ_1004 | SESSION_BUSY | 该会话已有 in-flight ask | 用 `dsh_task` 查看，勿重复提交 |
| DSH_XZ_1005 | TIMEOUT_PARTIAL | 超 `waitMs`（**isError:false**） | 播报部分结果并稍后 `dsh_task` |
| DSH_XZ_1006 | CANCELLED | 被 `dsh_session_cancel` 或调用方取消 | — |
| DSH_XZ_1007 | UPSTREAM_ERROR | DSH 服务抛错（透传 message，已 redact） | 播报失败原因 |
| DSH_XZ_1008 | UNSUPPORTED_IN_MCP | 二进制/流式语义不可映射（下载类） | 提示去 Web 端查看 |
| DSH_XZ_1009 | TOO_LARGE | base64 上传/参数超限 | 改用 `path` |
| DSH_XZ_1010 | BUSY | 全局/单连接并发或队列超限 | 稍后重试，勿并发轰炸 |
| DSH_XZ_1012 | CONNECTION_LOST | 断线导致 in-flight 终止 | 重连后 `dsh_task` 取回结果 |
| DSH_XZ_1013 | DEPENDENCY_MISSING | 所需 DSH 服务当前不可用 | 提示能力暂不可用 |
| DSH_XZ_1014 | RATE_LIMITED | 主动限流（防 LLM 循环调用） | 停止重试 |

**传输/连接层**（只进日志与 `/admin/status`，不产生工具响应）：`XZ_2001 WS_HANDSHAKE_FAILED`、`XZ_2002 WS_PROTOCOL_ERROR`（含 close code）、`XZ_2003 WS_UNAUTHORIZED`（HTTP 401/403）、`XZ_2004 RECONNECT_EXHAUSTED`（仅用于 UI 提示，不终止重连）、`XZ_2005 TLS_ERROR`、`XZ_2006 HTTP_SESSION_INVALID`（`Mcp-Session-Id` 不识别 → 要求重新 initialize）。

### 2.4 工具目录（grouped = 18）

| # | 工具名 | 覆盖能力 | 关键入参 | 说明 |
|---|---|---|---|---|
| 1 | `dsh_status` | GET /system/status | — | 系统状态 + 连接状态 + 已发布工具数（不泄漏 token/路径） |
| 2 | `dsh_workspace` | workspaces 6 条 | `action:list\|get\|create\|rename\|delete\|sessions`, `id?`, `path?`, `title?` | 工作区一族 |
| 3 | `dsh_session` | sessions 的 list/get/create/update/delete | `action`, `id?`, `workspaceId?`, `title?`, `provider?`, `model?` | 会话一族（不触发回合） |
| 4 | `dsh_session_history` | GET /sessions/:id/history | `id`, `maxMessages?≤200`, `throughSeq?`, `beforeSeq?` | 历史（文本化） |
| 5 | `dsh_session_stats` | GET /sessions/:id/stats | `id` | 运行态/耗时/turn 数 |
| 6 | `dsh_session_todos` | GET /sessions/:id/todos | `id` | 待办 |
| 7 | `dsh_session_skills` | GET /sessions/:id/skills | `id`, `q?` | 会话可用技能 |
| 8 | `dsh_session_cancel` | POST /sessions/:id/cancel | `id` | 打断当前回合 |
| 9 | `dsh_session_questions` | questions / answers | `action:list\|answer`, `id`, `answers?` | 反问桥（语音回答） |
| 10 | `dsh_ask` | POST prompt / prompt-stream | `prompt`, `sessionId?`, `waitMs?`, `mode?:'normal'\|'steer'`, `requestId?` | **核心**：提问并短等待；无 sessionId 时走 chat/completions 一次性问答 |
| 11 | `dsh_task` | 轮询（events ring + agents 运行态） | `action:status\|result\|cancel`, `taskId` | 长任务续查 |
| 12 | `dsh_events` | GET /sessions/:id/events（降级） | `sessionId`, `sinceSeq?`, `limit?≤100` | 增量事件拉取 |
| 13 | `dsh_models` | models / providers / presets + models/default | `action:list\|providers\|presets\|default_get\|default_set`, `provider?`, `model?`, `reasoningEffort?` | 模型一族 |
| 14 | `dsh_settings` | GET /settings, PATCH /settings/:namespace | `action:get\|patch`, `namespace?`, `value?` | DSH 设置读写（`patch` 为 mutating） |
| 15 | `dsh_file` | files list/upload/download | `action:list\|upload\|download`, `sessionId`, `path?`, `name?`, `dest?` | 上传用 `path`；下载只回元数据（1008 语义） |
| 16 | `dsh_skill` | skills 7 条 | `action:list\|get\|create\|update\|delete`, `name`, `body?`, `root?` | 技能管理 |
| 17 | `dsh_help` | docs / openapi | `action:tools\|docs\|openapi\|groups`, `group?` | 自描述目录（LLM 自查） |
| 18 | `dsh_agent`（可选，默认关） | chat/completions | `messages`, `model?` | 无会话一次性问答；`groups.prompt` 关闭时留给 `dsh_ask` |

**flat 派生规则**：`name = namePrefix + lower(method) + '_' + path 去掉前导斜杠、'/'→'_'、':param'→param`，例如
`dsh_get_sessions_id_history`、`dsh_post_sessions`、`dsh_put_models_default`。
同段落 `:id` 一律映射为入参 `id`；query 映射为同名可选参；body 展开为顶层字段（与 `inputSchema.properties` 一一对应）。冲突时追加 `_2` 并在启动自检里报 `namingCollision`。

### 2.5 端点清单

| 面 | 路径 | 方法 | 说明 |
|---|---|---|---|
| DSH 能力（复制层） | `/dsh-xiaozhi/api/**` | 原样 | 51 条注册项，鉴权沿用参考实现的 `apiKey`（默认空=不鉴权，但**默认只允许 loopback 或带 adminToken**，见风险 R8） |
| 管理面 | `/dsh-xiaozhi/api/admin/status` | GET | 生效配置（含每字段 source）、连接快照、工具目录、degradedDependencies、孤儿路由、命名冲突 |
| 管理面 | `/dsh-xiaozhi/api/admin/config` | PATCH | 只写 `scope:'user'` 字段；返回逐字段 `{effective,source,locked}` |
| 管理面 | `/dsh-xiaozhi/api/admin/actions` | POST | `reconnect` / `disconnect` / `test_connection` / `refresh_tools` / `rotate_token` / `set_group` |
| 管理面 | `/dsh-xiaozhi/api/admin/logs?limit=200&level=` | GET | 环形日志（已 redact） |
| 管理面 | `/dsh-xiaozhi/api/admin/tool-face-preview?face=` | GET | 预览将要发布的工具目录（校验清洗/长度/描述），可对 grouped/flat 分别预览 |
| MCP（server 角色） | `server.path`（默认 `/mcp/xiaozhi`） | POST/GET/DELETE | streamable-HTTP（GET 为 SSE 通道，DELETE 结束会话） |
| MCP（legacy，可选） | `server.path + '/sse'`、`server.path + '/messages'` | GET/POST | 老式 HTTP+SSE |
| MCP（实验） | `server.path` | Upgrade | WS upgrade（`registerUpgrade`，与上面的 exact 路由并存，两张表） |
| 独立端口（可选） | `server.standalonePort` | 全部 | 另起 `node:http`，仅挂 MCP 面（**不挂 admin**，除非配 `admin.token`） |

### 2.6 连接状态机（endpoint 角色）与重连参数

```
disabled ──(配置出现 url)──→ idle ──→ connecting ──(upgrade ok)──→ handshaking
   ↑                            ↑                                      │
   │                            │                              (initialize result)
   │                            │                                      ↓
   │                            │                                  syncing
   │                            │                                      │
   │                            │                             (tools/list 完成)
   │                            │                                      ↓
   └────(mode 变更)─────────────┴──────────────────────────────────→ ready ⇄ degraded
                                                                       │
                     ┌──────────── error / close / liveness timeout ───┘
                     ↓
                  closing ──→ backoff ──(nextRetryAt)──→ connecting
                                 │
                                 └──(401/403 或 close 4401/4403)──→ fatal ──(admin action/config)──→ idle
```

| 迁移 | 触发 | 动作 / 参数 |
|---|---|---|
| `idle→connecting` | 启动或配置变更 | 解析 URL（`wss`→tls），`connectTimeoutMs=10000` |
| `connecting→handshaking` | HTTP 101 且 `Sec-WebSocket-Accept` 校验通过 | 立即发 `initialize`（`protocolVersion:'2024-11-05'`, `capabilities:{roots:{listChanged:true},sampling:{}}`, `clientInfo:{name:'dsh-xiaozhi',version}`），`handshakeTimeoutMs=15000` |
| `handshaking→syncing` | 收到 `initialize` result | 记录 `PlatformCapabilities`；发 `notifications/initialized`；发 `tools/list` |
| `syncing→ready` | 分页取完（同 id 续页，最多 8 页/页 100） | 记录平台 tools 数；启动 ping 定时器 |
| `syncing→ready(降级)` | tools/list 返回错误 | 仍进 `ready`（工具是我们注册的，list 失败不影响被调用），`lastError` 记录 |
| `ready→degraded` | 写队列持续满 / 部分 DSH 依赖缺失 | 保持读；UI 黄灯；短查询继续服务 |
| `ready→closing` | 收到 close、socket error、`livenessTimeoutMs=45000` 内无任何帧 | 发 close（1000/1001），等对端 1s |
| `closing→backoff` | close 完成 | `attempt++`；`delay = min(60000, 1000×1.8^(attempt-1)) × jitter(0.7–1.3)`；`nextRetryAt` 写入快照 |
| `backoff→connecting` | `now ≥ nextRetryAt` | 重连**必须重跑完整 initialize+initialized+tools/list**（会话无状态） |
| `ready` 持续 ≥60s | — | `attempt = 0`（退避复位） |
| 任意→`fatal` | HTTP 401/403、close 4401/4403、`Sec-WebSocket-Accept` 不匹配 3 次 | **停止自动重连**；仅在 admin `reconnect`/`rotate_token`/配置变更后回 `idle` |
| 断线时 in-flight | — | 全部以 `DSH_XZ_1012` 结束，**不回放**（平台自行重发，靠 requestId 幂等） |

定时器：`pingIntervalMs=10000`（WS ping，带 ±10% 抖动）、`livenessTimeoutMs=45000`、`idleDisconnectMs=0`（不主动断开，平台侧可能主动清理）。
并发参数：`maxInFlight=4`、`perConnectionInFlight=2`、`queueDepth=16`、`queueWaitMs=5000`、`admissionTimeoutMs=5000`。

### 2.7 配置项表（节选，完整字段见 §2.2 Config）

| 字段 | scope | 默认 | env | 备注 |
|---|---|---|---|---|
| `mode` | deploy | `endpoint` | `DSH_XIAOZHI_MODE` | |
| `apiPrefix` | deploy | `/dsh-xiaozhi/api` | — | 复制层挂载点 |
| `endpoint.url` | user | `''` | `DSH_XIAOZHI_ENDPOINT_URL` | 含 token 的 wss URL 也可，但优先用 token 字段 |
| `endpoint.token` | user(secret) | `''` | `DSH_XIAOZHI_ENDPOINT_TOKEN` | 落盘 0600；只回掩码 |
| `endpoint.pingIntervalMs` / `livenessTimeoutMs` | deploy | 10000 / 45000 | — | 对齐参考实现量级 |
| `server.transports` | deploy | `['stream-http']` | — | 见 ADR-002 |
| `server.path` | deploy | `/mcp/xiaozhi` | — | exact 路由 + upgrade 同路径 |
| `server.standalonePort` | deploy | `0` | — | >0 时另起 http |
| `tools.face` | deploy | `grouped` | — | `grouped`=18，`flat`≈51 |
| `tools.groups` | deploy | 除 `admin`/`agent` 全 true | — | 逐组开关 |
| `tools.textLimit` | user | 1200 | — | 语音友好截断（字符） |
| `tools.waitMs` / `maxWaitMs` | user / deploy | 15000 / 60000 | — | 两段式等待窗口 |
| `events.ringPerSession` / `ringSessions` / `taskTtlMs` | user | 200 / 64 / 1800000 | — | 环形缓冲与 task 生命周期 |
| `admin.enabled` / `admin.token` | user | `true` / `''` | — | standalone 场景必须显式配 token |

### 2.8 测试与验收（架构层要求的最小集）

1. **等价性测试（必做）**：对全部 51 条能力，用同一 fixture 分别经真实 HTTP（`node:http` 临时端口 + 同一 router）与 MCP 替身执行，断言 `status` 与 body 深相等（剔除 `timestamp`）；SSE 类断言事件序列相等。这条测试是 ADR-003 的守门人。
2. **WS 协议黄金向量**：RFC6455 §5.7 示例、掩码/非掩码、126/127 长度、分片重组、控制帧穿插、close code 1002/1007/1009。
3. **协议一致性**：`initialize` → `initialized` → `tools/list`（含 cursor 续页复用同 id）→ `tools/call` 回显同 id；`{"method":"ping"}`（**无 jsonrpc 字段、可能无 id**）→ 必须回 `{"jsonrpc":"2.0","id":N,"result":{}}`。
4. **命名自检**：全部工具名匹配 `^[A-Za-z0-9_-]{1,64}$`、清洗后无重名、描述内不含任何工具名。
5. **幂等测试**：同一 `requestId` 连发 3 次 `dsh_ask`，断言只产生 1 次 `followup`。
6. **admin 鉴权**：无/错 adminToken → 401；正确 → 200；`rotate_token` 后旧 token 失效、连接重建。
7. **重连测试**：本地 stub WS server 依次注入 close、无响应、401，断言状态迁移与退避序列（含 401→`fatal` 不再重连）。
8. **schema 扁平化 lint**：`inputSchema` 中不得出现 `$ref`/`$defs`/`oneOf`/`anyOf`（平台解析能力未知）。

---

## 3. 风险清单与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **endpoint token 泄漏**（进 patch/git、进日志、进工具描述、进 `/admin/status`） | 他人可对本机 DSH 下发语音指令 | token 只入 `config.json`(0600) 或 env；`/admin/status` 只回掩码；统一 `redact()` 过滤 `token=`/`Bearer`/`?token=`；工具目录不含 URL；README 写威胁模型；401 即 `fatal` 停连 |
| R2 | **平台 tools/call 超时未知，长任务被截断** | 平台超时 → LLM 重试 → 同一 prompt 重复执行（烧 token、改坏代码） | 两段式（ADR-007）：`waitMs` 默认 15s；`isError:false` + `taskId` 表示「进行中」；平台侧重试靠 `requestId` 幂等去重；工具描述明确写「超时不要重发，先 `dsh_task`」；DSH 侧永不自动重试/回放 |
| R3 | **工具过多 → 小智 LLM 选错/漏选** | 语音指令答非所问 | 默认 `grouped`（18 个）；描述写「何时用/何时不用」+ 语音例句；`dsh_help` 让 LLM 自查；`tools.groups` 按用户实际场景关掉 files/skills/models；flat 明确标注为「程序化/调试用」 |
| R4 | **平台 tool 名清洗**（含描述内工具名替换）导致名字/引用错乱 | 调用落到不存在的工具，或描述误导 LLM | 名字只用 `[A-Za-z0-9_-]`、必带 `namePrefix`、启动自检清洗后无重名；描述**禁止引用工具名**（改为自然语言）；`/admin/tool-face-preview` 展示「平台看到的最终名字与描述」；跨 MCP server 重名风险用 `dsh_` 前缀 + 可配 `namePrefix` 规避 |
| R5 | **进程内替身与真实 HTTP 语义偏差**（statusCode 默认值、header 大小写、`Content-Length`、SSE 分帧、`req.on('close')` 未触发导致订阅泄漏） | MCP 面与 HTTP 面行为不一致；内存/监听器泄漏 | 结构接口 + 编译期约束；`createDoubles().dispose()` 必须 `destroy()` 请求流以触发 `close`；等价性测试（§2.8.1）作为 CI 门禁；替身侧断言 `headersSent`/`writableEnded` 状态机与真实响应一致；API key 用 `trusted:true` 显式跳过而非伪造头 |
| R6 | **多客户端同时连接**（server 模式多台小智设备 + Web 设置页 + endpoint 同时在线） | 并发打满 DSH；同一会话被两路 `ask` 抢占；幂等键碰撞 | 每连接独立队列与计数 + 全局 `maxInFlight`；`server.maxConnections=8`；`SESSION_BUSY`（除非 `steer`）；幂等键含 `connectionId`；共享环形缓冲保证任一连接都能读到同一回合结果 |
| R7 | **平台 schema 兼容**（`$ref`/`oneOf`/超长描述/`inputSchema` 体积） | 工具参数被平台拒绝或截断，LLM 无法正确填参 | 只用扁平 JSON Schema 子集并由 lint 保证；描述限长（建议 ≤ 400 字符/工具）；`/admin/tool-face-preview` 给出目录总字节数告警阈值（默认 64KiB） |
| R8 | **管理面在局域网暴露**（webServer 绑 `0.0.0.0`，默认无鉴权） | 局域网内可改插件配置、读历史/日志 | ADR-011 的 per-process `adminToken`（只进同源 HTML）+ 所有 admin 路由强制校验；无 index 注入的环境默认关闭 admin；`apiPrefix` 能力面默认仅 loopback（或需 `apiKey`/adminToken） |
| R9 | **复制层版本漂移**（上游 dsh-web-service 演进，本地改过签名） | 跟上游更新时冲突、行为分叉 | `lib/api/README-COPY.md` 记录逐文件改动清单（仅「签名类型 + `cap()` 登记 + `trusted` 派发」三类）；改动集中在文件头部与注册处；等价性测试保证行为不变 |
| R10 | **配置层冲突**（patch 与 UI 互相"不生效"） | 用户困惑，反复改配置 | `scope` 分层 + 每字段 `{effective,source,locked}` + UI 明示「由 cordis.patch.yml 管理」；`/admin/actions` 提供 `explain_config` 返回决策链 |
| R11 | **事件环形缓冲内存**（大回合产生大量 chunk 事件） | 长期运行内存增长 | 只缓存"可对外有意义"的事件类型（`turn/start`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`、`error`），丢弃 `assistant/chunk` 的逐 token 增量（增量只用于当次 `ask` 的实时累积）；每会话 200 条 + LRU 64 会话 + 单条 8KiB 截断 |
| R12 | **图片/语音附件语义未知**（DSH 支持 images；小智是语音通道） | 能力误用或静默失败 | MCP 面图片参数只接受本地 `path`（同宿主）或 ≤1MiB base64，超限回 `DSH_XZ_1009`；README 说明语音链路不做图像输入 |

---

## 4. 最可能出错 / 最需要改的 3 个点

### P1（最高）——「伪造 IncomingMessage/ServerResponse」的进程内替身

**为什么最可能出错**：这是全插件唯一的「非常规」机制，且它的失效是**隐性**的——真实 Node 类的构造与写入依赖未文档化的内部实现（`OutgoingMessage` 在无 socket 时的 `write` 行为、`headersSent`/`writableEnded` 的时序、`req.on('close')` 是否触发）。参考实现里的 SSE 路由正是靠 `req.on('close')` 清理 `ctx.on('session/event')` 订阅：替身若不触发 `close`，每次 MCP 调用都会泄漏一个会话事件监听器，表现为「跑了几天后每个事件被处理几十次」——极难定位。

**替代设计（建议采纳）**
1. handler 签名改为 `RouteRequest`/`RouteResponse` 结构化接口（§2.2），真实与替身两个适配器都必须满足它，编译器兜底；
2. 替身 `req` 用 `Readable` 子类，`dispose()` 走 `destroy()` 让 `close` 必然触发；
3. 把「等 SSE 流结束」变成显式契约：`invoke()` 支持 `signal` 与 `collectUntil:'end'|'first-done'|'timeout'`，不依赖 `close` 语义做清理；
4. 等价性测试进 CI（§2.8.1）；
5. 更进一步（推荐）：**热工具走类型化能力执行器**——`dsh_ask`/`dsh_task`/`dsh_events`/`dsh_session_*` 这几条高频工具直接调用 `turn-waiter` + `events-ring` + `ctx` 服务，只有冷门 CRUD 走替身。理由是这几条恰好是 SSE/长任务语义最重、替身偏差最致命的地方。

### P2——server 角色用自研 WS upgrade 作为主传输

**为什么最可能出错**：平台对小智作为 MCP **client** 连出到第三方 server 的支持形式已明确是 SSE/streamable-http；**WS 连出未被证实**。若把 `registerUpgrade` 当主路径，可能出现「代码全对、平台连不上」的结局；而且服务端 WS 还需要处理 `Sec-WebSocket-Protocol`、子协议协商、跨反代的 Upgrade 头透传（很多反向代理默认不转发 `Upgrade`）——这是纯粹的额外风险，收益为零。

**替代设计（建议采纳）**
1. 主传输改为 **streamable-HTTP**（同一 `server.path` 上一个 exact 路由按 method 分派），可选再挂 legacy `GET /sse` + `POST /messages`；
2. `ws` 保留为 `server.transports` 里的可选值，用于「平台明确支持 WS 连出」或本地自测；
3. 统一 `ServerTransport` 接口（`onMessage/ send / close / sessionCount`），三个实现只做编解码差异；
4. 上线前用平台自带 MCP 调试面板做一次真实握手，把 `Accept`、`Mcp-Session-Id`、是否需要 `initialize` 的 SSE 响应形态**记入 ADR-002 的「已实测」栏**；在实测前，代码必须同时兼容「有/无 session id」两种客户端。

### P3——把「一次 `ask` = 一次阻塞等待」当成长任务方案

**为什么最可能出错**：DSH 的一个真实回合动辄数十秒到数分钟，而 `tools/call` 的响应窗口很可能只有十几秒。单一阻塞实现会同时踩三个坑：平台超时 → LLM 重试 → **同一 prompt 被重复提交**（在改代码的场景里这是破坏性的）；超时后无法告知「仍在进行」；用户侧表现为「小智没反应/答非所问」。参考实现里 `executePromptAndWait` 的 `timeoutMs || 180000` 正是这个形状——对 HTTP 客户端可行（它能等），对语音链路不可行。

**替代设计（建议采纳）**
1. **默认两段式**（ADR-007）：`dsh_ask` 提交 + `waitMs`（默认 15s）内返回；未完成则 `isError:false` + 部分文本 + `taskId`；
2. **强制幂等**：`dsh_ask` 无 `requestId` 时由插件生成并**在返回文本里回显** `taskId`；同 `requestId` 重复到达只返回既有状态，绝不二次 `followup`；
3. **`dsh_task` 是唯一续查通道**（`status` 读 agents 运行态、`result` 读环形缓冲），并在 `dsh_ask` 与 `dsh_task` 的描述里写明「超时不算失败，先查 task」；
4. **推拉结合（可选增强）**：若实测平台支持 `notifications/progress` 或 `_meta.progressToken`，则在 `dsh_ask` 等待窗口内best-effort 上报进度；不支持则完全依赖轮询——**架构上不依赖它**；
5. **取消路径**：`dsh_task{action:'cancel'}` ↔ `POST /sessions/:id/cancel`，让用户能说「停下」。
