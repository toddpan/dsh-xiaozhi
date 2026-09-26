/**
 * dsh-xiaozhi - plugin entry.
 *
 * `apply()` builds one *runtime*: the bundled DSH Web REST layer, the
 * capability runtime, the MCP tool runner and the transport (outbound access
 * point or inbound server). The settings page can replace that runtime live, so
 * every resource is created inside `boot()` and released by its disposer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  Config as ConfigShape,
  clearOverrides,
  effectiveEndpoints,
  mergeMaskedEndpoints,
  readOverrides,
  redactConfig,
  resolveConfig,
  resolveSettingsFile,
  writeOverrides,
  type Config as XiaozhiConfig,
  type EndpointDevice,
  type ResolvedConfig,
} from './config.js'
import { LocalInvoker } from './dispatcher.js'
import { createDshApiRouter, sendJson, type DshApiOptions } from './dshapi/service.js'
import {
  CAPABILITIES,
  CapabilityRuntime,
  TOOL_GROUPS,
  TOOL_GROUP_LABELS,
  pluginVersion,
  type ToolGroup,
} from './capabilities.js'
import { ToolRunner } from './tools.js'
import { McpSession } from './mcp-server.js'
import {
  EndpointTransport,
  ServerTransport,
  TransportStatus,
  maskEndpoint,
  type TransportSnapshot,
} from './transports.js'
import { createAdminRouter } from './admin.js'
import { ADMIN_BASE } from './shared.js'
import { RingLog } from './log.js'
import { connectWebSocket, type WsConnection } from './ws.js'

export const name = 'dsh-xiaozhi'
/** The plugin always needs the browser HTTP carrier: admin API + bundled REST layer. */
export const inject = ['webServer']
export const Config: z<XiaozhiConfig> = ConfigShape

export function apply(ctx: Context, rowConfig: XiaozhiConfig): void {
  const log = new RingLog(300, 'dsh-xiaozhi', line => {
    try {
      const logger = (ctx as unknown as { logger?: { info?: (message: string) => void } }).logger
      logger?.info?.(line)
    } catch {
      /* ignore */
    }
  })

  let runtime: Runtime | undefined
  let resolved = resolveConfig(rowConfig, readOverrides(rowConfig))
  // Points at the *currently live* runtime's status provider. Deps that restart
  // the runtime (save/reset) must answer from the new one — answering from their
  // own boot-time locals would report the just-disposed runtime (idle, old names).
  let liveStatus: (() => Promise<unknown>) | undefined
  const requireLiveStatus = (): Promise<unknown> => {
    // Assigned synchronously during boot, before any request can be dispatched.
    if (!liveStatus) throw new Error('runtime status provider is not ready')
    return liveStatus()
  }

  const boot = (): Runtime => {
    const config = resolveConfig(rowConfig, readOverrides(rowConfig))
    resolved = config

    const apiBase = `${config.apiPathPrefix}/v1`
    // Fixed, not `${config.apiPathPrefix}/admin`: the settings page runs in the
    // browser and cannot read Host config, so a configurable admin path would
    // silently break the page. See src/shared.ts.
    const adminBase = ADMIN_BASE
    const disposers: (() => void)[] = []

    // ---- bundled DSH Web REST layer -------------------------------------
    const dshConfig: DshApiOptions = {
      pathPrefix: apiBase,
      apiKey: config.apiKey,
      cors: config.cors,
      defaultCwd: config.defaultCwd,
      maxUploadBytes: config.maxUploadBytes,
    }
    const dshRouter = createDshApiRouter(ctx, dshConfig)
    const invoker = new LocalInvoker(dshRouter, apiBase)

    // ---- MCP capability runtime + tool surface --------------------------
    const status = new TransportStatus()
    // One endpoint transport per bound device, each with its own connection
    // state; `serverTransport` hosts inbound clients instead. Assigned in the
    // transport section below; the closures only read them per request.
    let endpointDevices: EndpointDeviceRuntime[] = []
    let serverTransport: ServerTransport | undefined
    const capabilities = new CapabilityRuntime({
      ctx,
      invoker,
      config: () => resolved,
      apiBase: () => apiBase,
      mcpStatus: () => aggregateSnapshot(endpointDevices, serverTransport, status, resolved),
      log: message => log.push(message),
    })
    const runner = new ToolRunner({
      runtime: capabilities,
      config: () => resolved,
      log: message => log.push(message),
    })

    // `GET /system/status` and the `dsh_status` tool must never disagree, so the
    // route serves the capability's payload. Assigned here because the runtime
    // needs the invoker built on the router; the route resolves it per request.
    dshConfig.systemStatus = () => capabilities.systemStatus()

    // ---- transport ------------------------------------------------------
    const createSession = (connection: WsConnection): McpSession =>
      new McpSession(connection, {
        tools: () => runner.definitions(),
        callTool: (toolName, args) => runner.call(toolName, args),
        serverName: () => resolved.serverName,
        serverVersion: pluginVersion(),
        sendInitializedNotification: () => resolved.sendInitializedNotification,
        log: message => log.push(message),
      })

    // Constructed here but deliberately *started* after the HTTP routes are
    // mounted: `webServer.register` can throw (a duplicate path), and a
    // transport started first would then be left running with nobody owning it.
    if (!config.enabled) {
      status.setState('disabled')
      log.push('MCP transport disabled by config')
    } else if (config.mode === 'server') {
      serverTransport = new ServerTransport({
        ctx,
        config: () => resolved,
        status,
        createSession: (connection: WsConnection) => createSession(connection),
        log: message => log.push(message),
      })
    } else {
      endpointDevices = effectiveEndpoints(config).map(device => {
        // Live lookup by id, so a reconnect dials the URL that is configured
        // *now*; fall back to the boot-time device when it has vanished.
        const live = (): EndpointDevice | undefined =>
          effectiveEndpoints(resolved).find(candidate => candidate.id === device.id)
        const deviceStatus = new TransportStatus()
        const deviceTransport = new EndpointTransport({
          ctx,
          config: () => resolved,
          url: () => live()?.url ?? device.url,
          headers: () => ({ ...resolved.endpointHeaders, ...(live()?.headers ?? device.headers ?? {}) }),
          describe: { id: device.id, name: device.name },
          status: deviceStatus,
          createSession: (connection: WsConnection) => createSession(connection),
          log: message => log.push(`[${device.name || device.id}] ${message}`),
        })
        return { id: device.id, name: device.name ?? '', status: deviceStatus, transport: deviceTransport }
      })
    }

    // ---- HTTP surfaces --------------------------------------------------
    const webServer = ctx.get('webServer') as
      | { register?: (route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => () => void }
      | undefined

    const dispatchWith = (router: { dispatch: (req: IncomingMessage, res: ServerResponse, base: string) => Promise<boolean> }, base: string, label: string) => {
      return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          const handled = await router.dispatch(req, res, base)
          if (!handled && !res.headersSent) {
            sendJson(res, 404, { ok: false, error: `Endpoint not found: ${req.url}`, code: 'NOT_FOUND' })
          }
        } catch (err) {
          log.push(`${label} dispatch failed: ${(err as Error)?.message ?? String(err)}`)
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
        }
      }
    }

    // Published before the routes mount: every admin response after this point
    // (including the ones following a save-triggered restart) reads the live
    // runtime, not the closure that happened to handle the request.
    liveStatus = () =>
      adminStatus(endpointDevices, serverTransport, status, resolved, runner, capabilities, apiBase, adminBase, rowConfig, log)

    const adminRouter = createAdminRouter({
      status: () => requireLiveStatus(),
      patchConfig: async patch => {
        // Device rows arrive with masked URLs/headers from the settings page;
        // resolve them against the stored config before anything is written.
        let effective = patch
        if (Array.isArray(patch.endpoints)) {
          const merged = mergeMaskedEndpoints(rowConfig, patch)
          effective = { ...patch, endpoints: merged.endpoints }
          if (merged.dropped > 0) {
            log.push(`config: dropped ${merged.dropped} device row(s) whose masked URL matched nothing stored`)
          }
        }
        writeOverrides(rowConfig, effective)
        log.push(`config updated: ${Object.keys(effective).join(', ') || '(empty)'}`)
        restart()
        return requireLiveStatus()
      },
      resetConfig: async () => {
        clearOverrides(rowConfig)
        log.push('config overrides cleared')
        restart()
        return requireLiveStatus()
      },
      tools: () => ({
        mode: runner.mode,
        count: runner.list().length,
        tools: runner.list(),
        coveredCapabilities: [...new Set(runner.list().flatMap(tool => tool.capabilities))].sort(),
        totalCapabilities: CAPABILITIES.length,
      }),
      capabilities: () => ({
        groups: TOOL_GROUPS.map(group => ({
          group,
          label: TOOL_GROUP_LABELS[group],
          disabled: resolved.disabledGroups.includes(group),
          capabilities: CAPABILITIES.filter(spec => spec.group === group).map(spec => ({
            id: spec.id,
            method: spec.method,
            path: spec.path,
            write: spec.write,
            summary: spec.summary,
          })),
        })),
        total: CAPABILITIES.length,
      }),
      logs: () => log.lines(),
      connectionRejection: request => hostConnectionRejection(ctx, request),
      reconnect: async payload => {
        const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
        if (endpointDevices.length > 0) {
          const targets = id === '' ? endpointDevices : endpointDevices.filter(device => device.id === id)
          if (targets.length === 0) {
            log.push(`reconnect: no device matches id ${id}`)
          } else {
            for (const device of targets) device.transport.reconnect()
          }
        } else if (serverTransport) {
          log.push('reconnect ignored: server mode has no outbound connection')
        } else {
          log.push('reconnect ignored: no Xiaozhi device is bound')
        }
        // The handshake settles asynchronously; the page's 3s poll (plus its
        // own follow-up fetches) reports the final state.
        return requireLiveStatus()
      },
      test: async payload => {
        const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
        const url = typeof payload?.url === 'string' ? payload.url.trim() : ''
        return testConnection(resolved, endpointDevices, serverTransport, { id, url }, log)
      },
      log: message => log.push(message),
    })

    if (webServer?.register) {
      disposers.push(
        webServer.register({
          kind: 'prefix',
          path: adminBase,
          handler: dispatchWith(adminRouter, adminBase, 'admin'),
        }),
      )
      if (config.exposeDshApi) {
        disposers.push(
          webServer.register({
            kind: 'prefix',
            path: apiBase,
            handler: dispatchWith(dshRouter, apiBase, 'dsh-api'),
          }),
        )
      }
      log.push(`admin API mounted at ${adminBase}`)
    } else {
      log.push('webServer.register unavailable: admin API and bundled REST layer not mounted')
    }

    // Every HTTP surface is mounted: it is now safe to open the MCP channel.
    for (const device of endpointDevices) device.transport.start()
    serverTransport?.start()

    return {
      dispose() {
        try {
          for (const device of endpointDevices) device.transport.stop()
          serverTransport?.stop()
        } catch (err) {
          log.push(`transport stop failed: ${(err as Error)?.message ?? String(err)}`)
        }
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* route already gone */
          }
        }
      },
    }
  }

  const restart = (): void => {
    try {
      runtime = swapRuntime(runtime, boot, message => log.push(message))
    } catch (err) {
      // The next runtime never came up; nothing owns the old one either.
      runtime = undefined
      throw err
    }
  }

  runtime = boot()
  ctx.effect(
    () => () => {
      runtime?.dispose()
      runtime = undefined
    },
    'dsh-xiaozhi: dispose runtime',
  )
}

interface Runtime {
  dispose(): void
}

/** One bound Xiaozhi device's live connection machinery. */
interface EndpointDeviceRuntime {
  id: string
  name: string
  status: TransportStatus
  transport: EndpointTransport
}

/**
 * Replace the live runtime with a freshly booted one, **disposing first**.
 *
 * The order is the whole point. Booting while the previous runtime still owns
 * its routes makes the DSH web server throw `duplicate prefix route`; the old
 * runtime would then be disposed on the way out, leaving the plugin with no
 * transport and no admin API at all. Saving any setting failed that way.
 */
export function swapRuntime<T extends Runtime>(
  previous: T | undefined,
  boot: () => T,
  log: (message: string) => void,
): T {
  previous?.dispose()
  try {
    return boot()
  } catch (err) {
    log(`runtime restart failed: ${(err as Error)?.message ?? String(err)}`)
    throw err
  }
}

/**
 * The single `transport` view the settings page and the `dsh_status` tool see:
 * the server snapshot verbatim, or the healthiest-aggregate of the devices
 * (ready beats connecting beats error beats idle) with the count attached so a
 * multi-device deployment reads honestly at a glance.
 */
function aggregateSnapshot(
  devices: EndpointDeviceRuntime[],
  server: ServerTransport | undefined,
  status: TransportStatus,
  resolved: ResolvedConfig,
): TransportSnapshot {
  if (server) return server.snapshot()
  if (devices.length > 0) {
    const snaps = devices.map(device => device.transport.snapshot())
    const rank: Record<string, number> = { ready: 0, connecting: 1, error: 2, idle: 3, disabled: 4 }
    const best = [...snaps].sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9))[0]
    const connectedAt = snaps
      .filter(snap => typeof snap.connectedAt === 'number')
      .map(snap => snap.connectedAt as number)
      .sort((a, b) => b - a)[0]
    const errored = snaps.find(snap => snap.state === 'error')
    return {
      mode: 'endpoint',
      state: best.state,
      connected: snaps.some(snap => snap.connected),
      endpointUrl: snaps.length === 1 ? snaps[0].endpointUrl : `${snaps.length} 台设备`,
      deviceCount: snaps.length,
      connectedAt,
      lastError: errored?.lastError ?? best.lastError,
    }
  }
  return {
    mode: resolved.mode,
    state: status.state,
    connected: false,
    endpointUrl: resolved.mode === 'endpoint' ? maskEndpoint(resolved.endpointUrl) : undefined,
    lastError: status.lastError,
  }
}

/**
 * Ask the Host connection service to judge an admin request.
 *
 * Returns 401/403 when the Host refuses it, or `undefined` when the service is
 * absent or cannot judge (headless, tests). It is fetched lazily through
 * `ctx.get` rather than injected, so dsh-xiaozhi still loads in a profile
 * without a client connection, and it is called **as a method** - the service
 * reads its own `this`, and detaching it would turn every request into a 403.
 */
function hostConnectionRejection(ctx: { get(name: string): unknown }, request: unknown): number | undefined {
  const connection = ctx.get('connection') as
    | { requestRejection?: (req: unknown) => number | undefined }
    | undefined
  if (typeof connection?.requestRejection !== 'function') return undefined
  const rejection = connection.requestRejection(request)
  if (typeof rejection !== 'number') return undefined
  return rejection
}

async function adminStatus(
  endpointDevices: EndpointDeviceRuntime[],
  serverTransport: ServerTransport | undefined,
  status: TransportStatus,
  resolved: ResolvedConfig,
  runner: ToolRunner,
  capabilities: CapabilityRuntime,
  apiBase: string,
  adminBase: string,
  rowConfig: XiaozhiConfig,
  log: RingLog,
): Promise<unknown> {
  const tools = runner.list()
  return {
    plugin: { name: 'dsh-xiaozhi', version: pluginVersion() },
    settingsFile: resolveSettingsFile(rowConfig),
    config: redactConfig(resolved),
    transport: {
      ...aggregateSnapshot(endpointDevices, serverTransport, status, resolved),
      logLines: log.lines().length,
    },
    // Per-device live state for the settings page; absent in server mode where
    // inbound clients are not "devices".
    devices:
      resolved.enabled && resolved.mode === 'endpoint'
        ? endpointDevices.map(device => device.transport.snapshot())
        : undefined,
    tools: {
      mode: runner.mode,
      count: tools.length,
      names: tools.map(tool => tool.name),
    },
    groups: TOOL_GROUPS.map(group => ({
      group,
      label: TOOL_GROUP_LABELS[group],
      enabled: !resolved.disabledGroups.includes(group),
      capabilityCount: CAPABILITIES.filter(spec => spec.group === group).length,
      exposed: capabilities.available().some(spec => spec.group === (group as ToolGroup)),
    })),
    paths: { adminBase, apiBase, docsUrl: `${apiBase}/docs`, openApiUrl: `${apiBase}/openapi.json` },
    warnings: collectWarnings(resolved, runner),
    uptimeSeconds: Math.round(process.uptime()),
  }
}

/**
 * Surfaced verbatim on the settings page. Each one is a state a user can
 * actually reach and fix; none of them block activation.
 */
function collectWarnings(resolved: ResolvedConfig, runner: ToolRunner): string[] {
  const warnings: string[] = []
  if (!resolved.enabled) {
    warnings.push('插件已关闭（enabled=false），小智无法调用任何工具。')
    return warnings
  }
  if (resolved.mode === 'endpoint') {
    const devices = effectiveEndpoints(resolved)
    if (devices.length === 0) {
      warnings.push('未绑定任何小智 MCP 设备。请在小智 App 或后台复制「MCP 接入点」的 WebSocket 地址，在设置页「添加设备」。')
    }
    for (const device of devices) {
      const problem = validateEndpointUrl(device.url)
      if (problem) warnings.push(`设备「${device.name || device.id}」：${problem}`)
    }
  } else {
    if (resolved.serverPort > 0 && !resolved.serverToken) {
      warnings.push('server 模式已在 0.0.0.0 上监听额外端口但没有设置口令，局域网内任何人可连接；建议设置 serverToken。')
    }
    if (resolved.serverPort === 0) {
      warnings.push('server 模式仅监听 DSH Web 服务器；DSH 默认绑定 127.0.0.1，宿主机外的小智部署无法连接。需要外网访问时请填写 serverPort 或通过反向代理暴露。')
    }
  }
  if (resolved.exposeDshApi && !resolved.apiKey) {
    warnings.push('内置 REST 层已暴露且未设置 apiKey，任何能访问 DSH Web 端口的客户端都可以读写成；不建议公网暴露。')
  }
  if (runner.list().length > 24) {
    warnings.push(`当前暴露 ${runner.list().length} 个工具，数量偏多会降低语音模型的工具选择准确率；建议关闭暂时用不到的工具组。`)
  }
  if (resolved.toolMode === 'flat' && runner.list().length > 24) {
    warnings.push('flat 模式与 REST 能力一一对应，工具数量较多；除非对接方明确要求，建议改回 grouped 模式。')
  }
  if (resolved.allowWriteTools === false) {
    warnings.push('写入类工具已关闭，小智只能查询，无法新建会话或发送指令。')
  }
  return warnings
}

/** Mirrors the shape checks Xiaozhi itself applies to `mcp_endpoint`. */
export function validateEndpointUrl(url: string): string | null {
  const text = url.trim()
  if (text === '') return '接入点地址为空。'
  if (!text.startsWith('ws://') && !text.startsWith('wss://')) {
    return '接入点地址必须以 ws:// 或 wss:// 开头（从浏览器地址栏复制 http(s) 链接是常见错误）。'
  }
  if (!text.includes('/mcp/')) {
    return '接入点地址里必须包含 /mcp/，请确认复制的是「MCP 接入点」而不是别的链接。'
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return '接入点地址不是合法的 URL。'
  }
  if (!parsed.searchParams.get('token')) {
    return '接入点地址缺少 token 参数；接入点 token 绑定智能体，请从后台重新复制完整链接。'
  }
  const lowered = text.toLowerCase()
  if (lowered.includes('key=') || lowered.includes('call')) {
    return '这个地址看起来不是 MCP 接入点（包含 key/call 字样），请确认复制来源。'
  }
  return null
}

/**
 * "测试连接": a real handshake, then an immediate clean close.
 *
 * Without a target the whole device list is probed in parallel and the results
 * are summarised; with a device id or an explicit URL only that one is probed
 * (the settings page tests unsaved rows by URL, saved rows by id).
 */
async function testConnection(
  resolved: ResolvedConfig,
  endpointDevices: EndpointDeviceRuntime[],
  serverTransport: ServerTransport | undefined,
  target: { id?: string; url?: string },
  log: RingLog,
): Promise<unknown> {
  if (!resolved.enabled) {
    return { ok: false, message: '插件已关闭（enabled=false），请先启用。' }
  }
  if (resolved.mode === 'server') {
    const snapshot = serverTransport?.snapshot()
    return {
      ok: Boolean(snapshot?.listenUrls?.length),
      message: 'server 模式下由小智主动连接；请把下面的地址填入小智的 MCP 接入点/服务器配置。',
      listenUrls: snapshot?.listenUrls ?? [],
      connectedClients: snapshot?.connectedClients ?? 0,
    }
  }

  const probeOne = async (url: string, headers: Record<string, string>, label: string): Promise<string> => {
    const problem = validateEndpointUrl(url)
    if (problem) return `${label}：${problem}`
    try {
      const connection = await connectWebSocket(url, { headers, handshakeTimeoutMs: 10_000 })
      connection.close(1000, 'connection test')
      return `${label}：握手成功，地址与 token 有效。`
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      log.push(`connection test failed (${label}): ${message}`)
      return `${label}：握手失败：${message}。常见原因：token 过期或不属于当前智能体、地址区域不对、网络需要代理。`
    }
  }

  if (target.id) {
    const device = effectiveEndpoints(resolved).find(candidate => candidate.id === target.id)
    if (!device) return { ok: false, message: '找不到该设备，请先保存配置后再测试。' }
    const label = device.name || device.id
    const message = await probeOne(device.url, { ...resolved.endpointHeaders, ...(device.headers ?? {}) }, label)
    return { ok: message.includes('握手成功'), message }
  }
  if (target.url) {
    const message = await probeOne(target.url, { ...resolved.endpointHeaders }, '未保存的地址')
    return { ok: message.includes('握手成功'), message }
  }

  const devices = effectiveEndpoints(resolved)
  if (devices.length === 0) {
    return { ok: false, message: '未绑定任何小智 MCP 设备，请先在「接入配置」添加设备并保存。' }
  }
  const results = await Promise.all(
    devices.map(device =>
      probeOne(device.url, { ...resolved.endpointHeaders, ...(device.headers ?? {}) }, device.name || device.id),
    ),
  )
  log.push(`connection test: ${results.filter(line => line.includes('握手成功')).length}/${results.length} succeeded`)
  return { ok: results.every(line => line.includes('握手成功')), message: results.join('\n') }
}
