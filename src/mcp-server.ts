/**
 * dsh-xiaozhi - MCP tool-provider session.
 *
 * One `McpSession` wraps one WebSocket connection and serves the Xiaozhi side
 * as an MCP server: it answers `initialize`, `ping`, `tools/list` and
 * `tools/call` requests. Both transport directions reuse exactly this class —
 * `mode: endpoint` (DSH dials the Xiaozhi access point) and `mode: server`
 * (Xiaozhi dials DSH) differ only in who opened the socket.
 *
 * Why the server role in both directions: the reference ESP32 library
 * (`xiaozhi-esp32-mcp/src/WebSocketMCP.cpp`) *responds* to those four methods,
 * i.e. the device owns the tools and the platform drives. DSH holds the tools,
 * so it must answer, never ask.
 */

import type { WsCloseInfo, WsConnection } from './ws.js'
import {
  RPC_ERROR,
  clip,
  initializeResult,
  parseEnvelope,
  readToolCall,
  rpcError,
  rpcNotification,
  rpcResult,
  toolsListResult,
  type McpToolDefinition,
  type ToolCallResult,
} from './protocol.js'

export type ConnectionState = 'disabled' | 'idle' | 'connecting' | 'ready' | 'error'

export interface McpSessionDeps {
  /** Current MCP tool payload (already filtered by config). */
  tools: () => McpToolDefinition[]
  /** Execute a tool; must never throw. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>
  serverName: () => string
  serverVersion: string
  /** Mirror the reference implementation's `notifications/initialized` reply. */
  sendInitializedNotification: () => boolean
  log: (message: string) => void
  /** Max concurrently running tool calls per session. @default 8 */
  maxConcurrentCalls?: number
}

export interface McpSessionStats {
  messagesIn: number
  messagesOut: number
  initializeCalls: number
  toolsListCalls: number
  toolCalls: number
  toolErrors: number
  lastMethod: string
  lastActivityAt: number
}

export class McpSession {
  readonly stats: McpSessionStats = {
    messagesIn: 0,
    messagesOut: 0,
    initializeCalls: 0,
    toolsListCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    lastMethod: '',
    lastActivityAt: 0,
  }

  /** True once the peer completed the `initialize` handshake. */
  initialized = false
  closed = false

  private inFlight = 0
  private readonly queue: (() => void)[] = []
  private disposed = false

  constructor(
    private readonly connection: WsConnection,
    private readonly deps: McpSessionDeps,
  ) {
    connection.onMessage(text => {
      void this.handle(text)
    })
    connection.onError(err => this.deps.log(`transport error: ${err.message}`))
    connection.onClose(info => this.onClose(info))
  }

  /** Send a raw JSON-RPC frame (used by tests and by the session itself). */
  send(frame: string): boolean {
    const ok = this.connection.send(frame)
    if (ok) this.stats.messagesOut += 1
    return ok
  }

  close(code = 1000, reason = ''): void {
    this.connection.close(code, reason)
  }

  private onClose(info: WsCloseInfo): void {
    this.closed = true
    this.disposed = true
    this.deps.log(`connection closed (${info.code}${info.reason ? `: ${info.reason}` : ''})`)
  }

  private async handle(raw: string): Promise<void> {
    if (this.disposed) return
    this.stats.messagesIn += 1
    this.stats.lastActivityAt = Date.now()

    const envelope = parseEnvelope(raw)
    switch (envelope.kind) {
      case 'invalid':
        this.deps.log(`ignoring inbound frame: ${envelope.reason}`)
        return
      case 'result':
      case 'error':
        // We never issue requests, so a response is a protocol surprise. Log it
        // rather than answering, to avoid a ping-pong loop with a broken peer.
        this.deps.log(`unexpected ${envelope.kind} for id=${String(envelope.id)}`)
        return
      case 'notification':
        this.stats.lastMethod = envelope.method
        if (envelope.method === 'notifications/initialized') this.initialized = true
        else this.deps.log(`notification ${envelope.method} ignored`)
        return
      case 'request':
        break
      default:
        return
    }

    const { id, method, params } = envelope
    this.stats.lastMethod = method

    switch (method) {
      case 'initialize': {
        this.stats.initializeCalls += 1
        this.initialized = true
        this.send(rpcResult(id, initializeResult(this.deps.serverName(), this.deps.serverVersion)))
        if (this.deps.sendInitializedNotification()) {
          this.send(rpcNotification('notifications/initialized'))
        }
        return
      }
      case 'ping': {
        this.send(rpcResult(id, {}))
        return
      }
      case 'tools/list': {
        this.stats.toolsListCalls += 1
        this.send(rpcResult(id, toolsListResult(this.deps.tools())))
        return
      }
      case 'resources/list': {
        this.send(rpcResult(id, { resources: [] }))
        return
      }
      case 'prompts/list': {
        this.send(rpcResult(id, { prompts: [] }))
        return
      }
      case 'tools/call': {
        const call = readToolCall(params)
        if (!call) {
          this.send(rpcError(id, RPC_ERROR.INVALID_PARAMS, 'tools/call 需要一个 name 参数'))
          return
        }
        this.stats.toolCalls += 1
        // Answer asynchronously: a long DSH turn must not block `ping`.
        void this.enqueue(async () => {
          if (this.disposed) return
          try {
            const result = await this.deps.callTool(call.name, call.arguments)
            if (result.isError) this.stats.toolErrors += 1
            this.send(rpcResult(id, result))
          } catch (err) {
            this.stats.toolErrors += 1
            this.send(
              rpcResult(id, {
                content: [
                  {
                    type: 'text',
                    text: `执行工具 ${call.name} 时发生内部错误：${clip((err as Error)?.message ?? String(err), 300)}`,
                  },
                ],
                isError: true,
              }),
            )
          }
        })
        return
      }
      default: {
        this.deps.log(`unsupported method ${method}`)
        this.send(rpcError(id, RPC_ERROR.METHOD_NOT_FOUND, `不支持的方法：${method}`))
        return
      }
    }
  }

  private enqueue(task: () => Promise<void>): void {
    const max = this.deps.maxConcurrentCalls ?? 8
    const run = () => {
      this.inFlight += 1
      void task()
        .catch(() => undefined)
        .finally(() => {
          this.inFlight -= 1
          this.queue.shift()?.()
        })
    }
    if (this.inFlight < max) run()
    else this.queue.push(run)
  }
}

/** Format for the DSH log / settings page troubleshooting panel. */
export function describeStats(stats: McpSessionStats): string {
  return [
    `in=${stats.messagesIn}`,
    `out=${stats.messagesOut}`,
    `initialize=${stats.initializeCalls}`,
    `tools/list=${stats.toolsListCalls}`,
    `tools/call=${stats.toolCalls}`,
    `errors=${stats.toolErrors}`,
  ].join(' ')
}
