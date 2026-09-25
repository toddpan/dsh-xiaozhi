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
import type { WsConnection } from './ws.js';
import { type McpToolDefinition, type ToolCallResult } from './protocol.js';
export type ConnectionState = 'disabled' | 'idle' | 'connecting' | 'ready' | 'error';
export interface McpSessionDeps {
    /** Current MCP tool payload (already filtered by config). */
    tools: () => McpToolDefinition[];
    /** Execute a tool; must never throw. */
    callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
    serverName: () => string;
    serverVersion: string;
    /** Mirror the reference implementation's `notifications/initialized` reply. */
    sendInitializedNotification: () => boolean;
    log: (message: string) => void;
    /** Max concurrently running tool calls per session. @default 8 */
    maxConcurrentCalls?: number;
}
export interface McpSessionStats {
    messagesIn: number;
    messagesOut: number;
    initializeCalls: number;
    toolsListCalls: number;
    toolCalls: number;
    toolErrors: number;
    lastMethod: string;
    lastActivityAt: number;
}
export declare class McpSession {
    private readonly connection;
    private readonly deps;
    readonly stats: McpSessionStats;
    /** True once the peer completed the `initialize` handshake. */
    initialized: boolean;
    closed: boolean;
    private inFlight;
    private readonly queue;
    private disposed;
    constructor(connection: WsConnection, deps: McpSessionDeps);
    /** Send a raw JSON-RPC frame (used by tests and by the session itself). */
    send(frame: string): boolean;
    close(code?: number, reason?: string): void;
    private onClose;
    private handle;
    private enqueue;
}
/** Format for the DSH log / settings page troubleshooting panel. */
export declare function describeStats(stats: McpSessionStats): string;
