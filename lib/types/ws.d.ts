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
import { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
export interface WsCloseInfo {
    code: number;
    reason: string;
}
export interface WsConnection {
    /** Send one text frame. Returns false when the socket is gone. */
    send(text: string): boolean;
    /** Send an RFC 6455 ping (keepalive), answered automatically by the peer. */
    ping(payload?: Buffer): boolean;
    /** Start the close handshake; the socket is torn down shortly after. */
    close(code?: number, reason?: string): void;
    readonly closed: boolean;
    readonly bufferedAmount: number;
    onMessage(handler: (text: string) => void): void;
    onClose(handler: (info: WsCloseInfo) => void): void;
    onError(handler: (err: Error) => void): void;
    onPong(handler: () => void): void;
}
export interface WsAcceptOptions {
    /** Reject frames larger than this many bytes. @default 8 MiB */
    maxPayloadBytes?: number;
    /** Subprotocol to echo back, when the client offered one and we want it. */
    subprotocol?: string;
}
export interface WsConnectOptions {
    /** Handshake deadline in ms. @default 10000 */
    handshakeTimeoutMs?: number;
    /** Extra request headers. */
    headers?: Record<string, string>;
    maxPayloadBytes?: number;
}
declare function acceptKey(key: string): string;
interface FrameHandlers {
    onText(text: string): void;
    onPing(payload: Buffer): void;
    onPong(payload: Buffer): void;
    onClose(code: number, reason: string): void;
    onProtocolError(message: string): void;
}
/**
 * Encode one frame. Outbound frames are never fragmented (`fin` defaults to
 * true); the parameter exists so tests can synthesise fragmented and
 * non-final control frames.
 */
declare function encodeFrame(opcode: number, payload: Buffer, mask: boolean, fin?: boolean): Buffer;
declare class FrameDecoder {
    private readonly handlers;
    private readonly maxPayloadBytes;
    /**
     * Whether inbound frames must be masked. RFC 6455 masks client→server
     * frames only, so the server side expects masked and the client side
     * expects unmasked. `undefined` disables the check (unit tests).
     */
    private readonly expectMasked;
    private buffer;
    private fragmentOpcode;
    private fragments;
    private fragmentBytes;
    constructor(handlers: FrameHandlers, maxPayloadBytes: number, 
    /**
     * Whether inbound frames must be masked. RFC 6455 masks client→server
     * frames only, so the server side expects masked and the client side
     * expects unmasked. `undefined` disables the check (unit tests).
     */
    expectMasked?: boolean | undefined);
    push(chunk: Buffer): void;
    /** @returns byte count consumed, 0 when the buffer holds an incomplete frame. */
    private decodeOne;
    private deliver;
}
/**
 * Answer a `ctx.webServer.registerUpgrade` handshake.
 * @returns the live connection, or `null` after writing a rejection response.
 */
export declare function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, options?: WsAcceptOptions): WsConnection | null;
/** Open an outbound WebSocket. Resolves after a verified 101 handshake. */
export declare function connectWebSocket(url: string, options?: WsConnectOptions): Promise<WsConnection>;
/** Exposed for tests: encode a frame without a socket. */
export declare const __test: {
    encodeFrame: typeof encodeFrame;
    acceptKey: typeof acceptKey;
    FrameDecoder: typeof FrameDecoder;
    OP_CONT: number;
    OP_TEXT: number;
    OP_BIN: number;
    OP_PING: number;
    OP_PONG: number;
    OP_CLOSE: number;
};
export {};
