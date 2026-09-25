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
export const MCP_PROTOCOL_VERSION = '2024-11-05';
/** JSON-RPC 2.0 error codes (the subset this plugin emits). */
export const RPC_ERROR = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
};
/**
 * Canonical tool-name transform. Idempotent and Xiaozhi-safe: the output only
 * contains `[a-z0-9_]`, never starts with a digit, and never exceeds 64 chars,
 * so Xiaozhi's `sanitize_tool_name` leaves it untouched (and tool names quoted
 * inside descriptions stay resolvable).
 */
export function canonicalToolName(raw) {
    let out = String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (out === '')
        out = 'tool';
    if (/^[0-9]/.test(out))
        out = `t_${out}`;
    return out.slice(0, 64);
}
/** Mirror of `core/utils/util.py:sanitize_tool_name` on the Xiaozhi side. */
export function xiaozhiSanitizeToolName(name) {
    // \u4e00-\u9fff is allowed by Xiaozhi but replaced here so both sides agree:
    // this plugin never emits CJK tool names.
    return String(name ?? '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_');
}
/** True when Xiaozhi's sanitizer would leave `name` unchanged. */
export function isXiaozhiStableToolName(name) {
    return xiaozhiSanitizeToolName(name) === name;
}
export function rpcResult(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: result ?? {} });
}
export function rpcError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined)
        error.data = data;
    return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error });
}
export function rpcNotification(method, params) {
    const frame = { jsonrpc: '2.0', method };
    if (params !== undefined)
        frame.params = params;
    return JSON.stringify(frame);
}
/** `initialize` result: the tool-provider capabilities DSH advertises. */
export function initializeResult(serverName, version) {
    return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
            experimental: {},
            prompts: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            // Tools are the only capability DSH serves, and the list is fixed for the
            // life of a connection: a config change tears the transport down and the
            // client re-initialises. Claiming `listChanged: true` would promise a
            // `notifications/tools/list_changed` frame that is never sent.
            tools: { listChanged: false },
        },
        serverInfo: { name: serverName, version },
    };
}
export function toolsListResult(tools) {
    // No pagination: the whole (already group-filtered) list fits one response.
    // Xiaozhi tolerates a missing `nextCursor` and stops asking.
    return { tools: tools.map(tool => ({ ...tool })) };
}
export function toolCallResult(value, isError = false) {
    return { content: [{ type: 'text', text: asText(value) }], isError };
}
/** Coerce any tool value into the single text block MCP/Xiaozhi can read out. */
export function asText(value) {
    if (value === undefined)
        return '';
    if (value === null)
        return 'null';
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
/**
 * Tolerant envelope reader. Xiaozhi sends plain JSON-RPC; a WebSocket frame may
 * still carry garbage, a JSON array (batch) or a bare response. Anything we do
 * not understand becomes `invalid` so the caller can log it instead of
 * throwing inside the socket read loop.
 */
export function parseEnvelope(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch (err) {
        return { kind: 'invalid', reason: `not JSON: ${err.message}`, id: null };
    }
    if (Array.isArray(value)) {
        return { kind: 'invalid', reason: 'batched JSON-RPC is not supported', id: null };
    }
    if (value === null || typeof value !== 'object') {
        return { kind: 'invalid', reason: 'frame is not a JSON object', id: null };
    }
    const env = value;
    const id = env.id === undefined ? null : env.id;
    if (env.error !== undefined) {
        return {
            kind: 'error',
            id,
            code: typeof env.error?.code === 'number' ? env.error.code : RPC_ERROR.INTERNAL_ERROR,
            message: typeof env.error?.message === 'string' ? env.error.message : 'unknown error',
        };
    }
    if (env.result !== undefined) {
        return { kind: 'result', id, result: env.result };
    }
    if (typeof env.method !== 'string' || env.method === '') {
        return { kind: 'invalid', reason: 'frame has neither method nor result', id };
    }
    if (env.id === undefined || env.id === null) {
        return { kind: 'notification', method: env.method, params: env.params };
    }
    return { kind: 'request', id: env.id, method: env.method, params: env.params };
}
/** Read `params.name`/`params.arguments` off a `tools/call` request. */
export function readToolCall(params) {
    if (params === null || typeof params !== 'object')
        return null;
    const p = params;
    if (typeof p.name !== 'string' || p.name === '')
        return null;
    const rawArgs = p.arguments;
    const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs
        : {};
    return { name: p.name, arguments: args };
}
/**
 * Shorten a string for a spoken answer without cutting a surrogate pair.
 * `max` counts UTF-16 units, matching `String#length`.
 */
export function clip(text, max) {
    const s = String(text ?? '');
    if (s.length <= max)
        return s;
    let cut = max;
    const code = s.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff)
        cut -= 1;
    return `${s.slice(0, cut)}…`;
}
//# sourceMappingURL=protocol.js.map