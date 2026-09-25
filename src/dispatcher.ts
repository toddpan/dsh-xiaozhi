/**
 * dsh-xiaozhi - in-process invocation of the bundled REST layer.
 *
 * MCP tools need the *semantics* of the DSH Web REST API (exactly what the
 * reference plugin exposes to third parties) without paying for a loopback TCP
 * round trip, without depending on which host/port the DSH web server bound,
 * and without having to satisfy its auth layer. So each capability is executed
 * by handing a synthesised `IncomingMessage`/`ServerResponse` pair straight to
 * `HttpRouter.dispatch`.
 *
 * The response stand-in is a real `Writable`, because the copied file routes
 * stream downloads with `createReadStream(...).pipe(res)`.
 */

import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpRouter } from './dshapi/router.js'

export interface InvokeRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path **without** the mount prefix, e.g. `/sessions/abc/history`. */
  path: string
  query?: Record<string, string | number | boolean | undefined | null>
  /** JSON body, or a Buffer when the route reads a raw body. */
  body?: unknown
  headers?: Record<string, string>
  /** Abort/timeout for this invocation. @default 30_000 */
  timeoutMs?: number
}

export interface InvokeResponse {
  status: number
  headers: Record<string, string>
  /** Response body decoded as UTF-8 (may be base64 for binary — see `raw`). */
  text: string
  /** Parsed JSON when the body was JSON, else `undefined`. */
  json: unknown
  raw: Buffer
}

export class InvokeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'InvokeError'
  }
}

/** `ServerResponse` stand-in that captures status, headers and body. */
/**
 * A `ServerResponse` stand-in that buffers instead of writing to a socket.
 *
 * It must be a real `Writable`: the copied file/skill routes do
 * `createReadStream(...).pipe(res)` and `initSseStream` calls `writeHead` and
 * `flushHeaders`, so a duck-typed object would break those paths.
 */
export class CaptureResponse extends Writable {
  statusCode = 200
  private readonly headerMap = new Map<string, string>()
  private readonly chunks: Buffer[] = []
  private started = false
  private finished = false
  private resolveDone!: (value: { status: number; headers: Record<string, string>; raw: Buffer }) => void
  private rejectDone!: (err: Error) => void
  readonly done: Promise<{ status: number; headers: Record<string, string>; raw: Buffer }>

  constructor() {
    super()
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    // Writable emits 'error' for write-after-end etc.; surface it instead of
    // crashing the host with an unhandled 'error' event.
    this.on('error', err => this.rejectDone(err))
  }

  get headersSent(): boolean {
    return this.started
  }

  getHeader(name: string): string | undefined {
    return this.headerMap.get(String(name).toLowerCase())
  }

  setHeader(name: string, value: unknown): this {
    this.headerMap.set(String(name).toLowerCase(), String(value))
    return this
  }

  removeHeader(name: string): void {
    this.headerMap.delete(String(name).toLowerCase())
  }

  getHeaders(): Record<string, string> {
    return Object.fromEntries(this.headerMap)
  }

  writeHead(statusCode: number, headers?: Record<string, unknown>): this {
    this.statusCode = statusCode
    for (const [key, value] of Object.entries(headers ?? {})) this.setHeader(key, value)
    // Node's ServerResponse marks headers as sent here, and routes rely on it:
    // `sendJson` bails out when `headersSent` is already true, so emulating
    // this exactly is what keeps a stray writeHead from silently swallowing a
    // response body in production.
    this.started = true
    return this
  }

  flushHeaders(): void {
    this.started = true
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    this.started = true
    try {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  override _final(callback: (err?: Error | null) => void): void {
    this.started = true
    this.finished = true
    this.resolveDone({
      status: this.statusCode,
      headers: this.getHeaders(),
      raw: Buffer.concat(this.chunks),
    })
    callback()
  }

  /**
   * Handler never called `end()` (e.g. an SSE route that stays open): fail the
   * capture instead of hanging. Pass the *same* error the caller will throw, so
   * whichever promise settles first surfaces an identical, diagnosable cause.
   */
  abort(reason: string | Error): void {
    this.rejectDone(typeof reason === 'string' ? new Error(reason) : reason)
  }
}

function buildQueryString(query: InvokeRequest['query']): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.append(key, String(value))
  }
  const encoded = params.toString()
  return encoded === '' ? '' : `?${encoded}`
}

/** Drives the bundled router without touching a TCP socket. */
export class LocalInvoker {
  constructor(
    private readonly router: HttpRouter,
    private readonly prefix: string,
  ) {}

  async invoke(request: InvokeRequest): Promise<InvokeResponse> {
    const isJson = request.body !== undefined && !Buffer.isBuffer(request.body)
    const rawBody: Buffer | undefined =
      request.body === undefined
        ? undefined
        : Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(JSON.stringify(request.body), 'utf8')

    const headers: Record<string, string> = {
      host: '127.0.0.1',
      ...(isJson ? { 'content-type': 'application/json' } : {}),
      ...(request.headers ?? {}),
    }
    if (rawBody !== undefined) headers['content-length'] = String(rawBody.length)

    const req = Readable.from(rawBody === undefined ? [] : [rawBody], { objectMode: false }) as unknown as IncomingMessage & {
      method?: string
      url?: string
      headers: Record<string, string>
    }
    req.method = request.method
    req.url = `${this.prefix}${request.path}${buildQueryString(request.query)}`
    req.headers = headers

    // A plain intersection with `ServerResponse` collapses to `never` (the
    // private `finished` slot conflicts), so keep the capture object typed and
    // hand the router the widened view.
    const capture = new CaptureResponse()
    const res = capture as unknown as ServerResponse

    const timeoutMs = request.timeoutMs ?? 30_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // One shared error for both the capture and the race: rejecting the
        // capture first would otherwise win the race with a status-less Error
        // and hide the real 504 from the caller.
        const failure = new InvokeError(`route timed out after ${timeoutMs}ms`, 504)
        capture.abort(failure)
        reject(failure)
      }, timeoutMs)
      // Deliberately not unref'd: this only ever runs inside the long-lived DSH
      // host, and an unref'd timer lets Node drain the event loop while this
      // promise is still pending, turning a hung route into a silent stall
      // instead of a diagnosable 504.
    })

    const handled = this.router.dispatch(req, res, this.prefix)
    // Whichever branch of the race loses may still settle later; pre-attach a
    // no-op catch so a late rejection cannot surface as an unhandled rejection.
    void handled.catch(() => undefined)
    void capture.done.catch(() => undefined)
    let result: { status: number; headers: Record<string, string>; raw: Buffer }
    try {
      const dispatchResult = await Promise.race([handled, timeout])
      if (dispatchResult === false) {
        throw new InvokeError(`no route for ${request.method} ${request.path}`, 404)
      }
      result = await Promise.race([capture.done, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }

    const text = result.raw.toString('utf8')
    let json: unknown
    const contentType = result.headers['content-type'] ?? ''
    if (contentType.includes('application/json') || (text.startsWith('{') && text.endsWith('}'))) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }

    const response: InvokeResponse = {
      status: result.status,
      headers: result.headers,
      text,
      json,
      raw: result.raw,
    }
    if (result.status >= 400) {
      const message =
        (json as { error?: string } | undefined)?.error ??
        `internal route ${request.method} ${request.path} answered HTTP ${result.status}`
      throw new InvokeError(message, result.status, json)
    }
    return response
  }

  /** Convenience: invoke and require a JSON `{ ok, data }` envelope payload. */
  async invokeData<T = unknown>(request: InvokeRequest): Promise<T> {
    const response = await this.invoke(request)
    const envelope = response.json as { ok?: boolean; data?: T; error?: string } | undefined
    if (envelope === undefined) {
      throw new InvokeError(`route ${request.path} did not answer JSON`, 502, response.text.slice(0, 400))
    }
    if (envelope.ok === false) {
      throw new InvokeError(envelope.error ?? `route ${request.path} failed`, response.status, envelope)
    }
    return envelope.data as T
  }
}
