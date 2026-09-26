/**
 * dsh-xiaozhi - MCP transports.
 *
 * `mode: endpoint` (default) — DSH dials out to the Xiaozhi MCP access point
 * (`wss://api.xiaozhi.me/mcp/?token=…`) with reconnect/backoff and an RFC 6455
 * heartbeat. This is the reference topology: a device/plugin behind NAT can
 * still register its tools.
 *
 * `mode: server` — DSH hosts the endpoint instead, on `ctx.webServer`
 * (`registerUpgrade`) and/or a standalone listener, which is what a
 * self-hosted `xiaozhi-esp32-server` expects in its `mcp_endpoint` setting.
 */
import { createServer } from 'node:http';
import { maskEndpoint } from './config.js';
import { acceptUpgrade, connectWebSocket } from './ws.js';
/** Shared bookkeeping both transports report through. */
export class TransportStatus {
    state = 'idle';
    connected = false;
    connectedAt;
    lastError;
    connectedClients = 0;
    extra = {};
    setState(state, error) {
        this.state = state;
        this.connected = state === 'ready';
        if (state === 'ready') {
            this.connectedAt = Date.now();
            this.lastError = undefined;
        }
        else if (error !== undefined) {
            this.lastError = error;
        }
    }
}
/**
 * Outbound (MCP access point) transport with exponential backoff.
 * `start()` is synchronous; reconnection runs on timers owned by the transport.
 * One instance dials one access point; multi-device configs own one each.
 */
export class EndpointTransport {
    options;
    ws;
    session;
    stopped = false;
    attempt = 0;
    retryTimer;
    heartbeatTimer;
    handshakeTimer;
    constructor(options) {
        this.options = options;
    }
    targetUrl() {
        return this.options.url ? this.options.url() : this.options.config().endpointUrl;
    }
    targetHeaders() {
        return this.options.headers ? this.options.headers() : this.options.config().endpointHeaders;
    }
    start() {
        this.stopped = false;
        void this.connectOnce();
    }
    stop(code = 1000, reason = 'shutdown') {
        this.stopped = true;
        this.clearTimers();
        try {
            this.session?.close(code, reason);
        }
        catch {
            /* ignore */
        }
        try {
            this.ws?.close(code, reason);
        }
        catch {
            /* ignore */
        }
        this.ws = undefined;
        this.session = undefined;
        this.options.status.setState('idle');
    }
    snapshot() {
        return {
            mode: 'endpoint',
            state: this.options.status.state,
            connected: this.options.status.connected,
            endpointUrl: maskEndpoint(this.targetUrl()),
            id: this.options.describe?.id,
            name: this.options.describe?.name,
            connectedAt: this.options.status.connectedAt,
            lastError: this.options.status.lastError,
        };
    }
    /** Force an immediate reconnect (used by the settings page "reconnect" action). */
    reconnect() {
        this.options.log('manual reconnect requested');
        this.attempt = 0;
        this.clearRetry();
        if (this.ws) {
            try {
                this.ws.close(1000, 'manual reconnect');
            }
            catch {
                /* ignore */
            }
            this.ws = undefined;
            this.session = undefined;
        }
        if (!this.stopped)
            void this.connectOnce();
    }
    clearTimers() {
        this.clearRetry();
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = undefined;
        }
    }
    clearRetry() {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
    }
    async connectOnce() {
        if (this.stopped)
            return;
        const url = this.targetUrl().trim();
        if (url === '') {
            this.options.status.setState('idle');
            this.options.status.lastError = '未配置小智 MCP 接入点地址';
            return;
        }
        this.options.status.setState('connecting');
        const connect = this.options.connect ?? connectWebSocket;
        try {
            const ws = await connect(url, {
                headers: this.targetHeaders(),
                handshakeTimeoutMs: 15_000,
            });
            if (this.stopped) {
                ws.close(1000, 'stopped');
                return;
            }
            this.attempt = 0;
            this.ws = ws;
            this.session = this.options.createSession(ws);
            this.options.status.setState('ready');
            this.options.log(`connected to ${maskEndpoint(url)}`);
            this.startHeartbeat();
            ws.onClose(() => {
                this.stopHeartbeat();
                this.ws = undefined;
                this.session = undefined;
                if (!this.stopped) {
                    this.options.status.setState('idle', 'connection closed');
                    this.scheduleRetry();
                }
            });
        }
        catch (err) {
            const message = err?.message ?? String(err);
            this.options.status.setState('error', message);
            this.options.log(`connect failed: ${message}`);
            this.scheduleRetry();
        }
    }
    scheduleRetry() {
        if (this.stopped || this.retryTimer)
            return;
        const config = this.options.config();
        this.attempt += 1;
        const base = Math.min(config.reconnectMaxMs, config.reconnectMinMs * 2 ** Math.min(this.attempt - 1, 10));
        const jitter = Math.round(base * 0.2 * Math.random());
        const delay = base + jitter;
        this.options.log(`reconnect in ${delay}ms (attempt ${this.attempt})`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.connectOnce();
        }, delay);
        this.retryTimer.unref?.();
    }
    startHeartbeat() {
        this.stopHeartbeat();
        const config = this.options.config();
        this.heartbeatTimer = setInterval(() => {
            if (!this.ws || this.ws.closed)
                return;
            if (!this.ws.ping())
                this.options.log('heartbeat ping failed');
        }, config.heartbeatMs);
        this.heartbeatTimer.unref?.();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = undefined;
        }
    }
}
/** Inbound transport: an exact-path upgrade route plus an optional standalone port. */
export class ServerTransport {
    options;
    disposers = [];
    standalone;
    sessions = new Map();
    constructor(options) {
        this.options = options;
    }
    start() {
        const config = this.options.config();
        const webServer = this.options.ctx.get('webServer');
        if (webServer?.registerUpgrade) {
            const dispose = webServer.registerUpgrade({
                path: config.serverPath,
                handler: (req, socket, head) => this.handleUpgrade(req, socket, head, config.serverPath),
            });
            this.disposers.push(dispose);
            this.options.log(`mounted MCP upgrade route at ${config.serverPath}`);
        }
        else {
            this.options.log('webServer has no registerUpgrade; falling back to the standalone listener only');
        }
        if (config.serverPort > 0) {
            const server = createServer((_req, res) => {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ok: false, error: 'this port only serves the Xiaozhi MCP WebSocket upgrade' }));
            });
            server.on('upgrade', (req, socket, head) => {
                const pathname = safePathname(req.url);
                if (pathname !== config.serverPath) {
                    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
                    socket.destroy();
                    return;
                }
                this.handleUpgrade(req, socket, head, config.serverPath);
            });
            server.on('error', err => {
                this.options.status.lastError = `standalone listener error: ${err.message}`;
                this.options.log(this.options.status.lastError);
            });
            server.listen(config.serverPort, '0.0.0.0');
            this.standalone = server;
            this.options.log(`standalone MCP listener on 0.0.0.0:${config.serverPort}${config.serverPath}`);
        }
        this.options.status.setState('ready');
    }
    stop() {
        for (const dispose of this.disposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                /* ignore */
            }
        }
        for (const session of this.sessions.keys()) {
            try {
                session.close(1001, 'server shutting down');
            }
            catch {
                /* ignore */
            }
        }
        this.sessions.clear();
        if (this.standalone) {
            try {
                this.standalone.close();
            }
            catch {
                /* ignore */
            }
            this.standalone = undefined;
        }
        this.options.status.setState('idle');
    }
    snapshot() {
        const config = this.options.config();
        return {
            mode: 'server',
            state: this.options.status.state,
            connected: this.options.status.connected,
            serverPath: config.serverPath,
            serverPort: config.serverPort,
            listenUrls: this.listenUrls(config),
            connectedClients: this.sessions.size,
            sessions: [...this.sessions.values()].map(entry => ({
                remote: entry.remote,
                since: entry.since,
                initialized: entry.initialized ?? false,
            })),
            lastError: this.options.status.lastError,
        };
    }
    listenUrls(config) {
        const webServer = this.options.ctx.get('webServer');
        const urls = [];
        const push = (port, host) => {
            const tokenQuery = config.serverToken ? `?token=${encodeURIComponent(config.serverToken)}` : '';
            urls.push(`ws://${host}:${port}${config.serverPath}${tokenQuery}`);
        };
        if (webServer?.port)
            push(webServer.port, webServer.host === '0.0.0.0' ? '<本机 IP>' : '127.0.0.1');
        if (config.serverPort > 0)
            push(config.serverPort, '<本机 IP>');
        return urls;
    }
    handleUpgrade(req, socket, head, expectedPath) {
        const config = this.options.config();
        const pathname = safePathname(req.url);
        if (pathname !== expectedPath) {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        if (config.serverToken) {
            const token = safeQuery(req.url).get('token') ?? String(req.headers['x-dsh-xiaozhi-token'] ?? '');
            if (token !== config.serverToken) {
                this.options.log('rejected upgrade: bad token');
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        const connection = acceptUpgrade(req, socket, head);
        if (!connection) {
            this.options.log('rejected upgrade: not a valid WebSocket handshake');
            return;
        }
        const remote = String(req.socket?.remoteAddress ?? 'unknown');
        const session = this.options.createSession(connection, remote);
        this.sessions.set(session, { remote, since: Date.now() });
        const entry = this.sessions.get(session);
        Object.defineProperty(entry, 'initialized', {
            get: () => session.initialized,
        });
        this.options.status.connectedClients = this.sessions.size;
        this.options.status.setState('ready');
        this.options.log(`accepted MCP client ${remote}`);
        connection.onClose(() => {
            this.sessions.delete(session);
            this.options.status.connectedClients = this.sessions.size;
            this.options.log(`MCP client ${remote} disconnected`);
        });
    }
}
export { maskEndpoint };
function safePathname(url) {
    try {
        return new URL(url ?? '/', 'http://localhost').pathname;
    }
    catch {
        return '/';
    }
}
function safeQuery(url) {
    try {
        return new URL(url ?? '/', 'http://localhost').searchParams;
    }
    catch {
        return new URLSearchParams();
    }
}
//# sourceMappingURL=transports.js.map