# 贡献指南 / Contributing

欢迎提交 issue 和 Pull Request。本文件讲「怎么搭开发环境、改完怎么验证、PR 有什么要求」。
安装与排障见 [INSTALL.md](./INSTALL.md)，设计说明见 [README.zh.md](./README.zh.md)。

Issues and pull requests are welcome. This guide covers the dev setup, how to verify a
change, and what a PR is expected to include. For installing and troubleshooting see
[INSTALL.md](./INSTALL.md); for design notes see [README.md](./README.md).

---

## 1. 开发环境 / Prerequisites

| 项 | 要求 / Requirement |
| --- | --- |
| Node.js | ≥ 18（`node --test` 与 ESM）/ ≥ 18 (for `node --test` and ESM) |
| DSH Web | 一个能跑 `dsh web` 的环境，用于手工验证 / a running `dsh web` for manual verification |
| DSH 源码 checkout | **改源码必需**：`scripts/build.sh` 用它提供的 `tsc` 编译并软链类型依赖；通过 `DSH_CHECKOUT` 环境变量指定，或放在 `~/deepseek-harness` 等常见路径 / **required to build**: `scripts/build.sh` compiles with the checkout's `tsc` and links type dependencies; set `DSH_CHECKOUT` or place it at a common path |
| 外部依赖 | 运行时仅 Node 内置模块，无 `ws` 等第三方包 / runtime uses only Node built-ins, no third-party packages |

```bash
git clone https://github.com/<your-fork>/dsh-xiaozhi.git
cd dsh-xiaozhi
export DSH_CHECKOUT=/path/to/deepseek-harness   # 一次性 / once per shell
npm run build                                    # 编译 src → lib 并链接依赖 / compiles and links deps
```

## 2. 开发循环 / The dev loop

```bash
npm run build        # src/ → lib/（构建依赖链接也在这一步完成）
npm run typecheck    # tsc --noEmit
npm test             # node --test，全部用例 / full suite
```

本地装载 / local install（任选其一 / either works）：

```bash
# 方式 A：DSH Web「设置 → 插件」→ 从本地目录安装（选中本仓库）
# / DSH Web Settings → Plugins → install from this local directory
#
# 方式 B：软链进 profile（改码后只需重跑 build）
# / symlink into the profile (re-run build after edits)
ln -s "$PWD" ~/.dsh/profiles/web/node_modules/dsh-xiaozhi
```

**注意：改完代码必须重启 DSH Web 进程才生效**（ESM 模块缓存；设置页的 Save and reload
只重载 runtime 配置，不重载模块代码）。

**Heads-up: changes only load after restarting the `dsh web` process** (ESM module cache;
"Save and reload" on the settings page reloads runtime config, not module code).

## 3. 代码导览 / Code tour

| 位置 | 职责 / What lives there |
| --- | --- |
| `src/tools.ts` + `src/capabilities.ts` | 16 个语音工具的声明与能力层（短 ID 解析 `resolveRef` 在这里）/ the 16 voice tools and the capability layer (`resolveRef` short-id resolution) |
| `src/mcp-server.ts` + `src/protocol.ts` | MCP 会话状态机与 JSON-RPC 2.0 编解码 / MCP session state machine and JSON-RPC 2.0 codec |
| `src/transports.ts` + `src/ws.ts` | 出站（拨向小智接入点）与入站传输；WebSocket 客户端仅用 Node 内置 / outbound (dial the Xiaozhi access point) and inbound transports; WebSocket on Node built-ins only |
| `src/dispatcher.ts` + `src/dshapi/` | 工具调用 → 本地 REST 路由分发；`dshapi/` 是 DSH Web 接口的进程内副本 / tool-call dispatch to the in-process REST route copies |
| `src/admin.ts` + `client/` | DSH Web 设置页（服务端 API + 浏览器半边）/ the DSH Web settings page (server API + browser half) |
| `test/` | `node:test` 套件，含仿真小智 MCP 会话 / `node:test` suite incl. a simulated Xiaozhi MCP session |
| `docs/TOOLS.md` | 工具参考，**改工具表面必须同步** / tool reference — **keep in sync when a tool surface changes** |
| `docs/design/` | 落地前的设计提案存档 / archived pre-implementation design proposals |

## 4. PR 检查清单 / PR checklist

提交前请确认 / before opening a PR:

- [ ] `npm run build && npm run typecheck && npm test` 全绿 / all green
- [ ] 新行为有对应测试用例 / new behavior comes with tests
- [ ] 改了工具表面（增删工具、参数、返回）→ 同步 `docs/TOOLS.md` 与两份 README /
      changed a tool surface → update `docs/TOOLS.md` and both READMEs
- [ ] 改了设置页文案 → `locale/en.json` 与 `locale/zh.json` 同步更新 /
      changed settings-page copy → update both `locale/en.json` and `locale/zh.json`
- [ ] 不引入新的运行时依赖 / no new runtime dependencies
- [ ] 不提交 `lib/` 之外的构建产物、`settings.json`、日志 /
      no build artifacts, `settings.json`, or logs

分支命名与提交信息沿用 Conventional Commits（`feat:` / `fix:` / `docs:` …），PR 指向
`main`。

Branches and commit messages follow Conventional Commits (`feat:` / `fix:` / `docs:` …);
PRs target `main`.

## 5. 报 issue / Reporting issues

请带上：DSH Web 版本、插件版本（`package.json` 的 `version`）、设备接入点模式
（outbound/inbound）、设置页「日志」tab 的相关片段（注意先抹掉接入点地址里的
token）。破坏性写操作类工具的问题，请说明复现步骤。

Please include: the DSH Web version, the plugin version (`version` in `package.json`),
the transport mode (outbound/inbound), and excerpts from the settings page's **Log** tab
(redact the token inside the access-point URL first). For tools with side effects,
include exact reproduction steps.

---

许可证为 BSD-3-Clause；提交即表示同意以该许可证发布你的贡献。
The project is BSD-3-Clause; submitting a PR means you agree to license your
contribution under it.
