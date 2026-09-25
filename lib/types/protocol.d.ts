/**
 * dsh-xiaozhi - MCP / JSON-RPC wire protocol.
 *
 * The Xiaozhi MCP access point ("MCP 接入点") speaks JSON-RPC 2.0 over a
 * WebSocket, protocol version `2024-11-05`. Two facts define this file:
 *
 * 1. DSH is always the **MCP tool provider** (the MCP "server" role) in both
 *    transport directions: it answers `initialize`, `tools/list` and
 *    `tools/call` requests that the Xiaozhi platform (or a self-hosted
 *    xiaozhi-esp32-server) sends. This mirrors the reference ESP32 client
 *    library `xiaozhi-esp32-mcp` (`WebSocketMCP.cpp`), where the device holds
 *    the tools and the platform drives the conversation.
 * 2. Xiaozhi sanitizes every tool name with
 *    `re.sub(r"[^a-zA-Z0-9_\-\u4e00-\u9fff]", "_", name)` and rewrites tool
 *    names inside descriptions. We therefore only ever emit names that are
 *    already a fixed point of that transform.
 */
/** MCP protocol revision spoken by the Xiaozhi MCP access point. */
export declare const MCP_PROTOCOL_VERSION = "2024-11-05";
/** JSON-RPC 2.0 error codes (the subset this plugin emits). */
export declare const RPC_ERROR: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
};
export type JsonRpcId = string | number | null;
/** A JSON-RPC request, notification, success response or error response. */
export interface JsonRpcEnvelope {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: {
        code?: number;
        message?: string;
        data?: unknown;
    };
}
export type ParsedEnvelope = {
    kind: 'request';
    id: JsonRpcId;
    method: string;
    params: unknown;
} | {
    kind: 'notification';
    method: string;
    params: unknown;
} | {
    kind: 'result';
    id: JsonRpcId;
    result: unknown;
} | {
    kind: 'error';
    id: JsonRpcId;
    code: number;
    message: string;
} | {
    kind: 'invalid';
    reason: string;
    id: JsonRpcId;
};
/** One MCP tool exposed to Xiaozhi. */
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        [key: string]: unknown;
    };
}
export interface ToolContentItem {
    type: 'text';
    text: string;
}
export interface ToolCallResult {
    content: ToolContentItem[];
    isError: boolean;
}
/**
 * Canonical tool-name transform. Idempotent and Xiaozhi-safe: the output only
 * contains `[a-z0-9_]`, never starts with a digit, and never exceeds 64 chars,
 * so Xiaozhi's `sanitize_tool_name` leaves it untouched (and tool names quoted
 * inside descriptions stay resolvable).
 */
export declare function canonicalToolName(raw: string): string;
/** Mirror of `core/utils/util.py:sanitize_tool_name` on the Xiaozhi side. */
export declare function xiaozhiSanitizeToolName(name: string): string;
/** True when Xiaozhi's sanitizer would leave `name` unchanged. */
export declare function isXiaozhiStableToolName(name: string): boolean;
export declare function rpcResult(id: JsonRpcId, result: unknown): string;
export declare function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): string;
export declare function rpcNotification(method: string, params?: unknown): string;
/** `initialize` result: the tool-provider capabilities DSH advertises. */
export declare function initializeResult(serverName: string, version: string): unknown;
export declare function toolsListResult(tools: readonly McpToolDefinition[]): unknown;
export declare function toolCallResult(value: unknown, isError?: boolean): ToolCallResult;
/** Coerce any tool value into the single text block MCP/Xiaozhi can read out. */
export declare function asText(value: unknown): string;
/**
 * Tolerant envelope reader. Xiaozhi sends plain JSON-RPC; a WebSocket frame may
 * still carry garbage, a JSON array (batch) or a bare response. Anything we do
 * not understand becomes `invalid` so the caller can log it instead of
 * throwing inside the socket read loop.
 */
export declare function parseEnvelope(raw: string): ParsedEnvelope;
/** Read `params.name`/`params.arguments` off a `tools/call` request. */
export declare function readToolCall(params: unknown): {
    name: string;
    arguments: Record<string, unknown>;
} | null;
/**
 * Shorten a string for a spoken answer without cutting a surrogate pair.
 * `max` counts UTF-16 units, matching `String#length`.
 */
export declare function clip(text: string, max: number): string;
