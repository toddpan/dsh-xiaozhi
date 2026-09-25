/**
 * dsh-xiaozhi - dependency-free RFC 6455 WebSocket.
 *
 * The plugin must run inside a profile whose `node_modules` contains only the
 * packages the profile installed, so pulling in `ws` would add an install-time
 * dependency for a ~250-line protocol. This file implements the subset both
 * Xiaozhi transports need:
 *
 *   - the outbound client used by `mode: endpoint` (Xiaozhi MCP access point),
 *   - the inbound server used by `mode: server` (`ctx.webServer.registerUpgrade`).
 *
 * Supported: text frames, fragmentation (continuation), ping/pong keepalive,
 * close handshake, masking in the correct direction, 7/16/64-bit payload
 * lengths, and a hard payload cap. Unsupported (and rejected): extensions,
 * binary payloads are accepted but surfaced as text only when asked, and
 * permessage-deflate (never negotiated).
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_PAYLOAD = 8 * 1024 * 1024;
function acceptKey(key) {
    return createHash('sha1').update(key + GUID).digest('base64');
}
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
/**
 * Encode one frame. Outbound frames are never fragmented (`fin` defaults to
 * true); the parameter exists so tests can synthesise fragmented and
 * non-final control frames.
 */
function encodeFrame(opcode, payload, mask, fin = true) {
    const len = payload.length;
    let headerLength = 2;
    if (len >= 65536)
        headerLength += 8;
    else if (len >= 126)
        headerLength += 2;
    if (mask)
        headerLength += 4;
    const frame = Buffer.allocUnsafe(headerLength + len);
    frame[0] = (fin ? 0x80 : 0x00) | opcode;
    let offset = 2;
    if (len >= 65536) {
        frame[1] = 127;
        frame.writeUInt32BE(0, 2);
        frame.writeUInt32BE(len, 6);
        offset = 10;
    }
    else if (len >= 126) {
        frame[1] = 126;
        frame.writeUInt16BE(len, 2);
        offset = 4;
    }
    else {
        frame[1] = len;
    }
    if (mask) {
        frame[1] |= 0x80;
        const key = randomBytes(4);
        key.copy(frame, offset);
        offset += 4;
        for (let i = 0; i < len; i++)
            frame[offset + i] = payload[i] ^ key[i & 3];
    }
    else if (len > 0) {
        payload.copy(frame, offset);
    }
    return frame;
}
/** Incremental frame decoder. One instance per connection. */
/** Raised for any RFC 6455 violation; `push` converts it into onProtocolError. */
class WsProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WsProtocolError';
    }
}
class FrameDecoder {
    handlers;
    maxPayloadBytes;
    expectMasked;
    buffer = Buffer.alloc(0);
    fragmentOpcode = 0;
    fragments = [];
    fragmentBytes = 0;
    constructor(handlers, maxPayloadBytes, 
    /**
     * Whether inbound frames must be masked. RFC 6455 masks client→server
     * frames only, so the server side expects masked and the client side
     * expects unmasked. `undefined` disables the check (unit tests).
     */
    expectMasked = undefined) {
        this.handlers = handlers;
        this.maxPayloadBytes = maxPayloadBytes;
        this.expectMasked = expectMasked;
    }
    push(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        try {
            for (;;) {
                const consumed = this.decodeOne();
                if (consumed === 0)
                    return;
                this.buffer = this.buffer.subarray(consumed);
            }
        }
        catch (err) {
            this.handlers.onProtocolError(err instanceof WsProtocolError ? err.message : 'protocol error: malformed frame');
        }
    }
    /** @returns byte count consumed, 0 when the buffer holds an incomplete frame. */
    decodeOne() {
        const buf = this.buffer;
        if (buf.length < 2)
            return 0;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (rsv !== 0)
            throw new WsProtocolError('protocol error: reserved bits set (no extension negotiated)');
        if (this.expectMasked !== undefined && masked !== this.expectMasked) {
            throw new WsProtocolError(this.expectMasked
                ? 'protocol error: client frame was not masked'
                : 'protocol error: server frame must not be masked');
        }
        if (payloadLen === 126) {
            if (buf.length < offset + 2)
                return 0;
            payloadLen = buf.readUInt16BE(offset);
            offset += 2;
        }
        else if (payloadLen === 127) {
            if (buf.length < offset + 8)
                return 0;
            const high = buf.readUInt32BE(offset);
            const low = buf.readUInt32BE(offset + 4);
            if (high !== 0)
                throw new WsProtocolError('protocol error: frame larger than 4 GiB');
            payloadLen = low;
            offset += 8;
        }
        if (payloadLen > this.maxPayloadBytes) {
            throw new WsProtocolError(`payload too large (${payloadLen} bytes, limit ${this.maxPayloadBytes})`);
        }
        let maskKey = null;
        if (masked) {
            if (buf.length < offset + 4)
                return 0;
            maskKey = buf.subarray(offset, offset + 4);
            offset += 4;
        }
        if (buf.length < offset + payloadLen)
            return 0;
        const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
        if (maskKey) {
            for (let i = 0; i < payload.length; i++)
                payload[i] = payload[i] ^ maskKey[i & 3];
        }
        const total = offset + payloadLen;
        // Control frames may not be fragmented and carry at most 125 bytes.
        if (opcode >= 0x8) {
            if (!fin || payloadLen > 125)
                throw new WsProtocolError('protocol error: malformed control frame');
            if (opcode === OP_PING)
                this.handlers.onPing(payload);
            else if (opcode === OP_PONG)
                this.handlers.onPong(payload);
            else if (opcode === OP_CLOSE) {
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
                this.handlers.onClose(code, reason);
            }
            return total;
        }
        if (opcode === OP_CONT) {
            if (this.fragmentOpcode === 0)
                throw new WsProtocolError('protocol error: continuation without a start frame');
            this.fragmentBytes += payload.length;
            if (this.fragmentBytes > this.maxPayloadBytes) {
                throw new WsProtocolError(`fragmented message too large (> ${this.maxPayloadBytes} bytes)`);
            }
            this.fragments.push(payload);
            if (fin) {
                const whole = Buffer.concat(this.fragments);
                const startOp = this.fragmentOpcode;
                this.fragmentOpcode = 0;
                this.fragments = [];
                this.fragmentBytes = 0;
                this.deliver(startOp, whole);
            }
            return total;
        }
        if (opcode !== OP_TEXT && opcode !== OP_BIN) {
            throw new WsProtocolError(`protocol error: unsupported opcode 0x${opcode.toString(16)}`);
        }
        if (fin) {
            this.deliver(opcode, payload);
            return total;
        }
        if (this.fragmentOpcode !== 0)
            throw new WsProtocolError('protocol error: nested fragmented message');
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return total;
    }
    deliver(opcode, payload) {
        if (opcode !== OP_TEXT)
            return; // binary is acknowledged but ignored
        this.handlers.onText(payload.toString('utf8'));
    }
}
class SocketConnection {
    socket;
    maskOutbound;
    closed = false;
    decoder;
    messageHandlers = [];
    closeHandlers = [];
    errorHandlers = [];
    pongHandlers = [];
    closeSent = false;
    closeTimer = null;
    constructor(socket, maskOutbound, maxPayloadBytes, head) {
        this.socket = socket;
        this.maskOutbound = maskOutbound;
        this.decoder = new FrameDecoder({
            onText: text => {
                for (const handler of this.messageHandlers)
                    handler(text);
            },
            onPing: payload => {
                if (!this.closed)
                    this.socket.write(encodeFrame(OP_PONG, payload, this.maskOutbound));
            },
            onPong: () => {
                for (const handler of this.pongHandlers)
                    handler();
            },
            onClose: (code, reason) => {
                if (!this.closeSent) {
                    this.closeSent = true;
                    const body = Buffer.alloc(2);
                    body.writeUInt16BE(code >= 1000 && code <= 4999 ? code : 1000, 0);
                    this.socket.write(encodeFrame(OP_CLOSE, body, this.maskOutbound));
                }
                this.finish(code, reason);
            },
            onProtocolError: message => {
                this.emitError(new Error(message));
                this.close(1002, 'protocol error');
            },
        }, maxPayloadBytes, 
        // The side that masks outbound must receive unmasked frames, and vice versa.
        !this.maskOutbound);
        try {
            // `Duplex` covers test doubles and TLS wrappers; only real net sockets
            // expose these tuning knobs, so probe instead of assuming.
            const tunable = this.socket;
            tunable.setNoDelay?.(true);
            tunable.setTimeout?.(0);
        }
        catch {
            /* not a real socket in tests */
        }
        this.socket.on('data', (chunk) => {
            if (this.closed)
                return;
            try {
                this.decoder.push(chunk);
            }
            catch (err) {
                this.emitError(err);
                this.close(1011, 'decoder failure');
            }
        });
        this.socket.on('error', (err) => {
            this.emitError(err);
            this.finish(1006, err.message);
        });
        this.socket.on('close', () => this.finish(1006, 'socket closed'));
        this.socket.on('end', () => this.finish(1006, 'socket ended'));
        if (head && head.length > 0)
            this.decoder.push(head);
    }
    get bufferedAmount() {
        return Number(this.socket.writableLength ?? 0);
    }
    send(text) {
        if (this.closed || this.closeSent)
            return false;
        try {
            this.socket.write(encodeFrame(OP_TEXT, Buffer.from(String(text), 'utf8'), this.maskOutbound));
            return true;
        }
        catch (err) {
            this.emitError(err);
            return false;
        }
    }
    ping(payload) {
        if (this.closed)
            return false;
        try {
            this.socket.write(encodeFrame(OP_PING, payload ?? Buffer.alloc(0), this.maskOutbound));
            return true;
        }
        catch (err) {
            this.emitError(err);
            return false;
        }
    }
    close(code = 1000, reason = '') {
        if (this.closed)
            return;
        if (!this.closeSent) {
            this.closeSent = true;
            try {
                const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
                const body = Buffer.alloc(2 + reasonBytes.length);
                body.writeUInt16BE(code, 0);
                reasonBytes.copy(body, 2);
                this.socket.write(encodeFrame(OP_CLOSE, body, this.maskOutbound));
            }
            catch {
                /* fall through to teardown */
            }
        }
        this.closeTimer ??= setTimeout(() => this.finish(1006, 'close timeout'), 2000);
        this.closeTimer.unref?.();
    }
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    onClose(handler) {
        this.closeHandlers.push(handler);
    }
    onError(handler) {
        this.errorHandlers.push(handler);
    }
    onPong(handler) {
        this.pongHandlers.push(handler);
    }
    emitError(err) {
        for (const handler of this.errorHandlers) {
            try {
                handler(err);
            }
            catch {
                /* listener faults must not kill the socket loop */
            }
        }
    }
    finish(code, reason) {
        if (this.closed)
            return;
        this.closed = true;
        if (this.closeTimer) {
            clearTimeout(this.closeTimer);
            this.closeTimer = null;
        }
        try {
            this.socket.destroy();
        }
        catch {
            /* already gone */
        }
        const info = { code, reason };
        for (const handler of this.closeHandlers) {
            try {
                handler(info);
            }
            catch {
                /* ignore */
            }
        }
    }
}
/**
 * Answer a `ctx.webServer.registerUpgrade` handshake.
 * @returns the live connection, or `null` after writing a rejection response.
 */
export function acceptUpgrade(req, socket, head, options = {}) {
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = String(req.headers['sec-websocket-version'] ?? '');
    if (upgrade !== 'websocket' || typeof key !== 'string' || key === '') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return null;
    }
    if (version !== '13') {
        socket.write('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return null;
    }
    const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    ];
    if (options.subprotocol)
        lines.push(`Sec-WebSocket-Protocol: ${options.subprotocol}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    return new SocketConnection(socket, false, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD, head);
}
/** Open an outbound WebSocket. Resolves after a verified 101 handshake. */
export function connectWebSocket(url, options = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            reject(new Error(`invalid WebSocket URL: ${url}`));
            return;
        }
        const secure = parsed.protocol === 'wss:';
        if (!secure && parsed.protocol !== 'ws:') {
            reject(new Error(`unsupported WebSocket scheme: ${parsed.protocol}`));
            return;
        }
        const key = randomBytes(16).toString('base64');
        const requestFn = secure ? httpsRequest : httpRequest;
        const req = requestFn({
            // Node's HTTP clients only accept their own scheme; passing `ws:`/`wss:`
            // through throws ERR_INVALID_PROTOCOL before any socket is opened.
            protocol: secure ? 'https:' : 'http:',
            hostname: parsed.hostname,
            port: parsed.port !== '' ? Number(parsed.port) : secure ? 443 : 80,
            path: `${parsed.pathname}${parsed.search}`,
            method: 'GET',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13',
                Host: parsed.host,
                ...(options.headers ?? {}),
            },
        });
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            req.destroy();
            reject(new Error(`WebSocket handshake timed out after ${options.handshakeTimeoutMs ?? 10000}ms`));
        }, options.handshakeTimeoutMs ?? 10000);
        timer.unref?.();
        req.on('upgrade', (res, socket, head) => {
            if (settled) {
                socket.destroy();
                return;
            }
            settled = true;
            clearTimeout(timer);
            const expected = acceptKey(key);
            const actual = String(res.headers['sec-websocket-accept'] ?? '');
            if (actual !== expected) {
                socket.destroy();
                reject(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
                return;
            }
            resolve(new SocketConnection(socket, true, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD, head));
        });
        req.on('response', res => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const status = res.statusCode ?? 0;
            const chunks = [];
            res.on('data', (chunk) => {
                if (Buffer.concat(chunks).length < 2048)
                    chunks.push(chunk);
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8').slice(0, 512);
                reject(new Error(`WebSocket handshake rejected: HTTP ${status}${body ? ` – ${body.replace(/\s+/g, ' ').trim()}` : ''}`));
            });
            res.on('error', () => reject(new Error(`WebSocket handshake rejected: HTTP ${status}`)));
        });
        req.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        req.end();
    });
}
/** Exposed for tests: encode a frame without a socket. */
export const __test = {
    encodeFrame,
    acceptKey,
    FrameDecoder,
    OP_CONT,
    OP_TEXT,
    OP_BIN,
    OP_PING,
    OP_PONG,
    OP_CLOSE,
};
//# sourceMappingURL=ws.js.map