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
import { Readable, Writable } from 'node:stream';
export class InvokeError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = 'InvokeError';
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
    statusCode = 200;
    headerMap = new Map();
    chunks = [];
    started = false;
    finished = false;
    resolveDone;
    rejectDone;
    done;
    constructor() {
        super();
        this.done = new Promise((resolve, reject) => {
            this.resolveDone = resolve;
            this.rejectDone = reject;
        });
        // Writable emits 'error' for write-after-end etc.; surface it instead of
        // crashing the host with an unhandled 'error' event.
        this.on('error', err => this.rejectDone(err));
    }
    get headersSent() {
        return this.started;
    }
    getHeader(name) {
        return this.headerMap.get(String(name).toLowerCase());
    }
    setHeader(name, value) {
        this.headerMap.set(String(name).toLowerCase(), String(value));
        return this;
    }
    removeHeader(name) {
        this.headerMap.delete(String(name).toLowerCase());
    }
    getHeaders() {
        return Object.fromEntries(this.headerMap);
    }
    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        for (const [key, value] of Object.entries(headers ?? {}))
            this.setHeader(key, value);
        // Node's ServerResponse marks headers as sent here, and routes rely on it:
        // `sendJson` bails out when `headersSent` is already true, so emulating
        // this exactly is what keeps a stray writeHead from silently swallowing a
        // response body in production.
        this.started = true;
        return this;
    }
    flushHeaders() {
        this.started = true;
    }
    _write(chunk, encoding, callback) {
        this.started = true;
        try {
            this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
            callback();
        }
        catch (err) {
            callback(err);
        }
    }
    _final(callback) {
        this.started = true;
        this.finished = true;
        this.resolveDone({
            status: this.statusCode,
            headers: this.getHeaders(),
            raw: Buffer.concat(this.chunks),
        });
        callback();
    }
    /**
     * Handler never called `end()` (e.g. an SSE route that stays open): fail the
     * capture instead of hanging. Pass the *same* error the caller will throw, so
     * whichever promise settles first surfaces an identical, diagnosable cause.
     */
    abort(reason) {
        this.rejectDone(typeof reason === 'string' ? new Error(reason) : reason);
    }
}
function buildQueryString(query) {
    if (!query)
        return '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '')
            continue;
        params.append(key, String(value));
    }
    const encoded = params.toString();
    return encoded === '' ? '' : `?${encoded}`;
}
/** Drives the bundled router without touching a TCP socket. */
export class LocalInvoker {
    router;
    prefix;
    constructor(router, prefix) {
        this.router = router;
        this.prefix = prefix;
    }
    async invoke(request) {
        const isJson = request.body !== undefined && !Buffer.isBuffer(request.body);
        const rawBody = request.body === undefined
            ? undefined
            : Buffer.isBuffer(request.body)
                ? request.body
                : Buffer.from(JSON.stringify(request.body), 'utf8');
        const headers = {
            host: '127.0.0.1',
            ...(isJson ? { 'content-type': 'application/json' } : {}),
            ...(request.headers ?? {}),
        };
        if (rawBody !== undefined)
            headers['content-length'] = String(rawBody.length);
        const req = Readable.from(rawBody === undefined ? [] : [rawBody], { objectMode: false });
        req.method = request.method;
        req.url = `${this.prefix}${request.path}${buildQueryString(request.query)}`;
        req.headers = headers;
        // A plain intersection with `ServerResponse` collapses to `never` (the
        // private `finished` slot conflicts), so keep the capture object typed and
        // hand the router the widened view.
        const capture = new CaptureResponse();
        const res = capture;
        const timeoutMs = request.timeoutMs ?? 30_000;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                // One shared error for both the capture and the race: rejecting the
                // capture first would otherwise win the race with a status-less Error
                // and hide the real 504 from the caller.
                const failure = new InvokeError(`route timed out after ${timeoutMs}ms`, 504);
                capture.abort(failure);
                reject(failure);
            }, timeoutMs);
            // Deliberately not unref'd: this only ever runs inside the long-lived DSH
            // host, and an unref'd timer lets Node drain the event loop while this
            // promise is still pending, turning a hung route into a silent stall
            // instead of a diagnosable 504.
        });
        const handled = this.router.dispatch(req, res, this.prefix);
        // Whichever branch of the race loses may still settle later; pre-attach a
        // no-op catch so a late rejection cannot surface as an unhandled rejection.
        void handled.catch(() => undefined);
        void capture.done.catch(() => undefined);
        let result;
        try {
            const dispatchResult = await Promise.race([handled, timeout]);
            if (dispatchResult === false) {
                throw new InvokeError(`no route for ${request.method} ${request.path}`, 404);
            }
            result = await Promise.race([capture.done, timeout]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        const text = result.raw.toString('utf8');
        let json;
        const contentType = result.headers['content-type'] ?? '';
        if (contentType.includes('application/json') || (text.startsWith('{') && text.endsWith('}'))) {
            try {
                json = JSON.parse(text);
            }
            catch {
                json = undefined;
            }
        }
        const response = {
            status: result.status,
            headers: result.headers,
            text,
            json,
            raw: result.raw,
        };
        if (result.status >= 400) {
            const message = json?.error ??
                `internal route ${request.method} ${request.path} answered HTTP ${result.status}`;
            throw new InvokeError(message, result.status, json);
        }
        return response;
    }
    /** Convenience: invoke and require a JSON `{ ok, data }` envelope payload. */
    async invokeData(request) {
        const response = await this.invoke(request);
        const envelope = response.json;
        if (envelope === undefined) {
            throw new InvokeError(`route ${request.path} did not answer JSON`, 502, response.text.slice(0, 400));
        }
        if (envelope.ok === false) {
            throw new InvokeError(envelope.error ?? `route ${request.path} failed`, response.status, envelope);
        }
        return envelope.data;
    }
}
//# sourceMappingURL=dispatcher.js.map