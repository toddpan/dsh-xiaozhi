/**
 * dsh-xiaozhi - DSH Web settings page (browser half).
 *
 * Plain JavaScript loaded by the DSH module table: `require('react')` is the
 * only dependency it may take, and styling uses only `--dsw-alias-*` theme
 * tokens so the page follows light/dark without any theme detection here.
 *
 * It registers one entry in the `settings.section` slot. The Host half serves
 * the API it calls at a **fixed** path; see `ADMIN_BASE` below.
 */

window.__ModuleLoader__.load({
  id: 'dsh-xiaozhi',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Must stay identical to `ADMIN_BASE` in src/shared.ts and to
     * `ADMIN_CSRF_HEADER`. A client bundle cannot import a Host module, so the
     * literals are mirrored; test/client-contract.test.mjs fails on drift.
     */
    const ADMIN_BASE = '/dsh-xiaozhi/admin'
    const CSRF_HEADER = 'x-dsh-xiaozhi-admin'

// Mirrors CONNECTION_TONES in src/shared.ts. Keep both in step: a state the
// page does not know about used to fall through to the error tone, which is
// how a healthy connection once rendered as a red "ready" badge.
const CONNECTION_TONES = {
  ready: 'ok',
  connecting: 'warn',
  idle: 'idle',
  disabled: 'idle',
  error: 'bad',
}

    const NS = 'dsh-xiaozhi'

    //#region dictionaries
    const zh = {
      nav: '小智接入',
      title: '小智语音接入（MCP）',
      subtitle: '把小智语音助手接入 DSH：DSH 作为 MCP 工具提供方，小智通过语音调用工作区、会话、模型等能力。',
      'tab.status': '状态',
      'tab.connect': '接入配置',
      'tab.tools': '工具清单',
      'tab.caps': '能力清单',
      'tab.logs': '日志',
      refresh: '刷新',
      save: '保存并重载',
      saving: '保存中…',
      saved: '已保存并重载',
      reset: '恢复默认',
      resetConfirm: '确定清除本插件保存的所有覆盖配置，恢复默认值？',
      copy: '复制',
      copied: '已复制',
      loading: '加载中…',
      loadFailed: '加载失败',
      retry: '重试',
      unknown: '未知',
      none: '无',
      yes: '是',
      no: '否',
      write: '写',
      read: '读',
      'status.connection': '连接状态',
      'status.pluginVersion': '插件版本',
      'status.settingsFile': '覆盖配置文件',
      'status.uptime': 'DSH 进程运行时长',
      'status.stateRaw': '协议状态',
      'status.mode': '传输模式',
      'status.state': '状态',
      'status.endpoint': '接入点',
      'status.clients': '已连接小智客户端',
      'status.reconnects': '重连次数',
      'status.lastError': '最近错误',
      'status.lastConnected': '最近连接时间',
      'status.tools': '暴露工具数',
      'status.covered': '覆盖能力',
      'status.warnings': '需要注意',
      'status.noWarnings': '没有发现问题。',
      'status.paths': '对外地址',
      'status.adminApi': '设置页 API',
      'status.apiBase': '内置 DSH REST 层',
      'status.docs': '接口文档',
      'status.openapi': 'OpenAPI 描述',
      'status.test': '测试连接',
      'status.testing': '测试中…',
      'status.reconnect': '立即重连',
      'status.groupEnabled': '已启用',
      'status.groupDisabled': '已关闭',
      'connect.basics': '基础设置',
      'connect.advanced': '高级设置',
      'connect.groups': '工具组开关',
      'connect.groupsHint': '关闭暂时用不到的工具组可以减少暴露给语音模型的工具数量，提高选择准确率。',
      'connect.homeDirReadonly': '覆盖配置文件位置（由插件本行配置决定）',
      'connect.headersInvalid': 'endpointHeaders 必须是 JSON 对象，例如 {"Authorization":"Bearer xxx"}',
      'connect.numberInvalid': '「{field}」必须是数字。',
      'connect.saved': '已保存并重载插件。',
      'connect.resetDone': '已恢复默认配置。',
      'connect.enabled': '启用插件',
      'state.ready': '已连接',
      'state.connecting': '连接中',
      'state.idle': '未连接',
      'state.disabled': '已关闭',
      'state.error': '连接异常',
      'connect.enabled.hint': '关闭后小智将无法调用任何工具。',
      'connect.mode': '传输模式',
      'connect.mode.hint': 'endpoint：DSH 主动连接小智的 MCP 接入点（推荐）。server：DSH 自己提供 MCP 服务端，供自建小智服务连接。',
      'connect.opt.mode.endpoint': 'endpoint（主动外连）',
      'connect.opt.mode.server': 'server（自建服务端）',
      'connect.endpointUrl': '小智 MCP 接入点地址',
      'connect.endpointUrl.hint': '小智 App/后台「MCP 接入点」里的 WebSocket 地址，形如 wss://api.xiaozhi.me/mcp/?token=…',
      'connect.endpointHeaders': '接入点附加请求头',
      'connect.endpointHeaders.hint': 'JSON 对象。已保存的值显示为 ••••••，留空表示不修改；删除某个请求头需手工编辑 settings.json。',
      'connect.serverPath': '服务端路径',
      'connect.serverPath.hint': 'server 模式下小智连接 DSH Web 服务器使用的路径。',
      'connect.serverPort': '独立监听端口',
      'connect.serverPort.hint': '0 表示只复用 DSH Web 服务器（默认仅本机可访问）；填写端口号会在 0.0.0.0 上额外监听。',
      'connect.serverToken': '服务端口令',
      'connect.serverToken.hint': '连接时需在请求头或查询串中携带，防止局域网内任意客户端接入。',
      'connect.toolMode': '工具暴露方式',
      'connect.toolMode.hint': 'grouped：按能力域合并成少量工具（推荐，语音模型更易选对）。flat：每个接口一个工具。',
      'connect.opt.toolMode.grouped': 'grouped（按能力域合并）',
      'connect.opt.toolMode.flat': 'flat（每个接口一个工具）',
      'connect.allowWriteTools': '允许写入类操作',
      'connect.allowWriteTools.hint': '关闭后创建/修改/删除/发送类工具会拒绝执行，只保留查询能力。',
      'connect.promptTimeoutMs': '语音指令等待上限（毫秒）',
      'connect.promptTimeoutMs.hint': '小智提交一句话后最多等待多久返回结果，超时仍有语音播报。',
      'connect.maxVoiceChars': '单条回复字数上限',
      'connect.maxVoiceChars.hint': '工具结果会截断到这个长度，避免语音播报过长。',
      'connect.listLimit': '列表返回条数',
      'connect.listLimit.hint': '工作区/会话等列表最多返回多少条。',
      'connect.heartbeatMs': '心跳间隔（毫秒）',
      'connect.heartbeatMs.hint': 'endpoint 模式下发送 ping 的间隔，用于保持连接。',
      'connect.reconnectMinMs': '重连最小间隔（毫秒）',
      'connect.reconnectMinMs.hint': '断线后首次重连等待时间，之后按指数退避。',
      'connect.reconnectMaxMs': '重连最大间隔（毫秒）',
      'connect.reconnectMaxMs.hint': '退避的上限。',
      'connect.serverName': '服务端名称',
      'connect.serverName.hint': 'server 模式下向小智声明的服务名。',
      'connect.defaultCwd': '默认工作目录',
      'connect.defaultCwd.hint': 'REST 层创建会话时的默认目录，留空表示使用 DSH 默认值。',
      'connect.apiPathPrefix': 'REST 层路径前缀',
      'connect.apiPathPrefix.hint': '内置 DSH Web REST 层的挂载前缀。设置页 API 固定在 /dsh-xiaozhi/admin，不受此值影响。',
      'connect.exposeDshApi': '暴露内置 DSH REST 层',
      'connect.exposeDshApi.hint': '在插件路径下挂载一份 DSH Web REST 接口，方便外部工具直接调用。',
      'connect.apiKey': 'REST 层 API Key',
      'connect.apiKey.hint': '内置 REST 层的鉴权密钥；留空表示不鉴权（不建议）。',
      'connect.cors': '允许跨域访问 REST 层',
      'connect.cors.hint': '仅在内置 REST 层需要被浏览器跨域调用时开启。',
      'connect.maxUploadBytes': '单次上传上限（字节）',
      'connect.maxUploadBytes.hint': '通过内置 REST 层上传文件的大小上限。',
      'connect.logToolCalls': '记录工具调用日志',
      'connect.logToolCalls.hint': '每次小智调用工具都记一条日志，便于排查。',
      'connect.sendInitializedNotification': '握手后发送 initialized 通知',
      'connect.sendInitializedNotification.hint': '按 MCP 规范在 initialize 之后发送 notifications/initialized。个别平台不需要时可关闭。',
      'tools.title': '当前暴露的工具',
      'tools.summary': '共 {count} 个工具，覆盖 {covered}/{total} 个能力。',
      'tools.name': '工具名',
      'tools.kind': '类型',
      'tools.groups': '能力域',
      'tools.caps': '覆盖能力数',
      'tools.desc': '说明',
      'tools.empty': '当前没有暴露任何工具（所有工具组都被关闭，或插件已停用）。',
      'caps.title': '全部能力与对应接口',
      'caps.summary': '共 {total} 个能力，{exposed} 个已暴露为工具。',
      'caps.id': '能力',
      'caps.route': '接口',
      'caps.kind': '类型',
      'caps.desc': '说明',
      'logs.title': '插件日志',
      'logs.lines': '共 {count} 条',
      'logs.empty': '暂无日志。',
      'logs.auto': '自动刷新（5 秒）',
    }
    const en = {
      nav: 'Xiaozhi',
      title: 'Xiaozhi voice access (MCP)',
      subtitle: 'Connect the Xiaozhi voice assistant to DSH: DSH acts as the MCP tool provider, so Xiaozhi can drive workspaces, sessions and models by voice.',
      'tab.status': 'Status',
      'tab.connect': 'Connection',
      'tab.tools': 'Tools',
      'tab.caps': 'Capabilities',
      'tab.logs': 'Logs',
      refresh: 'Refresh',
      save: 'Save and reload',
      saving: 'Saving…',
      saved: 'Saved and reloaded',
      reset: 'Restore defaults',
      resetConfirm: 'Clear every override this plugin saved and restore the defaults?',
      copy: 'Copy',
      copied: 'Copied',
      loading: 'Loading…',
      loadFailed: 'Failed to load',
      retry: 'Retry',
      unknown: 'unknown',
      none: 'none',
      yes: 'yes',
      no: 'no',
      write: 'write',
      read: 'read',
      'status.connection': 'Connection',
      'status.pluginVersion': 'Plugin version',
      'status.settingsFile': 'Override file',
      'status.uptime': 'DSH process uptime',
      'status.stateRaw': 'Protocol state',
      'status.mode': 'Transport',
      'status.state': 'State',
      'status.endpoint': 'Access point',
      'status.clients': 'Connected Xiaozhi clients',
      'status.reconnects': 'Reconnects',
      'status.lastError': 'Last error',
      'status.lastConnected': 'Last connected',
      'status.tools': 'Exposed tools',
      'status.covered': 'Capabilities covered',
      'status.warnings': 'Needs attention',
      'status.noWarnings': 'Nothing to report.',
      'status.paths': 'Addresses',
      'status.adminApi': 'Settings API',
      'status.apiBase': 'Bundled DSH REST layer',
      'status.docs': 'API docs',
      'status.openapi': 'OpenAPI description',
      'status.test': 'Test connection',
      'status.testing': 'Testing…',
      'status.reconnect': 'Reconnect now',
      'status.groupEnabled': 'enabled',
      'status.groupDisabled': 'disabled',
      'connect.basics': 'Basics',
      'connect.advanced': 'Advanced',
      'connect.groups': 'Tool groups',
      'connect.groupsHint': 'Disabling groups you do not use shrinks the tool list, which makes the voice model pick the right tool more reliably.',
      'connect.homeDirReadonly': 'Override file location (set by the plugin row config)',
      'connect.headersInvalid': 'endpointHeaders must be a JSON object, e.g. {"Authorization":"Bearer xxx"}',
      'connect.numberInvalid': '"{field}" must be a number.',
      'connect.saved': 'Saved and reloaded the plugin.',
      'connect.resetDone': 'Defaults restored.',
      'connect.enabled': 'Enable plugin',
      'state.ready': 'Connected',
      'state.connecting': 'Connecting',
      'state.idle': 'Idle',
      'state.disabled': 'Disabled',
      'state.error': 'Error',
      'connect.enabled.hint': 'While off, Xiaozhi cannot call any tool.',
      'connect.mode': 'Transport',
      'connect.mode.hint': 'endpoint: DSH dials out to the Xiaozhi MCP access point (recommended). server: DSH serves MCP itself for a self-hosted Xiaozhi server.',
      'connect.opt.mode.endpoint': 'endpoint (dial out)',
      'connect.opt.mode.server': 'server (self-hosted)',
      'connect.endpointUrl': 'Xiaozhi MCP access point',
      'connect.endpointUrl.hint': 'The WebSocket address from the "MCP access point" page of the Xiaozhi app/console, like wss://api.xiaozhi.me/mcp/?token=…',
      'connect.endpointHeaders': 'Extra request headers',
      'connect.endpointHeaders.hint': 'A JSON object. Saved values show as ••••••; leave blank to keep them. Removing a header requires editing settings.json by hand.',
      'connect.serverPath': 'Server path',
      'connect.serverPath.hint': 'Path a Xiaozhi server connects to on the DSH web server in server mode.',
      'connect.serverPort': 'Dedicated listen port',
      'connect.serverPort.hint': '0 reuses the DSH web server (loopback only by default); a port number additionally listens on 0.0.0.0.',
      'connect.serverToken': 'Server token',
      'connect.serverToken.hint': 'Must be presented in a header or query string, so arbitrary LAN clients cannot connect.',
      'connect.toolMode': 'Tool exposure',
      'connect.toolMode.hint': 'grouped: merge capabilities into a few tools (recommended - a voice model picks better). flat: one tool per endpoint.',
      'connect.opt.toolMode.grouped': 'grouped (merge by capability area)',
      'connect.opt.toolMode.flat': 'flat (one tool per endpoint)',
      'connect.allowWriteTools': 'Allow write operations',
      'connect.allowWriteTools.hint': 'While off, create/update/delete/send tools refuse to run and only queries remain.',
      'connect.promptTimeoutMs': 'Voice command wait limit (ms)',
      'connect.promptTimeoutMs.hint': 'How long a spoken command waits for a result before answering anyway.',
      'connect.maxVoiceChars': 'Reply length limit',
      'connect.maxVoiceChars.hint': 'Tool results are clipped to this length so speech stays short.',
      'connect.listLimit': 'List page size',
      'connect.listLimit.hint': 'Maximum rows returned by list capabilities.',
      'connect.heartbeatMs': 'Heartbeat interval (ms)',
      'connect.heartbeatMs.hint': 'Ping interval in endpoint mode, used to keep the connection alive.',
      'connect.reconnectMinMs': 'Reconnect minimum delay (ms)',
      'connect.reconnectMinMs.hint': 'First wait after a drop; later attempts back off exponentially.',
      'connect.reconnectMaxMs': 'Reconnect maximum delay (ms)',
      'connect.reconnectMaxMs.hint': 'Upper bound of the backoff.',
      'connect.serverName': 'Server name',
      'connect.serverName.hint': 'The service name announced to Xiaozhi in server mode.',
      'connect.defaultCwd': 'Default working directory',
      'connect.defaultCwd.hint': 'Directory used when the REST layer creates a session; blank uses the DSH default.',
      'connect.apiPathPrefix': 'REST layer path prefix',
      'connect.apiPathPrefix.hint': 'Mount prefix of the bundled DSH web REST layer. The settings API stays at /dsh-xiaozhi/admin regardless.',
      'connect.exposeDshApi': 'Expose the bundled DSH REST layer',
      'connect.exposeDshApi.hint': 'Mounts a copy of the DSH web REST API under the plugin path for external callers.',
      'connect.apiKey': 'REST layer API key',
      'connect.apiKey.hint': 'Auth key for the bundled REST layer; blank means no auth (not recommended).',
      'connect.cors': 'Allow cross-origin REST calls',
      'connect.cors.hint': 'Enable only when a browser on another origin must call the bundled REST layer.',
      'connect.maxUploadBytes': 'Upload limit (bytes)',
      'connect.maxUploadBytes.hint': 'Largest file upload accepted by the bundled REST layer.',
      'connect.logToolCalls': 'Log tool calls',
      'connect.logToolCalls.hint': 'Record one log line per Xiaozhi tool call, for troubleshooting.',
      'connect.sendInitializedNotification': 'Send initialized notification',
      'connect.sendInitializedNotification.hint': 'Sends notifications/initialized after initialize, as the MCP spec requires. Some platforms do not need it.',
      'tools.title': 'Tools currently exposed',
      'tools.summary': '{count} tools covering {covered}/{total} capabilities.',
      'tools.name': 'Tool',
      'tools.kind': 'Kind',
      'tools.groups': 'Areas',
      'tools.caps': 'Capabilities',
      'tools.desc': 'Description',
      'tools.empty': 'No tool is exposed right now (every group is disabled, or the plugin is off).',
      'caps.title': 'All capabilities and their endpoints',
      'caps.summary': '{total} capabilities, {exposed} exposed as tools.',
      'caps.id': 'Capability',
      'caps.route': 'Endpoint',
      'caps.kind': 'Kind',
      'caps.desc': 'Description',
      'logs.title': 'Plugin log',
      'logs.lines': '{count} lines',
      'logs.empty': 'No log lines yet.',
      'logs.auto': 'Auto refresh (5s)',
    }
    //#endregion

    //#region styles (theme tokens only)
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '16px', color: 'var(--dsw-alias-label-primary)' },
      header: { display: 'flex', flexDirection: 'column', gap: '4px' },
      h1: { fontSize: '16px', fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { fontSize: '12px', lineHeight: 1.6, margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      tabs: { display: 'flex', flexWrap: 'wrap', gap: '6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '8px' },
      tab: {
        appearance: 'none', border: '1px solid transparent', background: 'transparent', cursor: 'pointer',
        borderRadius: '999px', padding: '5px 12px', font: 'inherit', fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      tabActive: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '999px', padding: '5px 12px',
        font: 'inherit', fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '10px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px',
      },
      sectionTitle: { fontSize: '13px', fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '11px', lineHeight: 1.6, margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', fontSize: '12px' },
      rowLabel: { color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 },
      rowValue: { color: 'var(--dsw-alias-label-primary)', textAlign: 'right', wordBreak: 'break-all', fontVariantNumeric: 'tabular-nums' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      input: {
        width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: '12px',
        padding: '6px 9px', borderRadius: '8px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px', padding: '6px 9px', borderRadius: '8px', minHeight: '60px', resize: 'vertical',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      button: {
        appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: '12px', padding: '6px 12px',
        borderRadius: '8px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
      },
      buttonPrimary: {
        appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: '12px', padding: '6px 12px',
        borderRadius: '8px', border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        // A brand fill is artwork, so its foreground may be its own colour; the
        // token set offers no "on-brand" label token.
        color: '#ffffff',
      },
      buttonDisabled: { opacity: 0.6, cursor: 'default' },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: '4px', borderRadius: '999px',
        padding: '1px 8px', fontSize: '11px', border: '1px solid currentColor',
      },
      badgeOk: { color: 'var(--dsw-alias-state-success-primary)' },
      badgeWarn: { color: 'var(--dsw-alias-state-warn-primary)' },
      badgeBad: { color: 'var(--dsw-alias-state-error-primary)' },
      badgeIdle: { color: 'var(--dsw-alias-state-idle-primary)' },
      notice: {
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: '8px', padding: '8px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)',
      },
      noticeBad: { color: 'var(--dsw-alias-state-error-primary)' },
      list: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-state-warn-primary)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: {
        textAlign: 'left', padding: '6px 8px', fontSize: '11px', fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      td: {
        textAlign: 'left', padding: '6px 8px', verticalAlign: 'top',
        borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-primary)',
      },
      pre: {
        margin: 0, padding: '10px', borderRadius: '8px', maxHeight: '420px', overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
      },
      kvGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
    }
    //#endregion

    //#region api
    /** Unwrap `{ok,data}` (or report the error text) from the settings API. */
    function request(path, options) {
      const opts = options || {}
      const headers = { accept: 'application/json' }
      headers[CSRF_HEADER] = '1'
      if (opts.body !== undefined) headers['content-type'] = 'application/json'
      const init = {
        method: opts.method || 'GET',
        headers,
        // Same-origin so the browser attaches whatever cookie the DSH UI uses.
        credentials: 'same-origin',
      }
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
      return fetch(ADMIN_BASE + path, init).then(res =>
        res.text().then(text => {
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = undefined
          }
          if (!res.ok) {
            const message =
              (parsed && (parsed.error || parsed.message)) || (text && text.slice(0, 200)) || 'HTTP ' + res.status
            throw new Error(message)
          }
          if (parsed === undefined) throw new Error('response was not JSON: ' + text.slice(0, 120))
          return parsed && Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed
        }),
      )
    }
    //#endregion

    //#region fields
    /**
     * The editable config surface, declared once and used both to render the
     * form and to build the save patch, so the two can never disagree.
     */
    const FIELDS = [
      { key: 'enabled', kind: 'bool', area: 'basic', label: 'connect.enabled', hint: 'connect.enabled.hint' },
      {
        key: 'mode', kind: 'enum', area: 'basic', label: 'connect.mode', hint: 'connect.mode.hint',
        options: ['endpoint', 'server'],
      },
      {
        key: 'endpointUrl', kind: 'text', area: 'basic', label: 'connect.endpointUrl',
        hint: 'connect.endpointUrl.hint', when: c => c.mode === 'endpoint',
      },
      {
        key: 'endpointHeaders', kind: 'json', area: 'basic', label: 'connect.endpointHeaders',
        hint: 'connect.endpointHeaders.hint', when: c => c.mode === 'endpoint',
      },
      {
        key: 'serverPath', kind: 'text', area: 'basic', label: 'connect.serverPath',
        hint: 'connect.serverPath.hint', when: c => c.mode === 'server',
      },
      {
        key: 'serverPort', kind: 'number', area: 'basic', label: 'connect.serverPort',
        hint: 'connect.serverPort.hint', when: c => c.mode === 'server',
      },
      {
        key: 'serverToken', kind: 'text', area: 'basic', label: 'connect.serverToken',
        hint: 'connect.serverToken.hint', when: c => c.mode === 'server',
      },
      {
        key: 'toolMode', kind: 'enum', area: 'basic', label: 'connect.toolMode', hint: 'connect.toolMode.hint',
        options: ['grouped', 'flat'],
      },
      {
        key: 'allowWriteTools', kind: 'bool', area: 'basic', label: 'connect.allowWriteTools',
        hint: 'connect.allowWriteTools.hint',
      },
      {
        key: 'promptTimeoutMs', kind: 'number', area: 'advanced', label: 'connect.promptTimeoutMs',
        hint: 'connect.promptTimeoutMs.hint',
      },
      {
        key: 'maxVoiceChars', kind: 'number', area: 'advanced', label: 'connect.maxVoiceChars',
        hint: 'connect.maxVoiceChars.hint',
      },
      {
        key: 'listLimit', kind: 'number', area: 'advanced', label: 'connect.listLimit',
        hint: 'connect.listLimit.hint',
      },
      {
        key: 'heartbeatMs', kind: 'number', area: 'advanced', label: 'connect.heartbeatMs',
        hint: 'connect.heartbeatMs.hint', when: c => c.mode === 'endpoint',
      },
      {
        key: 'reconnectMinMs', kind: 'number', area: 'advanced', label: 'connect.reconnectMinMs',
        hint: 'connect.reconnectMinMs.hint', when: c => c.mode === 'endpoint',
      },
      {
        key: 'reconnectMaxMs', kind: 'number', area: 'advanced', label: 'connect.reconnectMaxMs',
        hint: 'connect.reconnectMaxMs.hint', when: c => c.mode === 'endpoint',
      },
      { key: 'serverName', kind: 'text', area: 'advanced', label: 'connect.serverName', hint: 'connect.serverName.hint' },
      { key: 'defaultCwd', kind: 'text', area: 'advanced', label: 'connect.defaultCwd', hint: 'connect.defaultCwd.hint' },
      {
        key: 'exposeDshApi', kind: 'bool', area: 'advanced', label: 'connect.exposeDshApi',
        hint: 'connect.exposeDshApi.hint',
      },
      { key: 'apiPathPrefix', kind: 'text', area: 'advanced', label: 'connect.apiPathPrefix', hint: 'connect.apiPathPrefix.hint' },
      { key: 'apiKey', kind: 'text', area: 'advanced', label: 'connect.apiKey', hint: 'connect.apiKey.hint' },
      { key: 'cors', kind: 'bool', area: 'advanced', label: 'connect.cors', hint: 'connect.cors.hint' },
      {
        key: 'maxUploadBytes', kind: 'number', area: 'advanced', label: 'connect.maxUploadBytes',
        hint: 'connect.maxUploadBytes.hint',
      },
      { key: 'logToolCalls', kind: 'bool', area: 'advanced', label: 'connect.logToolCalls', hint: 'connect.logToolCalls.hint' },
      {
        key: 'sendInitializedNotification', kind: 'bool', area: 'advanced',
        label: 'connect.sendInitializedNotification', hint: 'connect.sendInitializedNotification.hint',
      },
    ]
    const NUMBER_KEYS = FIELDS.filter(f => f.kind === 'number').map(f => f.key)
    const JSON_KEYS = FIELDS.filter(f => f.kind === 'json').map(f => f.key)
    const EDITABLE_KEYS = FIELDS.map(f => f.key).concat(['disabledGroups'])

    /** Draft values are strings for every field the user types into. */
    function toDraft(config) {
      const draft = {}
      for (const field of FIELDS) {
        const value = config[field.key]
        draft[field.key] = field.kind === 'json' ? JSON.stringify(value || {}, null, 0) : value === undefined ? '' : value
      }
      draft.disabledGroups = Array.isArray(config.disabledGroups) ? config.disabledGroups.slice() : []
      return draft
    }

    /** Build the PATCH body, or throw a readable validation error. */
    function toPatch(draft, config, t) {
      const patch = {}
      for (const field of FIELDS) {
        const raw = draft[field.key]
        if (field.kind === 'json') {
          let parsed
          try {
            parsed = raw === '' || raw === undefined ? {} : JSON.parse(raw)
          } catch {
            throw new Error(t('connect.headersInvalid'))
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(t('connect.headersInvalid'))
          }
          patch[field.key] = parsed
          continue
        }
        if (field.kind === 'number') {
          if (raw === '' || raw === undefined || raw === null) continue
          const num = Number(raw)
          if (!Number.isFinite(num)) throw new Error(t('connect.numberInvalid').replace('{field}', t(field.label)))
          patch[field.key] = num
          continue
        }
        patch[field.key] = raw
      }
      const disabled = Array.isArray(draft.disabledGroups) ? draft.disabledGroups : []
      patch.disabledGroups = disabled
      return patch
    }

    /** True when a draft differs from the loaded config (so Save can stay quiet). */
    function isDirty(draft, config) {
      const patch = {}
      for (const key of EDITABLE_KEYS) {
        if (key === 'disabledGroups') continue
        const field = FIELDS.filter(f => f.key === key)[0]
        const raw = draft[key]
        if (field && field.kind === 'json') {
          patch[key] = raw === '' || raw === undefined ? {} : raw
          continue
        }
        if (field && field.kind === 'number') {
          patch[key] = raw === '' || raw === undefined ? undefined : Number(raw)
          continue
        }
        patch[key] = raw
      }
      for (const field of FIELDS) {
        const original = field.kind === 'json' ? JSON.stringify(config[field.key] || {}) : config[field.key]
        const current = patch[field.key]
        if (field.kind === 'number') {
          if (current === undefined) continue
          if (Number(current) !== Number(config[field.key])) return true
          continue
        }
        if (String(current) !== String(original === undefined ? '' : original)) return true
      }
      const before = Array.isArray(config.disabledGroups) ? config.disabledGroups.join(',') : ''
      if ((draft.disabledGroups || []).join(',') !== before) return true
      return false
    }
    //#endregion

    //#region primitives
    function Row(props) {
      return h(
        'div',
        { style: S.row },
        h('span', { style: S.rowLabel }, props.label),
        h('span', { style: props.mono ? Object.assign({}, S.rowValue, S.mono) : S.rowValue }, props.children),
      )
    }

    function Card(props) {
      return h('div', { style: S.card }, props.title ? h('h3', { style: S.sectionTitle }, props.title) : null, props.children)
    }

    function Field(props) {
      const field = props.field
      const value = props.draft[field.key]
      const onChange = event => props.onChange(field.key, event.target.value)
      let control
      if (field.kind === 'bool') {
        control = h(
          'label',
          { style: S.checkboxRow },
          h('input', { type: 'checkbox', checked: value === true, onChange: event => props.onChange(field.key, event.target.checked) }),
          h('span', null, props.t(field.label)),
        )
      } else if (field.kind === 'enum') {
        control = h(
          'div',
          { style: S.actions },
          field.options.map(option =>
            h(
              'button',
              {
                key: option,
                type: 'button',
                style: value === option ? S.tabActive : S.tab,
                onClick: () => props.onChange(field.key, option),
              },
              props.t('connect.opt.' + field.key + '.' + option),
            ),
          ),
        )
      } else if (field.kind === 'json') {
        control = h('textarea', { style: S.textarea, value: value, onChange, spellCheck: false })
      } else if (field.kind === 'number') {
        control = h('input', { type: 'number', style: S.input, value: value, onChange })
      } else {
        control = h('input', { type: 'text', style: S.input, value: value, onChange, spellCheck: false })
      }
      return h(
        'div',
        { style: S.field },
        field.kind === 'bool' ? null : h('span', { style: S.label }, props.t(field.label)),
        control,
        field.hint ? h('p', { style: S.hint }, props.t(field.hint)) : null,
      )
    }

    function Table(props) {
      return h(
        'div',
        { style: { overflowX: 'auto' } },
        h(
          'table',
          { style: S.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              props.columns.map(column => h('th', { key: column.key, style: S.th }, column.title)),
            ),
          ),
          h(
            'tbody',
            null,
            props.rows.map((row, index) =>
              h(
                'tr',
                { key: row.key || index },
                props.columns.map(column =>
                  h(
                    'td',
                    { key: column.key, style: column.mono ? Object.assign({}, S.td, S.mono) : S.td },
                    column.render ? column.render(row) : row[column.key],
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function Notice(props) {
      return h(
        'div',
        { style: props.bad ? Object.assign({}, S.notice, S.noticeBad) : S.notice },
        props.children !== undefined && props.children !== null ? props.children : props.text,
      )
    }
    //#endregion

    //#region sections
    function StatusTab(props) {
      const status = props.status || {}
      const t = props.t
      const transport = status.transport || {}
      // Never assume the envelope shape: a missing `config` used to be a
      // TypeError that blanked the whole tab.
      const config = status.config || {}
      const mode = transport.mode || config.mode || t('unknown')
      const TONE_STYLE = { ok: 'badgeOk', warn: 'badgeWarn', bad: 'badgeBad', idle: 'badgeIdle' }
      let badgeTone = 'badgeIdle'
      let badgeText = t('unknown')
      if (config.enabled === false) {
        badgeTone = 'badgeBad'
        badgeText = t('connect.enabled') + '=' + t('no')
      } else if (transport.state) {
        // An unknown state is treated as a fault, not as health: a state the
        // page has never heard of must never look green.
        const tone = CONNECTION_TONES[transport.state] || 'bad'
        badgeTone = TONE_STYLE[tone] || 'badgeBad'
        badgeText = t('state.' + transport.state) !== 'state.' + transport.state
          ? t('state.' + transport.state)
          : transport.state
      }
      const tools = status.tools || { count: 0, names: [] }
      const caps = props.capabilities || { total: 0 }
      const exposed = tools.names && tools.names.length ? tools.names.length : tools.count
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(
          Card,
          { title: t('status.connection') },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.rowLabel }, t('status.state')),
            h('span', null, h('span', { style: Object.assign({}, S.badge, S[badgeTone]) }, badgeText)),
          ),
          transport.state ? h(Row, { label: t('status.stateRaw'), mono: true }, String(transport.state)) : null,
          h(Row, { label: t('status.mode'), mono: true }, String(mode)),
          h(Row, { label: t('status.endpoint'), mono: true }, String(transport.endpoint || transport.url || config.endpointUrl || t('none'))),
          transport.clients !== undefined ? h(Row, { label: t('status.clients') }, String(transport.clients)) : null,
          transport.reconnectAttempts !== undefined
            ? h(Row, { label: t('status.reconnects') }, String(transport.reconnectAttempts))
            : null,
          transport.lastConnectedAt
            ? h(Row, { label: t('status.lastConnected') }, new Date(transport.lastConnectedAt).toLocaleString())
            : null,
          transport.lastError ? h(Row, { label: t('status.lastError') }, String(transport.lastError)) : null,
          h(
            'div',
            { style: S.actions },
            h(
              'button',
              { type: 'button', style: props.busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button, onClick: props.onReconnect, disabled: props.busy },
              t('status.reconnect'),
            ),
            h(
              'button',
              { type: 'button', style: props.busy ? Object.assign({}, S.button, S.buttonDisabled) : S.button, onClick: props.onTest, disabled: props.busy },
              props.busy ? t('status.testing') : t('status.test'),
            ),
            h('button', { type: 'button', style: S.button, onClick: props.onRefresh }, t('refresh')),
          ),
          props.testResult ? h(Notice, { bad: props.testResult.ok === false, text: props.testResult.message }) : null,
        ),
        h(
          Card,
          { title: t('status.warnings') },
          (status.warnings || []).length === 0
            ? h('p', { style: S.hint }, t('status.noWarnings'))
            : h('ul', { style: S.list }, (status.warnings || []).map((line, index) => h('li', { key: index }, line))),
        ),
        h(
          Card,
          { title: t('status.paths') },
          h(Row, { label: t('status.adminApi'), mono: true }, String((status.paths || {}).adminBase || ADMIN_BASE)),
          h(Row, { label: t('status.apiBase'), mono: true }, String((status.paths || {}).apiBase || '-')),
          h(Row, { label: t('status.docs'), mono: true }, String((status.paths || {}).docsUrl || '-')),
          h(Row, { label: t('status.openapi'), mono: true }, String((status.paths || {}).openApiUrl || '-')),
        ),
        h(
          Card,
          { title: t('status.tools') },
          h(Row, { label: t('status.tools') }, String(tools.count || 0)),
          h(Row, { label: t('status.covered') }, exposed + ' / ' + (caps.total || 0)),
          h(Row, { label: t('status.pluginVersion'), mono: true }, String((status.plugin || {}).version || '-')),
          h(Row, { label: t('status.settingsFile'), mono: true }, String(status.settingsFile || '-')),
          h(Row, { label: t('status.uptime') }, String(status.uptimeSeconds || 0) + 's'),
          h(
            'div',
            { style: S.kvGrid },
            (status.groups || []).map(group =>
              h(
                'div',
                { key: group.group, style: S.row },
                h('span', { style: S.rowLabel }, group.label + ' (' + group.capabilityCount + ')'),
                h(
                  'span',
                  null,
                  h(
                    'span',
                    { style: Object.assign({}, S.badge, group.enabled ? S.badgeOk : S.badgeIdle) },
                    group.enabled ? t('status.groupEnabled') : t('status.groupDisabled'),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function ConnectTab(props) {
      const t = props.t
      const draft = props.draft
      const groups = props.status.groups || []
      const basic = FIELDS.filter(f => f.area === 'basic' && (!f.when || f.when(draft)))
      const advanced = FIELDS.filter(f => f.area === 'advanced' && (!f.when || f.when(draft)))
      const toggleGroup = group => {
        const next = (draft.disabledGroups || []).slice()
        const at = next.indexOf(group)
        if (at === -1) next.push(group)
        else next.splice(at, 1)
        props.onChange('disabledGroups', next)
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, { title: t('connect.basics') }, basic.map(field => h(Field, { key: field.key, field, draft, t, onChange: props.onChange }))),
        h(
          Card,
          { title: t('connect.groups') },
          h('p', { style: S.hint }, t('connect.groupsHint')),
          h(
            'div',
            { style: S.kvGrid },
            groups.map(group =>
              h(
                'label',
                { key: group.group, style: S.checkboxRow },
                h('input', {
                  type: 'checkbox',
                  checked: !(draft.disabledGroups || []).includes(group.group),
                  onChange: () => toggleGroup(group.group),
                }),
                h('span', null, group.label + '（' + group.capabilityCount + '）'),
              ),
            ),
          ),
        ),
        h(
          'details',
          { style: { display: 'flex', flexDirection: 'column' } },
          h('summary', { style: { cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('connect.advanced')),
          h(
            'div',
            { style: { marginTop: '10px' } },
            h(
              Card,
              null,
              advanced.map(field => h(Field, { key: field.key, field, draft, t, onChange: props.onChange })),
              // Read-only on purpose: homeDir picks where the override file
              // itself lives, so it can only come from the plugin row config.
              h(Row, { label: t('connect.homeDirReadonly'), mono: true }, String((props.status || {}).settingsFile || '-')),
            ),
          ),
        ),
        h(
          'div',
          { style: S.actions },
          h(
            'button',
            {
              type: 'button',
              style: !props.dirty || props.busy ? Object.assign({}, S.buttonPrimary, S.buttonDisabled) : S.buttonPrimary,
              disabled: !props.dirty || props.busy,
              onClick: props.onSave,
            },
            props.busy ? t('saving') : t('save'),
          ),
          h(
            'button',
            { type: 'button', style: S.button, disabled: props.busy, onClick: props.onReset },
            t('reset'),
          ),
          props.dirty ? h('span', { style: S.hint }, '•') : null,
        ),
      )
    }

    function ToolsTab(props) {
      const t = props.t
      const tools = props.tools
      if (!tools) return h(Notice, { text: t('loading') })
      const caps = props.capabilities || { total: 0, groups: [] }
      const covered = (tools.coveredCapabilities || []).length
      if (!tools.tools || tools.tools.length === 0) {
        return h(Card, { title: t('tools.title') }, h('p', { style: S.hint }, t('tools.empty')))
      }
      return h(
        Card,
        { title: t('tools.title') },
        h(
          'p',
          { style: S.hint },
          t('tools.summary').replace('{count}', String(tools.count)).replace('{covered}', String(covered)).replace('{total}', String(caps.total)),
        ),
        h(Table, {
          columns: [
            { key: 'name', title: t('tools.name'), mono: true },
            {
              key: 'kind',
              title: t('tools.kind'),
              render: row => h('span', { style: Object.assign({}, S.badge, row.write ? S.badgeWarn : S.badgeIdle) }, row.write ? t('write') : t('read')),
            },
            { key: 'groups', title: t('tools.groups'), render: row => (row.groups || []).join(', ') },
            { key: 'caps', title: t('tools.caps'), render: row => String((row.capabilities || []).length) },
            { key: 'desc', title: t('tools.desc'), render: row => row.description },
          ],
          rows: tools.tools,
        }),
      )
    }

    function CapabilitiesTab(props) {
      const t = props.t
      const caps = props.capabilities
      if (!caps) return h(Notice, { text: t('loading') })
      const exposed = props.status.tools && props.status.tools.names ? props.status.tools.names.length : 0
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Card, { title: t('caps.title') }, h('p', { style: S.hint }, t('caps.summary').replace('{total}', String(caps.total)).replace('{exposed}', String(exposed)))),
        (caps.groups || []).map(group =>
          h(
            Card,
            {
              key: group.group,
              title:
                group.label +
                '（' +
                group.capabilities.length +
                '）' +
                (group.disabled ? ' · ' + t('status.groupDisabled') : ''),
            },
            h(Table, {
              columns: [
                { key: 'id', title: t('caps.id'), mono: true },
                { key: 'route', title: t('caps.route'), mono: true, render: row => row.method + ' ' + row.path },
                {
                  key: 'kind',
                  title: t('caps.kind'),
                  render: row => h('span', { style: Object.assign({}, S.badge, row.write ? S.badgeWarn : S.badgeIdle) }, row.write ? t('write') : t('read')),
                },
                { key: 'summary', title: t('caps.desc'), render: row => row.summary },
              ],
              rows: group.capabilities,
            }),
          ),
        ),
      )
    }

    function LogsTab(props) {
      const t = props.t
      const lines = props.logs || []
      return h(
        Card,
        { title: t('logs.title') },
        h(
          'div',
          { style: S.actions },
          h('button', { type: 'button', style: S.button, onClick: props.onRefresh }, t('refresh')),
          h(
            'label',
            { style: S.checkboxRow },
            h('input', { type: 'checkbox', checked: props.auto, onChange: event => props.onAuto(event.target.checked) }),
            h('span', null, t('logs.auto')),
          ),
          h('span', { style: S.hint }, t('logs.lines').replace('{count}', String(lines.length))),
        ),
        lines.length === 0 ? h('p', { style: S.hint }, t('logs.empty')) : h('pre', { style: S.pre }, lines.join('\n')),
      )
    }

    /** Root section: owns the fetch state, the draft, and the active tab. */
    function Section(props) {
      const t = props.t
      const [tab, setTab] = React.useState('status')
      const [status, setStatus] = React.useState(null)
      const [tools, setTools] = React.useState(null)
      const [capabilities, setCapabilities] = React.useState(null)
      const [logs, setLogs] = React.useState([])
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [testResult, setTestResult] = React.useState(null)
      const [autoRefresh, setAutoRefresh] = React.useState(false)

      const load = React.useCallback(
        function () {
          return request('/status')
            .then(data => {
              setStatus(data)
              setError(null)
              // Only seed the draft on first load (or after a save): an
              // in-progress edit must survive a background refresh.
              setDraft(current => (current === null ? toDraft(data.config || {}) : current))
              return data
            })
            .catch(err => {
              setError(err && err.message ? err.message : String(err))
              return null
            })
        },
        [],
      )

      React.useEffect(function () {
        load()
      }, [load])

      React.useEffect(
        function () {
          if (tab !== 'tools' || tools !== null) return undefined
          request('/tools').then(setTools).catch(() => setTools({ tools: [], count: 0, coveredCapabilities: [] }))
          return undefined
        },
        [tab, tools],
      )

      React.useEffect(
        function () {
          if (tab !== 'caps' || capabilities !== null) return undefined
          request('/capabilities').then(setCapabilities).catch(() => setCapabilities({ groups: [], total: 0 }))
          return undefined
        },
        [tab, capabilities],
      )

      const reloadLogs = React.useCallback(function () {
        return request('/logs')
          .then(data => setLogs((data && data.lines) || []))
          .catch(() => undefined)
      }, [])

      React.useEffect(
        function () {
          if (tab !== 'logs') return undefined
          reloadLogs()
          if (!autoRefresh) return undefined
          const timer = setInterval(reloadLogs, 5000)
          return () => clearInterval(timer)
        },
        [tab, autoRefresh, reloadLogs],
      )

      const onChange = React.useCallback(function (key, value) {
        setDraft(function (current) {
          const next = Object.assign({}, current)
          next[key] = value
          return next
        })
        setNotice(null)
      }, [])

      const withBusy = React.useCallback(
        function (action, done) {
          setBusy(true)
          setNotice(null)
          return action()
            .then(data => {
              if (data) {
                setStatus(data)
                setDraft(toDraft(data.config || {}))
              }
              if (done) setNotice(done)
            })
            .catch(err => setNotice((err && err.message ? err.message : String(err)) || t('loadFailed')))
            .then(() => setBusy(false))
        },
        [t],
      )

      const onSave = () => {
        if (!status || !draft) return
        let patch
        try {
          patch = toPatch(draft, status.config || {}, t)
        } catch (err) {
          setNotice(err.message)
          return
        }
        withBusy(() => request('/config', { method: 'PATCH', body: patch }), t('connect.saved'))
      }

      const onReset = () => {
        if (typeof window !== 'undefined' && !window.confirm(t('resetConfirm'))) return
        withBusy(() => request('/config/reset', { method: 'POST', body: {} }), t('connect.resetDone'))
      }

      const onReconnect = () => {
        withBusy(() => request('/reconnect', { method: 'POST', body: {} }), t('status.reconnect'))
      }

      const onTest = () => {
        setBusy(true)
        setNotice(null)
        setTestResult(null)
        request('/test', { method: 'POST', body: {} })
          .then(data => {
            setTestResult({
              ok: data && data.ok !== false,
              message: (data && (data.message || data.error)) || JSON.stringify(data).slice(0, 300),
            })
          })
          .catch(err => setTestResult({ ok: false, message: err && err.message ? err.message : String(err) }))
          .then(() => setBusy(false))
      }

      if (error !== null && status === null) {
        return h(
          'div',
          { style: S.root },
          h('h2', { style: S.h1 }, t('title')),
          h(Notice, { bad: true, text: t('loadFailed') + '：' + error }),
          h('div', { style: S.actions }, h('button', { type: 'button', style: S.button, onClick: load }, t('retry'))),
        )
      }
      if (status === null || draft === null) {
        return h('div', { style: S.root }, h(Notice, { text: t('loading') }))
      }

      const tabs = [
        ['status', t('tab.status')],
        ['connect', t('tab.connect')],
        ['tools', t('tab.tools')],
        ['caps', t('tab.caps')],
        ['logs', t('tab.logs')],
      ]
      const dirty = isDirty(draft, status.config || {})
      let body
      if (tab === 'connect') {
        body = h(ConnectTab, { t, status, draft, dirty, busy, onChange, onSave, onReset })
      } else if (tab === 'tools') {
        body = h(ToolsTab, { t, tools, capabilities })
      } else if (tab === 'caps') {
        body = h(CapabilitiesTab, { t, capabilities, status })
      } else if (tab === 'logs') {
        body = h(LogsTab, { t, logs, auto: autoRefresh, onAuto: setAutoRefresh, onRefresh: reloadLogs })
      } else {
        body = h(StatusTab, {
          t, status, capabilities, busy, testResult,
          onRefresh: load, onReconnect, onTest,
        })
      }

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.header },
          h('h2', { style: S.h1 }, t('title')),
          h('p', { style: S.subtitle }, t('subtitle')),
        ),
        h(
          'div',
          { style: S.tabs },
          tabs.map(pair =>
            h(
              'button',
              { key: pair[0], type: 'button', style: tab === pair[0] ? S.tabActive : S.tab, onClick: () => setTab(pair[0]) },
              pair[1],
            ),
          ),
        ),
        notice ? h(Notice, { bad: dirty && tab === 'connect', text: notice }) : null,
        body,
      )
    }
    //#endregion

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-xiaozhi: locale dictionaries')
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-xiaozhi',
                // Between the built-in sections and the plugin-market pages.
                order: 35,
                label: () => t('nav'),
              },
              function BoundSection(otherProps) {
                return h(Section, Object.assign({}, otherProps, { t }))
              },
            ),
          ),
        'dsh-xiaozhi: settings section',
      )
    }

    // Only `apply` and `inject` are part of the module contract; `__test` exists
    // so test/client.test.mjs can render and check the helpers without a browser.
    return {
      inject,
      apply,
      __test: {
        ADMIN_BASE,
        CSRF_HEADER,
        CONNECTION_TONES,
        NS,
        zh,
        en,
        FIELDS,
        EDITABLE_KEYS,
        toDraft,
        toPatch,
        isDirty,
        Section,
        StatusTab,
        ConnectTab,
        ToolsTab,
        CapabilitiesTab,
        LogsTab,
      },
    }
  },
})
