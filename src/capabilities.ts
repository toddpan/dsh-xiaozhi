/**
 * dsh-xiaozhi - capability table.
 *
 * One entry per DSH Web REST/SSE capability the user asked to expose (the
 * route inventory of `@dsh-external/dsh-web-service` v0.1.11). This is the
 * single source of truth for:
 *
 *   - the `flat` tool mode (one MCP tool per capability),
 *   - the `grouped` tool mode (one MCP tool per voice intent, dispatching to
 *     several capabilities behind an `action` enum),
 *   - the settings page's capability index.
 *
 * Three capabilities are not a plain route call and own a bespoke handler:
 * `system.status` (no route in the trimmed copy), `sessions.events` (the SSE
 * route never completes, so it is bounded to a time window) and `docs.info`
 * (returns entry-point URLs rather than flooding the voice channel with the
 * full OpenAPI document).
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import { LocalInvoker, InvokeError, type InvokeRequest } from './dispatcher.js'
import { clip } from './protocol.js'

export type ToolGroup =
  | 'system'
  | 'workspaces'
  | 'sessions'
  | 'conversation'
  | 'files'
  | 'models'
  | 'settings'
  | 'docs'

export const TOOL_GROUPS: readonly ToolGroup[] = [
  'system',
  'workspaces',
  'sessions',
  'conversation',
  'files',
  'models',
  'settings',
  'docs',
]

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  system: '系统状态',
  workspaces: '工作区',
  sessions: '会话',
  conversation: '对话',
  files: '文件',
  models: '模型与预设',
  settings: '系统设置',
  docs: '接口文档',
}

export type BodyKind = 'none' | 'json' | 'raw' | 'passthrough'

export interface CapabilitySpec {
  /** Stable dotted id, e.g. `sessions.history`. */
  id: string
  group: ToolGroup
  /** Mutating: hidden when `allowWriteTools` is false. */
  write: boolean
  /** Route method; ignored by bespoke handlers. */
  method: InvokeRequest['method']
  /** Route path with `:params`; ignored by bespoke handlers. */
  path: string
  pathParams: string[]
  queryParams: string[]
  body: BodyKind
  /** For `body: 'json'`: the body fields copied out of the tool arguments. */
  bodyFields: string[]
  /** How long this capability may run (ms). */
  timeoutMs: number
  /** Chinese summary shown in the settings page capability index. */
  summary: string
}

const MINUTE = 60_000

/** The complete capability inventory. */
export const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    id: 'system.status',
    group: 'system',
    write: false,
    method: 'GET',
    path: '/system/status',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 10_000,
    summary: 'DSH 运行状态、端口、工作区数量、可用模型、MCP 连接状态',
  },

  {
    id: 'workspaces.list',
    group: 'workspaces',
    write: false,
    method: 'GET',
    path: '/workspaces',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '查询工作区列表',
  },
  {
    id: 'workspaces.get',
    group: 'workspaces',
    write: false,
    method: 'GET',
    path: '/workspaces/:id',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '获取工作区详情',
  },
  {
    id: 'workspaces.create',
    group: 'workspaces',
    write: true,
    method: 'POST',
    path: '/workspaces',
    pathParams: [],
    queryParams: [],
    body: 'json',
    bodyFields: ['path', 'title'],
    timeoutMs: 30_000,
    summary: '创建工作区（绑定目录）',
  },
  {
    id: 'workspaces.update',
    group: 'workspaces',
    write: true,
    method: 'PUT',
    path: '/workspaces/:id',
    pathParams: ['id'],
    queryParams: [],
    body: 'json',
    bodyFields: ['title'],
    timeoutMs: 15_000,
    summary: '修改工作区标题',
  },
  {
    id: 'workspaces.delete',
    group: 'workspaces',
    write: true,
    method: 'DELETE',
    path: '/workspaces/:id',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '删除工作区绑定（不删除磁盘目录）',
  },
  {
    id: 'workspaces.sessions',
    group: 'workspaces',
    write: false,
    method: 'GET',
    path: '/workspaces/:id/sessions',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '查询工作区下的会话',
  },

  {
    id: 'sessions.list',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions',
    pathParams: [],
    queryParams: ['search', 'workspaceId', 'limit'],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '查询会话列表（支持搜索与工作区过滤）',
  },
  {
    id: 'sessions.get',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions/:id',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '查询单个会话详情与运行状态',
  },
  {
    id: 'sessions.create',
    group: 'sessions',
    write: true,
    method: 'POST',
    path: '/sessions',
    pathParams: [],
    queryParams: [],
    body: 'json',
    bodyFields: ['workspaceId', 'cwd', 'title', 'provider', 'model', 'reasoningEffort', 'agentPreset'],
    timeoutMs: 30_000,
    summary: '创建新会话',
  },
  {
    id: 'sessions.update',
    group: 'sessions',
    write: true,
    method: 'PUT',
    path: '/sessions/:id',
    pathParams: ['id'],
    queryParams: [],
    body: 'json',
    bodyFields: ['title', 'provider', 'model', 'reasoningEffort'],
    timeoutMs: 15_000,
    summary: '修改会话标题或模型',
  },
  {
    id: 'sessions.delete',
    group: 'sessions',
    write: true,
    method: 'DELETE',
    path: '/sessions/:id',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '删除／归档会话',
  },
  {
    id: 'sessions.history',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions/:id/history',
    pathParams: ['id'],
    queryParams: ['maxMessages', 'beforeSeq', 'throughSeq'],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '分页查询会话历史消息',
  },
  {
    id: 'sessions.stats',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions/:id/stats',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '会话实时统计：轮/步、耗时、首 token、吞吐、token 账本',
  },
  {
    id: 'sessions.todos',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions/:id/todos',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '会话任务清单与运行时长',
  },
  {
    id: 'sessions.skills',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions/:id/skills',
    pathParams: ['id'],
    queryParams: ['search'],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '会话作用域技能目录',
  },
  {
    id: 'sessions.questions',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions/:id/questions',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '查询会话当前挂起的提问批次',
  },
  {
    id: 'sessions.answers',
    group: 'sessions',
    write: true,
    method: 'POST',
    path: '/sessions/:id/answers',
    pathParams: ['id'],
    queryParams: [],
    body: 'passthrough',
    bodyFields: ['batchId', 'answers'],
    timeoutMs: 15_000,
    summary: '回答会话挂起的问题，会话继续运行',
  },
  {
    id: 'sessions.cancel',
    group: 'sessions',
    write: true,
    method: 'POST',
    path: '/sessions/:id/cancel',
    pathParams: ['id'],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '中止会话当前轮次',
  },
  {
    id: 'sessions.events',
    group: 'sessions',
    write: false,
    method: 'GET',
    path: '/sessions/:id/events',
    pathParams: ['id'],
    queryParams: ['seconds'],
    body: 'none',
    bodyFields: [],
    timeoutMs: 35_000,
    summary: '在时间窗内监听会话事件流（SSE 的有限窗口降级）',
  },

  {
    id: 'files.list',
    group: 'files',
    write: false,
    method: 'GET',
    path: '/sessions/:id/files',
    pathParams: ['id'],
    queryParams: ['path'],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '列出会话工作区目录',
  },
  {
    id: 'files.download',
    group: 'files',
    write: false,
    method: 'GET',
    path: '/sessions/:id/files/download',
    pathParams: ['id'],
    queryParams: ['path', 'inline'],
    body: 'none',
    bodyFields: [],
    timeoutMs: 30_000,
    summary: '下载会话工作区文件（文本内容回传，二进制回传摘要）',
  },
  {
    id: 'files.upload',
    group: 'files',
    write: true,
    method: 'POST',
    path: '/sessions/:id/files',
    pathParams: ['id'],
    queryParams: ['filename'],
    body: 'raw',
    bodyFields: [],
    timeoutMs: 60_000,
    summary: '上传文件到会话工作区（内容以 base64 或纯文本传入）',
  },

  {
    id: 'conversation.prompt',
    group: 'conversation',
    write: true,
    method: 'POST',
    path: '/sessions/:id/prompt',
    pathParams: ['id'],
    queryParams: [],
    body: 'json',
    bodyFields: ['prompt', 'mode', 'timeoutMs', 'images'],
    timeoutMs: 30 * MINUTE,
    summary: '向会话发送提示词并同步等待整轮结果',
  },
  {
    id: 'conversation.promptStream',
    group: 'conversation',
    write: true,
    method: 'POST',
    path: '/sessions/:id/prompt-stream',
    pathParams: ['id'],
    queryParams: [],
    body: 'json',
    bodyFields: ['prompt', 'mode', 'timeoutMs', 'images'],
    timeoutMs: 30 * MINUTE,
    summary: '流式对话（MCP 上收集完整个流后一次性返回，见 README 语义降级）',
  },
  {
    id: 'conversation.chat',
    group: 'conversation',
    write: true,
    method: 'POST',
    path: '/chat/completions',
    pathParams: [],
    queryParams: [],
    body: 'passthrough',
    bodyFields: ['messages', 'model', 'sessionId', 'max_tokens'],
    timeoutMs: 30 * MINUTE,
    summary: 'OpenAI 兼容一次性对话（可复用已有会话）',
  },

  {
    id: 'models.list',
    group: 'models',
    write: false,
    method: 'GET',
    path: '/models',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '查询可用模型清单与默认模型',
  },
  {
    id: 'models.default',
    group: 'models',
    write: false,
    method: 'GET',
    path: '/models/default',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 15_000,
    summary: '获取全局默认模型',
  },
  {
    id: 'models.setDefault',
    group: 'models',
    write: true,
    method: 'PUT',
    path: '/models/default',
    pathParams: [],
    queryParams: [],
    body: 'passthrough',
    bodyFields: ['provider', 'model', 'reasoningEffort'],
    timeoutMs: 20_000,
    summary: '更新全局默认模型',
  },
  {
    id: 'models.providers',
    group: 'models',
    write: false,
    method: 'GET',
    path: '/providers',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 30_000,
    summary: '查询注册的 LLM 提供商',
  },
  {
    id: 'models.presets',
    group: 'models',
    write: false,
    method: 'GET',
    path: '/presets',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '查询可用 Agent Preset 清单',
  },

  {
    id: 'settings.get',
    group: 'settings',
    write: false,
    method: 'GET',
    path: '/settings',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: '读取系统设置命名空间',
  },
  {
    id: 'settings.patch',
    group: 'settings',
    write: true,
    method: 'PATCH',
    path: '/settings/:namespace',
    pathParams: ['namespace'],
    queryParams: [],
    body: 'passthrough',
    bodyFields: ['patch'],
    timeoutMs: 20_000,
    summary: '按命名空间更新系统设置',
  },

  {
    id: 'docs.info',
    group: 'docs',
    write: false,
    method: 'GET',
    path: '/docs',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 10_000,
    summary: '内置交互式 API 文档与 OpenAPI 规范的入口地址',
  },
  {
    id: 'docs.openapi',
    group: 'docs',
    write: false,
    method: 'GET',
    path: '/openapi.json',
    pathParams: [],
    queryParams: [],
    body: 'none',
    bodyFields: [],
    timeoutMs: 20_000,
    summary: 'OpenAPI 3.0 规范（返回结构摘要；完整文档在 /openapi.json）',
  },
]

const BY_ID = new Map(CAPABILITIES.map(spec => [spec.id, spec]))

export function getCapability(id: string): CapabilitySpec | undefined {
  return BY_ID.get(id)
}

/** User-facing failure raised while running a capability. */
export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly capability?: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CapabilityError'
  }
}

export interface CapabilityRuntimeDeps {
  ctx: Context
  invoker: LocalInvoker
  /** Live config accessor: the settings page can change it without a reload. */
  config: () => ResolvedConfig
  /** URL prefix the bundled REST layer is served under (for `docs.info`). */
  apiBase: () => string
  /** MCP transport snapshot merged into `system.status`. */
  mcpStatus: () => unknown
  /** Optional DSH log sink. */
  log: (message: string) => void
}

/**
 * Runs capabilities. REST-backed capabilities are dispatched in-process
 * through {@link LocalInvoker}; the three bespoke ones are implemented here.
 */
export class CapabilityRuntime {
  constructor(private readonly deps: CapabilityRuntimeDeps) {}

  // ------------------------------------------------------------ id resolution

  private refCache?: {
    at: number
    promise: Promise<{ sessions: { id: string; title: string }[]; workspaces: { id: string; title: string }[] }>
  }

  /**
   * Voice-facing ids are lossy on purpose (`dsh_session_history` says
   * `4ac05afc`, a title, or a fragment of either), so every id-bearing
   * capability expands what it receives back to the full id before dispatch.
   * Resolution is prefix/substring based against the live list; one match
   * resolves, several match is a speakable ambiguity error, none is a
   * speakable not-found. Fetch failures fail *open* (the raw id is passed
   * through) so a list hiccup cannot break full-id callers.
   */
  private refIndex(): Promise<{ sessions: { id: string; title: string }[]; workspaces: { id: string; title: string }[] }> {
    const cached = this.refCache
    if (cached && Date.now() - cached.at < 2_000) return cached.promise
    const config = this.deps.config()
    const sessionsSpec = getCapability('sessions.list')!
    const workspacesSpec = getCapability('workspaces.list')!
    const promise = (async () => {
      const [sessions, workspaces] = await Promise.all([
        this.dispatchRest(sessionsSpec, {}, config).catch(() => []),
        this.dispatchRest(workspacesSpec, {}, config).catch(() => []),
      ])
      const rows = (value: unknown): { id: string; title: string }[] =>
        (Array.isArray(value) ? value : []).map((raw: any) => ({ id: String(raw?.id ?? ''), title: String(raw?.title ?? '') })).filter(row => row.id !== '')
      return { sessions: rows(sessions), workspaces: rows(workspaces) }
    })()
    this.refCache = { at: Date.now(), promise }
    return promise
  }

  private async resolveRef(kind: 'session' | 'workspace', raw: unknown): Promise<unknown> {
    const text = String(raw ?? '').trim()
    if (text === '') return raw
    let index: { sessions: { id: string; title: string }[]; workspaces: { id: string; title: string }[] }
    try {
      index = await this.refIndex()
    } catch {
      return raw
    }
    const rows = kind === 'session' ? index.sessions : index.workspaces
    if (rows.some(row => row.id === text)) return text
    const lowered = text.toLowerCase()
    const matches = rows.filter(
      row => row.id.toLowerCase().includes(lowered) ||
        (row.title !== '' && (row.title === text || row.title.toLowerCase().includes(lowered))),
    )
    if (matches.length === 1) return matches[0].id
    const noun = kind === 'session' ? '会话' : '工作区'
    if (matches.length > 1) {
      const shown = matches.slice(0, 5).map(row => shortRefId(row.id)).join('、')
      throw new CapabilityError(
        `${noun} "${clip(text, 40)}" 匹配到 ${matches.length} 个（${shown}${matches.length > 5 ? ' 等' : ''}），` +
          '请改用列表里更完整的短 id 或更精确的标题',
        undefined,
        400,
      )
    }
    throw new CapabilityError(
      `找不到${noun} "${clip(text, 40)}"。请先用列表动作查看现有的${noun}短 id。`,
      undefined,
      404,
    )
  }

  /** Expand ids for the capability's path/body/query before dispatch. */
  private async resolveArgs(spec: CapabilitySpec, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved = { ...args }
    if (spec.pathParams.includes('id')) {
      resolved.id = await this.resolveRef(spec.group === 'workspaces' ? 'workspace' : 'session', resolved.id)
    }
    if (spec.queryParams.includes('workspaceId') && resolved.workspaceId !== undefined) {
      resolved.workspaceId = await this.resolveRef('workspace', resolved.workspaceId)
    }
    if (spec.bodyFields.includes('workspaceId') && resolved.workspaceId !== undefined) {
      resolved.workspaceId = await this.resolveRef('workspace', resolved.workspaceId)
    }
    if (spec.bodyFields.includes('sessionId') && resolved.sessionId !== undefined) {
      resolved.sessionId = await this.resolveRef('session', resolved.sessionId)
    }
    return resolved
  }

  get specs(): readonly CapabilitySpec[] {
    return CAPABILITIES
  }

  /** Capabilities currently exposed (group filter + read-only filter). */
  available(): CapabilitySpec[] {
    const config = this.deps.config()
    return CAPABILITIES.filter(spec => {
      if (spec.write && !config.allowWriteTools) return false
      if (config.disabledGroups.includes(spec.group)) return false
      return true
    })
  }

  async run(id: string, args: Record<string, unknown>): Promise<unknown> {
    const spec = BY_ID.get(id)
    if (!spec) throw new CapabilityError(`unknown capability "${id}"`, id)
    const config = this.deps.config()
    if (spec.write && !config.allowWriteTools) {
      throw new CapabilityError('写入类工具已关闭（allowWriteTools=false）', id)
    }
    if (config.disabledGroups.includes(spec.group)) {
      throw new CapabilityError(`工具组 "${spec.group}" 已关闭`, id)
    }

    try {
      switch (id) {
        case 'system.status':
          return await this.systemStatus()
        case 'sessions.events': {
          const withId = await this.resolveArgs(getCapability('sessions.events')!, args)
          return await this.sessionEvents(withId, config)
        }
        case 'docs.info':
          return this.docsInfo()
        case 'docs.openapi':
          return await this.openApiSummary()
        default:
          return await this.dispatchRest(spec, await this.resolveArgs(spec, args), config)
      }
    } catch (err) {
      if (err instanceof CapabilityError) throw err
      if (err instanceof InvokeError) {
        throw new CapabilityError(err.message, id, err.status)
      }
      throw new CapabilityError((err as Error)?.message ?? String(err), id)
    }
  }

  // ---------------------------------------------------------------- REST

  private async dispatchRest(
    spec: CapabilitySpec,
    args: Record<string, unknown>,
    config: ResolvedConfig,
  ): Promise<unknown> {
    const path = spec.path.replace(/:([a-zA-Z0-9_]+)/g, (_match, name: string) => {
      const value = args[name]
      if (value === undefined || value === null || String(value) === '') {
        throw new CapabilityError(`缺少参数 "${name}"`, spec.id)
      }
      return encodeURIComponent(String(value))
    })

    const query: Record<string, string | number | boolean | undefined> = {}
    for (const key of spec.queryParams) {
      const value = args[key]
      if (value !== undefined && value !== null && value !== '') query[key] = value as string | number | boolean
    }

    let body: unknown
    if (spec.body === 'json') {
      const payload: Record<string, unknown> = {}
      for (const field of spec.bodyFields) {
        if (args[field] !== undefined) payload[field] = args[field]
      }
      body = payload
    } else if (spec.body === 'passthrough') {
      const payload: Record<string, unknown> = {}
      for (const field of spec.bodyFields) {
        if (args[field] !== undefined) payload[field] = args[field]
      }
      // `settings.patch` addresses the namespace in the path and sends the raw
      // patch object as the body.
      if (spec.id === 'settings.patch') {
        body = isPlainObject(args.patch) ? args.patch : payload
      } else {
        body = payload
      }
    } else if (spec.body === 'raw') {
      const encoding = String(args.encoding ?? 'base64').toLowerCase()
      const content = String(args.content ?? '')
      if (content === '') throw new CapabilityError('缺少参数 "content"', spec.id)
      body = Buffer.from(content, encoding === 'utf8' ? 'utf8' : 'base64')
      if (!query.filename && typeof args.filename === 'string') query.filename = args.filename
      if (Buffer.isBuffer(body) && body.length > config.maxUploadBytes) {
        throw new CapabilityError(
          `文件超过大小上限（${body.length} > ${config.maxUploadBytes} 字节）`,
          spec.id,
        )
      }
    }

    const timeoutMs = timeoutFor(spec, args, config)
    const headers: Record<string, string> = {}
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    if (spec.id === 'files.upload') {
      headers['content-type'] = 'application/octet-stream'
      if (typeof query.filename === 'string') headers['x-filename'] = query.filename
    }

    const response = await this.deps.invoker.invoke({
      method: spec.method,
      path,
      query,
      body,
      headers,
      timeoutMs,
    })

    const envelope = response.json as { ok?: boolean; data?: unknown; error?: string } | undefined
    if (envelope && envelope.ok === false) {
      throw new CapabilityError(envelope.error ?? `${spec.id} 执行失败`, spec.id, response.status)
    }
    if (envelope && 'data' in envelope) return envelope.data

    // Binary / streamed responses (file download, skill body, docs HTML).
    if (spec.id === 'files.download' || spec.id === 'docs.info') return response.text
    const contentType = response.headers['content-type'] ?? ''
    if (contentType.includes('application/json') || contentType.includes('text/')) return response.text
    return {
      contentType,
      bytes: response.raw.length,
      note: 'binary response not inlined for voice',
    }
  }

  // ------------------------------------------------------------ bespoke

  /**
   * Shared by the `dsh_status` tool and the bundled REST layer's
   * `GET /system/status`, so the two can never disagree.
   */
  async systemStatus(): Promise<unknown> {
    const ctx = this.deps.ctx
    const config = this.deps.config()
    const webServer = ctx.get('webServer') as { port?: number; host?: string } | undefined
    const llm = ctx.get('llm') as { listProviders?: () => { id: string }[] } | undefined
    const workspaceRegistry = ctx.get('workspaceRegistry') as { list?: () => unknown[] } | undefined

    return {
      name: 'dsh-xiaozhi',
      version: pluginVersion(),
      status: 'running',
      port: webServer?.port ?? 3080,
      host: webServer?.host ?? '127.0.0.1',
      apiPrefix: config.apiPathPrefix,
      workspacesCount: workspaceRegistry?.list?.()?.length ?? 0,
      providers: llm?.listProviders?.()?.map(provider => provider.id) ?? [],
      authEnabled: Boolean(config.apiKey),
      uptimeSeconds: Math.round(process.uptime()),
      cwd: process.cwd(),
      mcp: (this.deps.mcpStatus() ?? {}) as Record<string, unknown>,
    }
  }

  /**
   * `GET /sessions/:id/events` is an open-ended SSE stream, so over MCP it is
   * bounded: subscribe for `seconds` (default 5, max 30), then answer with a
   * compact digest instead of the raw event payloads.
   */
  private async sessionEvents(args: Record<string, unknown>, config: ResolvedConfig): Promise<unknown> {
    const sessionId = requireString(args.id, 'id')
    const seconds = Math.min(30, Math.max(1, toInt(args.seconds, 5)))
    const events: { seq: unknown; type: string; time: unknown; summary: string }[] = []
    const counts = new Map<string, number>()

    await new Promise<void>(resolve => {
      let settled = false
      const dispose = this.deps.ctx.on('session/event', (session: { id: unknown }, event: any) => {
        if (String(session?.id) !== sessionId) return
        const type = String(event?.type ?? 'unknown')
        counts.set(type, (counts.get(type) ?? 0) + 1)
        if (events.length < 200) {
          events.push({
            seq: event?.seq,
            type,
            time: event?.time,
            summary: summarizeEvent(event),
          })
        }
      })
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          dispose()
        } catch {
          /* already disposed */
        }
        resolve()
      }
      const timer = setTimeout(finish, seconds * 1000)
      timer.unref?.()
    })

    return {
      sessionId,
      windowSeconds: seconds,
      totalEvents: [...counts.values()].reduce((sum, n) => sum + n, 0),
      byType: Object.fromEntries(counts),
      events: events.slice(-config.listLimit * 3),
      note: events.length === 0 ? '时间窗内该会话没有产生事件（可能已空闲）' : undefined,
    }
  }

  private docsInfo(): unknown {
    const base = this.deps.apiBase()
    return {
      docsUrl: `${base}/docs`,
      openApiUrl: `${base}/openapi.json`,
      note: '交互式 API 文档与 OpenAPI 3.0 规范（浏览器打开；OpenAPI 文档较大，不适合语音朗读）',
      groups: TOOL_GROUPS.map(group => ({
        group,
        label: TOOL_GROUP_LABELS[group],
        capabilities: CAPABILITIES.filter(spec => spec.group === group).map(spec => ({
          id: spec.id,
          method: spec.method,
          path: spec.path,
          write: spec.write,
          summary: spec.summary,
        })),
      })),
      totalCapabilities: CAPABILITIES.length,
    }
  }

  /**
   * `GET /openapi.json` is hundreds of kilobytes; inlining it would blow the
   * voice budget and the MCP frame, so summarise it and keep the URL.
   */
  private async openApiSummary(): Promise<unknown> {
    const response = await this.deps.invoker.invoke({ method: 'GET', path: '/openapi.json' })
    const text = response.text
    try {
      const spec = JSON.parse(text) as {
        openapi?: string
        info?: { title?: string; version?: string }
        paths?: Record<string, unknown>
      }
      const paths = Object.keys(spec.paths ?? {})
      return {
        openapi: spec.openapi,
        title: spec.info?.title,
        specVersion: spec.info?.version,
        pathCount: paths.length,
        paths: paths.slice(0, 100),
        bytes: text.length,
        url: `${this.deps.apiBase()}/openapi.json`,
        note: paths.length > 100 ? `仅列出前 100 条路径，完整规范见 url` : undefined,
      }
    } catch {
      return {
        bytes: text.length,
        url: `${this.deps.apiBase()}/openapi.json`,
        note: 'OpenAPI 文档不是合法 JSON（可能路由未挂载），请检查 exposeDshApi 设置',
      }
    }
  }
}

function timeoutFor(spec: CapabilitySpec, args: Record<string, unknown>, config: ResolvedConfig): number {
  if (spec.id === 'conversation.prompt' || spec.id === 'conversation.promptStream') {
    const requested = toInt(args.timeoutMs, config.promptTimeoutMs)
    return Math.min(30 * MINUTE, Math.max(5_000, requested) + 5_000)
  }
  return spec.timeoutMs
}

function summarizeEvent(event: any): string {
  const data = event?.data ?? {}
  switch (String(event?.type)) {
    case 'turn/start':
      return `第 ${data.turn ?? '?'} 轮开始`
    case 'turn/end':
      return `第 ${data.turn ?? '?'} 轮结束${data.reason ? `（${data.reason}）` : ''}`
    case 'step/start':
      return `步骤 ${data.step ?? '?'} 开始`
    case 'step/end':
      return `步骤 ${data.step ?? '?'} 结束`
    case 'tool/call':
      return `调用工具 ${data.name ?? '?'}`
    case 'tool/result':
      return `工具${data.isError ? '失败' : '完成'}`
    case 'assistant/message':
      return '助手消息'
    case 'error':
      return `错误：${clip(String(data.message ?? ''), 80)}`
    default:
      return ''
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Mirror of the tool layer's `shortId`: strip the `session-` prefix, then 8 chars. */
function shortRefId(id: string): string {
  const text = id.replace(/^session-/, '')
  return text.length > 8 ? text.slice(0, 8) : text
}

function requireString(value: unknown, name: string): string {
  const text = value === undefined || value === null ? '' : String(value).trim()
  if (text === '') throw new CapabilityError(`缺少参数 "${name}"`)
  return text
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

let cachedVersion: string | undefined
export function pluginVersion(): string {
  const known = cachedVersion
  if (known !== undefined) return known
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg.version === 'string') version = pkg.version
  } catch {
    /* fall back to 0.0.0 */
  }
  cachedVersion = version
  return version
}
