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
import { Writable } from 'node:stream';
import { HttpRouter } from './dshapi/router.js';
export interface InvokeRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Path **without** the mount prefix, e.g. `/sessions/abc/history`. */
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    /** JSON body, or a Buffer when the route reads a raw body. */
    body?: unknown;
    headers?: Record<string, string>;
    /** Abort/timeout for this invocation. @default 30_000 */
    timeoutMs?: number;
}
export interface InvokeResponse {
    status: number;
    headers: Record<string, string>;
    /** Response body decoded as UTF-8 (may be base64 for binary — see `raw`). */
    text: string;
    /** Parsed JSON when the body was JSON, else `undefined`. */
    json: unknown;
    raw: Buffer;
}
export declare class InvokeError extends Error {
    readonly status: number;
    readonly body?: unknown | undefined;
    constructor(message: string, status: number, body?: unknown | undefined);
}
/** `ServerResponse` stand-in that captures status, headers and body. */
/**
 * A `ServerResponse` stand-in that buffers instead of writing to a socket.
 *
 * It must be a real `Writable`: the copied file/skill routes do
 * `createReadStream(...).pipe(res)` and `initSseStream` calls `writeHead` and
 * `flushHeaders`, so a duck-typed object would break those paths.
 */
export declare class CaptureResponse extends Writable {
    statusCode: number;
    private readonly headerMap;
    private readonly chunks;
    private started;
    private finished;
    private resolveDone;
    private rejectDone;
    readonly done: Promise<{
        status: number;
        headers: Record<string, string>;
        raw: Buffer;
    }>;
    constructor();
    get headersSent(): boolean;
    getHeader(name: string): string | undefined;
    setHeader(name: string, value: unknown): this;
    removeHeader(name: string): void;
    getHeaders(): Record<string, string>;
    writeHead(statusCode: number, headers?: Record<string, unknown>): this;
    flushHeaders(): void;
    _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (err?: Error | null) => void): void;
    _final(callback: (err?: Error | null) => void): void;
    /**
     * Handler never called `end()` (e.g. an SSE route that stays open): fail the
     * capture instead of hanging. Pass the *same* error the caller will throw, so
     * whichever promise settles first surfaces an identical, diagnosable cause.
     */
    abort(reason: string | Error): void;
}
/** Drives the bundled router without touching a TCP socket. */
export declare class LocalInvoker {
    private readonly router;
    private readonly prefix;
    constructor(router: HttpRouter, prefix: string);
    invoke(request: InvokeRequest): Promise<InvokeResponse>;
    /** Convenience: invoke and require a JSON `{ ok, data }` envelope payload. */
    invokeData<T = unknown>(request: InvokeRequest): Promise<T>;
}
