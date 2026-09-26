# 安装与验证 / Install and verify

本文件只讲「怎么装、怎么确认真的能用、出问题怎么查」。设计说明见 [README.zh.md](./README.zh.md)。

This file covers installing, confirming it actually works, and diagnosing failures.
Design notes live in [README.md](./README.md).

---

## 1. 前置条件 / Requirements

| 项 | 要求 |
| --- | --- |
| DSH | 已运行 `dsh web`（默认 `http://127.0.0.1:3080`），profile 建议 `web` |
| 小智 | 有账号，能打开「MCP 接入点」页面复制 WebSocket 地址 |
| 构建 | 仅安装则**不需要**；改源码时需要 DSH 源码 checkout 提供 `tsc` |
| 运行时依赖 | 仅 Node 内置模块（**不依赖** `ws`、也**不依赖** `@dsh-external/dsh-web-service`） |

---

## 2. 安装 / Install

```bash
# 方式 A：CLI
dsh plugin add https://github.com/toddpan/dsh-xiaozhi

# 方式 B：在 DSH Web「设置 → 插件」中选择该目录安装
```

安装后确认：

```bash
dsh --profile "$DSH_PROFILE" --dump-config | grep -A2 xiaozhi
```

`install_bundle` / `plugin add` 的结果里 `application: applied` 表示**已生效**；
`restart-required` 表示需要重启才会加载新代码（替换已安装包时常见）。

---

## 3. 配置 / Configure

1. 打开 DSH Web →「设置 → **小智接入**」。
2. 「接入配置」页签：
   * 点「**添加设备**」，粘贴小智的 **MCP 接入点地址**（`wss://api.xiaozhi.me/mcp/?token=…`）；
     可以添加多行，**同时绑定多台小智设备/智能体**（每台可单独「重连」「测试」）。
   * 需要的话设置 `serverToken`（仅 `server` 模式 + 独立端口时需要）。
   * 用「工具组开关」关掉暂时不用的域。
3. 点「保存并重载」。

---

## 4. 验证清单 / Verification checklist

按顺序做完这几条，就能确认「真的接通了」，而不是「装上了」：

| # | 做什么 | 期望看到 |
| --- | --- | --- |
| 1 | 「状态」页签 | 连接状态徽标为 `connected`；多台设备时每台一行，各自显示状态 |
| 2 | 点「测试连接」 | 返回成功，且日志里出现一次完整的 initialize 握手 |
| 3 | 小智 App 的 MCP 工具列表 | 出现 16 个 `dsh_*` 工具（grouped 默认） |
| 4 | 对小智说「让 DSH 汇报运行状态」 | 语音播报 DSH 状态摘要（端口、会话数等） |
| 5 | 设置页把 `allowWriteTools` 关掉并保存 | 「工具清单」里写入类动作被拒绝并返回中文说明，只读仍可用 |
| 6 | 拔网线/断网 10 秒再恢复（endpoint 模式） | 「重连次数」增加，状态回到 `connected`（状态页 3 秒自动刷新） |
| 7 | 设置页切到浅色/深色主题 | 页面配色跟随宿主，无硬编码色块 |

命令行侧的自检（不依赖小智）：

```bash
cd dsh-xiaozhi
bash scripts/build.sh
node --test --test-timeout=30000 "test/*.test.mjs"     # 期望：127 个用例全部通过 / 0 fail
```

---

## 5. 排查 / Troubleshooting

| 现象 | 排查 |
| --- | --- |
| 状态 `disconnected` | 「日志」页看第一条错误；接入点必须 `ws://`/`wss://`、含 `/mcp/`、不含 `key`/`call` |
| 小智看不到工具 | `enabled=false`？所有工具组都被关了？ |
| 工具在但调用失败 | `allowWriteTools` 关掉了写操作；返回文本里有原因 |
| 局域网自建小智连不上 | `server` 模式 `serverPort=0` 时只监听 DSH 服务器（默认仅本机）；填端口并设 `serverToken` |
| 想改 `homeDir` | 只能在插件行 `config` 里改，或设 `DSH_XIAOZHI_HOME`；设置页只读展示 |
| 想删 `endpointHeaders` 里某一项 | 设置页只能新增/覆盖；手工编辑 `<homeDir>/settings.json` |
| 改了 `apiPathPrefix` 设置页没反应 | 预期行为：设置页 API 固定在 `/dsh-xiaozhi/admin` |

### 直接访问内置 REST 层自检

```bash
# 未设置 apiKey 时
curl -s http://127.0.0.1:3080/dsh-xiaozhi/api/v1/system/status | head -c 400

# 设置了 apiKey 时
curl -s -H "Authorization: Bearer $KEY" \
     http://127.0.0.1:3080/dsh-xiaozhi/api/v1/system/status | head -c 400
```

设置页 API 需要 CSRF 头，因此不能用浏览器地址栏直接打开：

```bash
curl -s -H 'x-dsh-xiaozhi-admin: 1' http://127.0.0.1:3080/dsh-xiaozhi/admin/status | head -c 400
```

---

## 6. 卸载 / Uninstall

```bash
dsh plugin remove dsh-xiaozhi
```

插件写入的覆盖配置在 `$DSH_HOME/dsh-xiaozhi/settings.json`（或 `$DSH_XIAOZHI_HOME`），
卸载不会自动删除，需要时手工清理。

## 验证小智接入点（不改动运行中的 DSH）

设置页保存地址之前/之后，都可以用这个脚本对真实接入点做一次完整的 MCP 握手验证：

```bash
# 用已保存的地址（$DSH_HOME/dsh-xiaozhi/settings.json）
node scripts/probe-endpoint.mjs

# 或者直接指定地址
node scripts/probe-endpoint.mjs 'wss://api.xiaozhi.me/mcp/?token=<你的 token>'
```

脚本会：校验地址 → 拨号连接 → 由插件**自身的** `McpSession` 应答小智 broker 的
`initialize` → 等待 broker 拉取 `tools/list`。Token 全程只以 `<redacted>` 形式回显。

退出码 `0` 表示握手完成且工具清单已被拉取；`1` 表示失败（原因写在 stderr）。
