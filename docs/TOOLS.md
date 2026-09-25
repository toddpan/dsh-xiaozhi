# dsh-xiaozhi 工具清单 / Tool reference

> 由 `src/tools.ts` 与 `src/capabilities.ts` 生成，改代码后请同步本文件。
> Generated from the code; update this file when the tables change.

- 能力总数 / capabilities: **35**（8 个能力域）
- `grouped`（默认）暴露 **16** 个工具 · `flat` 暴露 **35** 个工具
- 所有工具名都是小智清洗规则 `re.sub(r"[^a-zA-Z0-9_\-\u4e00-\u9fff]", "_", name)` 的**不动点**

---

## 1. grouped 模式（默认，16 个工具）

每个工具用 `action` 参数选择动作。`写` = 含写入动作（受 `allowWriteTools` 约束）。

| 工具 | 类型 | 能力域 | 覆盖能力 |
| --- | --- | --- | --- |
| `dsh_status` | 读 | system | `system.status` |
| `dsh_workspaces` | 写 | workspaces | `workspaces.list` `workspaces.get` `workspaces.create` `workspaces.update` `workspaces.delete` `workspaces.sessions` |
| `dsh_sessions` | 写 | sessions | `sessions.list` `sessions.get` `sessions.create` `sessions.update` `sessions.delete` `sessions.cancel` |
| `dsh_session_progress` | 读 | sessions | `sessions.stats` `sessions.todos` |
| `dsh_session_history` | 读 | sessions | `sessions.history` |
| `dsh_session_skills` | 读 | sessions | `sessions.skills` |
| `dsh_session_watch` | 读 | sessions | `sessions.events`（有限时间窗） |
| `dsh_questions` | 写 | sessions | `sessions.questions` `sessions.answers` |
| `dsh_session_files` | 写 | files | `files.list` `files.download` `files.upload` |
| `dsh_say` | 写 | conversation | `conversation.prompt` `conversation.promptStream` |
| `dsh_chat` | 写 | conversation | `conversation.chat` |
| `dsh_models` | 写 | models | `models.list` `models.default` `models.setDefault` |
| `dsh_providers` | 读 | models | `models.providers` |
| `dsh_presets` | 读 | models | `models.presets` |
| `dsh_settings` | 写 | settings | `settings.get` `settings.patch` |
| `dsh_docs` | 读 | docs | `docs.info` `docs.openapi` |

> 当一个工具同时含读和写动作、而 `allowWriteTools=false` 时，工具**保留**，只有写动作被拒绝，
> 描述里会追加关闭写入的提示。

---

## 2. flat 模式（35 个工具）

工具名 = `dsh_<域>_<动作>`，与接口一一对应。

| 工具 | 类型 | 能力 |
| --- | --- | --- |
| `dsh_system_status` | 读 | `system.status` |
| `dsh_workspaces_list` | 读 | `workspaces.list` |
| `dsh_workspaces_get` | 读 | `workspaces.get` |
| `dsh_workspaces_create` | 写 | `workspaces.create` |
| `dsh_workspaces_update` | 写 | `workspaces.update` |
| `dsh_workspaces_delete` | 写 | `workspaces.delete` |
| `dsh_workspaces_sessions` | 读 | `workspaces.sessions` |
| `dsh_sessions_list` | 读 | `sessions.list` |
| `dsh_sessions_get` | 读 | `sessions.get` |
| `dsh_sessions_create` | 写 | `sessions.create` |
| `dsh_sessions_update` | 写 | `sessions.update` |
| `dsh_sessions_delete` | 写 | `sessions.delete` |
| `dsh_sessions_history` | 读 | `sessions.history` |
| `dsh_sessions_stats` | 读 | `sessions.stats` |
| `dsh_sessions_todos` | 读 | `sessions.todos` |
| `dsh_sessions_skills` | 读 | `sessions.skills` |
| `dsh_sessions_questions` | 读 | `sessions.questions` |
| `dsh_sessions_answers` | 写 | `sessions.answers` |
| `dsh_sessions_cancel` | 写 | `sessions.cancel` |
| `dsh_sessions_events` | 读 | `sessions.events` |
| `dsh_files_list` | 读 | `files.list` |
| `dsh_files_download` | 读 | `files.download` |
| `dsh_files_upload` | 写 | `files.upload` |
| `dsh_conversation_prompt` | 写 | `conversation.prompt` |
| `dsh_conversation_promptstream` | 写 | `conversation.promptStream` |
| `dsh_conversation_chat` | 写 | `conversation.chat` |
| `dsh_models_list` | 读 | `models.list` |
| `dsh_models_default` | 读 | `models.default` |
| `dsh_models_setdefault` | 写 | `models.setDefault` |
| `dsh_models_providers` | 读 | `models.providers` |
| `dsh_models_presets` | 读 | `models.presets` |
| `dsh_settings_get` | 读 | `settings.get` |
| `dsh_settings_patch` | 写 | `settings.patch` |
| `dsh_docs_info` | 读 | `docs.info` |
| `dsh_docs_openapi` | 读 | `docs.openapi` |

---

## 3. 能力域与接口对照 / Areas and endpoints

`disabledGroups` 与「工具组开关」使用的就是下表的 key：

| key | 名称 | 能力数 |
| --- | --- | --- |
| `system` | 系统状态 | 1 |
| `workspaces` | 工作区 | 6 |
| `sessions` | 会话 | 13 |
| `conversation` | 对话 | 3 |
| `files` | 文件 | 3 |
| `models` | 模型与预设 | 5 |
| `settings` | 系统设置 | 2 |
| `docs` | 接口文档 | 2 |

逐条对照：

| 能力 | 接口 | 类型 | 说明 |
| --- | --- | --- | --- |
| `system.status` | `GET /system/status` | 读 | DSH 运行状态、端口、工作区数量、可用模型、MCP 连接状态 |
| `workspaces.list` | `GET /workspaces` | 读 | 查询工作区列表 |
| `workspaces.get` | `GET /workspaces/:id` | 读 | 获取工作区详情 |
| `workspaces.create` | `POST /workspaces` | 写 | 创建工作区（绑定目录） |
| `workspaces.update` | `PUT /workspaces/:id` | 写 | 修改工作区标题 |
| `workspaces.delete` | `DELETE /workspaces/:id` | 写 | 删除工作区绑定（不删除磁盘目录） |
| `workspaces.sessions` | `GET /workspaces/:id/sessions` | 读 | 查询工作区下的会话 |
| `sessions.list` | `GET /sessions` | 读 | 查询会话列表（支持搜索与工作区过滤） |
| `sessions.get` | `GET /sessions/:id` | 读 | 查询单个会话详情与运行状态 |
| `sessions.create` | `POST /sessions` | 写 | 创建新会话 |
| `sessions.update` | `PUT /sessions/:id` | 写 | 修改会话标题或模型 |
| `sessions.delete` | `DELETE /sessions/:id` | 写 | 删除／归档会话 |
| `sessions.history` | `GET /sessions/:id/history` | 读 | 分页查询会话历史消息 |
| `sessions.stats` | `GET /sessions/:id/stats` | 读 | 会话实时统计：轮/步、耗时、首 token、吞吐、token 账本 |
| `sessions.todos` | `GET /sessions/:id/todos` | 读 | 会话任务清单与运行时长 |
| `sessions.skills` | `GET /sessions/:id/skills` | 读 | 会话作用域技能目录 |
| `sessions.questions` | `GET /sessions/:id/questions` | 读 | 查询会话当前挂起的提问批次 |
| `sessions.answers` | `POST /sessions/:id/answers` | 写 | 回答会话挂起的问题，会话继续运行 |
| `sessions.cancel` | `POST /sessions/:id/cancel` | 写 | 中止会话当前轮次 |
| `sessions.events` | `GET /sessions/:id/events` | 读 | 时间窗内的事件流（SSE 有限窗口降级） |
| `files.list` | `GET /sessions/:id/files` | 读 | 列出会话工作区目录 |
| `files.download` | `GET /sessions/:id/files/download` | 读 | 下载文件（文本回传正文，二进制回传摘要） |
| `files.upload` | `POST /sessions/:id/files` | 写 | 上传文件到会话工作区 |
| `conversation.prompt` | `POST /sessions/:id/prompt` | 写 | 发送提示词并同步等待整轮结果 |
| `conversation.promptStream` | `POST /sessions/:id/prompt-stream` | 写 | 流式对话（MCP 上收集完整流后一次返回） |
| `conversation.chat` | `POST /chat/completions` | 写 | OpenAI 兼容一次性对话 |
| `models.list` | `GET /models` | 读 | 可用模型清单与默认模型 |
| `models.default` | `GET /models/default` | 读 | 全局默认模型 |
| `models.setDefault` | `PUT /models/default` | 写 | 更新全局默认模型 |
| `models.providers` | `GET /providers` | 读 | 已注册的 LLM 提供商 |
| `models.presets` | `GET /presets` | 读 | 可用 Agent Preset 清单 |
| `settings.get` | `GET /settings` | 读 | 读取系统设置命名空间 |
| `settings.patch` | `PATCH /settings/:namespace` | 写 | 按命名空间更新系统设置 |
| `docs.info` | `GET /docs` | 读 | 交互式 API 文档入口地址 |
| `docs.openapi` | `GET /openapi.json` | 读 | OpenAPI 3.0 规范（返回结构摘要） |

---

## 4. 语音端返回格式 / Voice-facing result shape

每个工具返回**单个** `text` 块，按 `maxVoiceChars` 截断：

* 列表类：`- 标题 [短id] 状态 · 相对时间`
* 详情类：`字段：值` 逐行
* 错误类：可直接朗读的中文说明（例如「写入类工具已关闭（allowWriteTools=false）」）
* id 会被缩短到前 8 位左右（如 `sess-1234abcd-5678` → `sess-123`），方便语音复述；
  用完整 id 或名称调用也都能被接受。

## 5. 降级提醒 / Degradation notes

| 能力 | MCP 行为 |
| --- | --- |
| `conversation.promptStream` | 服务端收集完整个流后一次性返回；`promptTimeoutMs` 为等待上限，超时返回「已提交、仍在运行」 |
| `sessions.events` | 仅收集 1–30 秒（由 `seconds` 参数决定）后返回，不是常驻订阅 |
| `files.download` | 文本回传正文（截断）；二进制只回传摘要 |
| `docs.openapi` | 返回结构摘要；完整规范请访问 `apiBase/openapi.json` |
