# 设计提案（实施前） / Pre-implementation design proposals

> ⚠️ **这三份文档是「实施前的设计提案」，不是对已发布插件行为的描述。**
> 实际交付的代码在若干处与提案不同。以代码与 [../TOOLS.md](../TOOLS.md)、
> [../../README.zh.md](../../README.zh.md) 为准；本文列出全部差异。
>
> **These three documents are pre-implementation proposals, not a description of the
> shipped plugin.** The code diverges in several places; the code and the main docs
> win. Every difference is listed below.

| 文件 | 角色 |
| --- | --- |
| [`architecture-adr.md`](./architecture-adr.md) | 架构决策记录（v1）：12 条 ADR、模块与接口规格 |
| [`architecture-review-v2.md`](./architecture-review-v2.md) | 对 v1 的定点复核与裁定（含 5 处须先修的问题） |
| [`settings-ux-walkthrough.md`](./settings-ux-walkthrough.md) | 设置页逐屏走查、字段级文案、端到端语音剧本 |

这三份文档由启用中的专家（软件架构师 / UX 架构师 / 验收测试工程师风格）产出，
写作时**尚未写实现代码**，其中对平台行为的部分判断被标注为「待实测」。

---

## 提案 → 实现的差异裁定

| # | 提案 | 实际交付 | 理由 |
| --- | --- | --- | --- |
| 1 | `mode` 扩为 `endpoint \| server \| both` | `mode: endpoint \| server` + `serverPort > 0` 时额外监听 | “both” 的语义可由 `mode=server` + 独立端口表达，少一个枚举值就少一条需要测试的分支；独立端口本来就是 `server` 角色的可选增强 |
| 2 | **server 角色主传输改为 streamable-HTTP**，WS upgrade 降级为实验开关 | server 角色仍用 **WebSocket upgrade**（`registerUpgrade`） | 提案的理由是“平台被证实能以 MCP client 连出到 SSE/streamable-HTTP，未经证实支持 WS 连出”。但本插件的 server 角色面向的是**自建 `xiaozhi-esp32-server`**，其 C++ 端 `WebSocketMCP` 就是 WS；而且 WS 路径与 endpoint 角色共用同一套分帧/会话代码，维护面更小。若将来需要接官方 streamable-HTTP，可作为**新增**传输而不是替换 |
| 3 | 不要伪造 `IncomingMessage` / `ServerResponse`，改结构化接口 + 双适配器 | 保留 `LocalInvoker`：请求侧用 `Readable.from(...)`，响应侧用真 `Writable` 子类 `CaptureResponse` | 目标一致（**不**去 `new` 真的 `IncomingMessage`），但把复制来的 `dshapi/*` 的路由签名改掉会让上游更新无法三方 diff。折中：复制层零改动，替身在 `src/dispatcher.ts` 一处收敛。`CaptureResponse` 必须是真 `Writable`，因为 `files.ts` / `skills.ts` 会 `createReadStream(...).pipe(res)` |
| 4 | 配置分 `deploy` / `user` / `env` 三层，`/admin/config` 逐字段返回 `{effective, source, locked}` | 三层为 **默认值 → 插件行 config → 设置页覆盖**；`/admin/status` 返回 `effective` 与掩码后的值，不返回逐字段来源 | 逐字段来源需要给每个字段维护一张来源表，收益（排查“改了没生效”）在只有三层时很小；`homeDir` 是唯一的例外，已用「只读 + 文档说明」处理 |
| 5 | 工具目录 grouped = 18 | grouped = **16**（`CAPABILITIES` 共 **35**） | 提案写于能力表定稿前；实际按 8 个能力域合并，且 `system.status`/`providers`/`presets` 等只读域各占一个工具 |
| 6 | 错误码体系 `DSH_XZ_1005 TIMEOUT_PARTIAL` 等结构化码 | 直接返回**可朗读的中文说明**；内部用 `InvokeError.status` | 语音端只能听到文本，结构化码对模型没有增量信息；保留 HTTP 语义状态码供日志与测试断言 |
| 7 | 连接状态机 `disabled → idle → connecting → handshaking → syncing → ready ⇄ degraded → closing → backoff` | 简化为 `disconnected / connecting / connected / retrying / error / listening` | 状态机的价值在**可观测与可测试**；六个状态足够覆盖设置页与重连测试，且每个状态都有对应测试断言 |
| 8 | 401/403 或 close 4401/4403 → `fatal` 且停止重连 | 所有失败都按退避重连，错误写入状态与日志 | 接入点 token 会过期后重签，永久停止反而需要用户手动重启插件；把“不重连”做成不可逆行为风险更高 |

## 仍然成立、且已落实的提案

* **能力表单一事实源**：`src/capabilities.ts` 是唯一事实源，REST 面与两种工具编织都从它派生；
  `test/coverage.test.mjs` 逐条钉住 35 个接口，防止两面漂移。
* **SSE → 可拉取降级**：`sessions.events` 用有限时间窗、`promptStream` 收集完整流后返回；
  语义降级在 [../TOOLS.md](../TOOLS.md) §5 与两份 README 的 “MCP 语义降级” 一节公开说明。
* **grouped 工具面**：默认 16 个工具而非 35 个，理由是语音模型的工具选择准确率。
* **可选依赖用 `ctx.get()` 而非硬 `inject`**：`connection` 服务只在存在时参与鉴权判定。
* **设置页视觉锚点与主题令牌**：页面只用 `--dsw-alias-*`，不 import `dsh-client-ui-primitives`。

## 提案中标记为「待实测」而仍未实测的部分

以下属于**已知未知**，代码按兼容分支处理，但没有真实平台验证：

* 小智平台侧 `tools/call` 的超时值；本插件用 `promptTimeoutMs`（默认 120 s）自保。
* 平台是否支持 MCP progress notification；当前一律一次性返回结果。
* 官方 MCP 接入点的令牌续签策略；当前按退避无限重连。

> 文档内的相对链接（例如 `settings-ux-walkthrough.md` 里引用 `docs/architecture-adr.md`）
> 在本次移动后指向同一目录下的文件，路径前缀 `docs/` 已成为多余但不会误导。
