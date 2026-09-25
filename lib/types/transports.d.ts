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
import type { Context } from '@deepseek-ai/cordis';
import { maskEndpoint, type ResolvedConfig } from './config.js';
import { McpSession, type ConnectionState } from './mcp-server.js';
import { connectWebSocket, type WsConnection } from './ws.js';
export interface TransportSnapshot {
    mode: 'endpoint' | 'server';
    state: ConnectionState;
    connected: boolean;
    endpointUrl?: string;
    serverPath?: string;
    serverPort?: number;
    /** URLs a Xiaozhi deployment can dial in `server` mode. */
    listenUrls?: string[];
    connectedClients?: number;
    connectedAt?: number;
    lastError?: string;
    sessions?: {
        remote: string;
        since: number;
        initialized: boolean;
    }[];
}
/** Shared bookkeeping both transports report through. */
export declare class TransportStatus {
    state: ConnectionState;
    connected: boolean;
    connectedAt?: number;
    lastError?: string;
    connectedClients: number;
    extra: Partial<TransportSnapshot>;
    setState(state: ConnectionState, error?: string): void;
}
export interface EndpointTransportOptions {
    ctx: Context;
    config: () => ResolvedConfig;
    status: TransportStatus;
    createSession: (connection: WsConnection) => McpSession;
    log: (message: string) => void;
    /** Overridable for tests. */
    connect?: typeof connectWebSocket;
}
/**
 * Outbound (MCP access point) transport with exponential backoff.
 * `start()` is synchronous; reconnection runs on timers owned by the transport.
 */
export declare class EndpointTransport {
    private readonly options;
    private ws?;
    private session?;
    private stopped;
    private attempt;
    private retryTimer?;
    private heartbeatTimer?;
    private handshakeTimer?;
    constructor(options: EndpointTransportOptions);
    start(): void;
    stop(code?: number, reason?: string): void;
    snapshot(): TransportSnapshot;
    /** Force an immediate reconnect (used by the settings page "reconnect" action). */
    reconnect(): void;
    private clearTimers;
    private clearRetry;
    private connectOnce;
    private scheduleRetry;
    private startHeartbeat;
    private stopHeartbeat;
}
export interface ServerTransportOptions {
    ctx: Context;
    config: () => ResolvedConfig;
    status: TransportStatus;
    createSession: (connection: WsConnection, remote: string) => McpSession;
    log: (message: string) => void;
}
/** Inbound transport: an exact-path upgrade route plus an optional standalone port. */
export declare class ServerTransport {
    private readonly options;
    private disposers;
    private standalone?;
    private sessions;
    constructor(options: ServerTransportOptions);
    start(): void;
    stop(): void;
    snapshot(): TransportSnapshot;
    private listenUrls;
    private handleUpgrade;
}
export { maskEndpoint };
