/**
 * dsh-xiaozhi - configuration.
 *
 * Layering (lowest → highest precedence):
 *
 *   1. `DEFAULTS` below (code).
 *   2. The row `config:` in a profile's `cordis.patch.yml` (validated by
 *      `Config`; survives plugin upgrades).
 *   3. The runtime override document the settings page writes, stored at
 *      `$DSH_XIAOZHI_HOME` → `$DSH_HOME/dsh-xiaozhi` → `~/.dsh/dsh-xiaozhi`,
 *      file `settings.json`. Writing a layer-2 file needs a DSH restart; layer 3
 *      is applied live by `applyRuntime()`.
 *
 * Secrets: `endpointHeaders` may carry an `Authorization` header, so the admin
 * API never echoes it back — see `redactConfig`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
/** Deterministic device id derived from the URL, so ids survive re-resolves. */
export function hashEndpointId(url) {
    return `ep-${createHash('sha256').update(url).digest('hex').slice(0, 8)}`;
}
/** Coerce arbitrary rows into devices, assigning stable ids and deduping them. */
export function normalizeEndpoints(value) {
    if (!Array.isArray(value))
        return [];
    const devices = [];
    const used = new Map();
    for (const raw of value) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const row = raw;
        const url = String(row.url ?? '').trim();
        const name = String(row.name ?? '').trim();
        const headers = row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
            ? Object.fromEntries(Object.entries(row.headers).map(([k, v]) => [k, String(v)]))
            : undefined;
        let base = String(row.id ?? '').trim();
        if (base === '')
            base = url === '' ? 'ep-new' : hashEndpointId(url);
        // Two rows may collide (same URL pasted twice): suffix deterministically.
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        const id = seen === 0 ? base : `${base}-${seen + 1}`;
        const device = { id, url };
        if (name !== '')
            device.name = name;
        if (headers && Object.keys(headers).length > 0)
            device.headers = headers;
        devices.push(device);
    }
    return devices;
}
/**
 * The devices the runtime should actually dial: the configured list, or — for
 * configs written before multi-device support — the legacy single URL.
 */
export function effectiveEndpoints(resolved) {
    if (resolved.endpoints.length > 0)
        return resolved.endpoints;
    const url = resolved.endpointUrl.trim();
    if (url === '')
        return [];
    return normalizeEndpoints([{ url, headers: resolved.endpointHeaders }]);
}
export const DEFAULTS = {
    enabled: true,
    mode: 'endpoint',
    /** Legacy single-device Xiaozhi MCP access point, e.g. wss://api.xiaozhi.me/mcp/?token=... */
    endpointUrl: '',
    /** Multi-device access points; non-empty makes this list authoritative. */
    endpoints: [],
    /** Extra handshake headers for endpoint mode (may hold a secret). */
    endpointHeaders: {},
    /** Exact upgrade path served by `mode: server`. */
    serverPath: '/mcp/xiaozhi',
    /** Extra standalone listener for `mode: server`; 0 = only on the DSH web server. */
    serverPort: 0,
    /** Optional shared secret enforced as `?token=` for `mode: server`. */
    serverToken: '',
    /** How the exposed tools are woven: intent-grouped or one per REST capability. */
    toolMode: 'grouped',
    /** Tool groups switched off (see `docs/TOOLS.md`). */
    disabledGroups: [],
    /** Upper bound for a synchronous `prompt` tool call. */
    promptTimeoutMs: 120_000,
    /** Longest text block handed back to the voice LLM. */
    maxVoiceChars: 700,
    /** Most list rows any single tool returns. */
    listLimit: 10,
    reconnectMinMs: 1_000,
    reconnectMaxMs: 30_000,
    /** RFC 6455 ping interval on an idle connection. */
    heartbeatMs: 30_000,
    /** Prefix the bundled DSH Web REST layer + admin API mount on. */
    apiPathPrefix: '/dsh-xiaozhi/api',
    /** Mount the bundled copy of the DSH Web REST layer. */
    exposeDshApi: true,
    /** Bearer/X-API-Key auth for the bundled REST layer; empty = no auth. */
    apiKey: '',
    /** Emit `Access-Control-*` headers on the bundled REST layer. */
    cors: false,
    defaultCwd: '',
    maxUploadBytes: 100 * 1024 * 1024,
    /** Expose mutating tools (create/rename/delete/prompt/cancel/settings patch). */
    allowWriteTools: true,
    /** Home for the override document; empty = DSH_HOME/dsh-xiaozhi. */
    homeDir: '',
    /** Log every inbound tool call to the DSH log. */
    logToolCalls: true,
    /** Mirror the access point's `notifications/initialized` reply (matches the ESP32 reference). */
    sendInitializedNotification: true,
    /** Advertised in `initialize.serverInfo.name`. */
    serverName: 'DSH',
};
export const Config = z.object({
    enabled: z.boolean().default(DEFAULTS.enabled).description('启用小智 MCP 接入'),
    mode: z
        .union([z.const('endpoint'), z.const('server')])
        .default(DEFAULTS.mode)
        .description('endpoint=主动连出小智接入点；server=本机作为 MCP 服务端被小智连接'),
    endpointUrl: z.string().default(DEFAULTS.endpointUrl).description('（旧单设备）小智 MCP 接入点地址；endpoints 非空时被忽略'),
    endpoints: z
        .array(z.object({
        id: z.string().default('').description('设备标识（留空时按地址自动生成）'),
        name: z.string().default('').description('设备名称（可选，便于区分多台小智）'),
        url: z.string().default('').description('该设备的 MCP 接入点地址（ws:// 或 wss://，需含 /mcp/ 与 token）'),
        headers: z.dict(z.string()).default({}).description('该设备握手的额外请求头（覆盖全局同名键，不会回显）'),
    }))
        .default([])
        .description('小智 MCP 设备列表（非空时优先生效，可同时绑定多台）'),
    endpointHeaders: z.dict(z.string()).default({}).description('endpoint 模式握手的额外请求头（可放鉴权信息，不会回显；作为所有设备的兜底）'),
    serverPath: z.string().default(DEFAULTS.serverPath).description('server 模式监听的精确 WebSocket 路径'),
    serverPort: z.natural().default(DEFAULTS.serverPort).description('server 模式的独立监听端口（0 表示仅挂在 DSH Web 服务器上）'),
    serverToken: z.string().default(DEFAULTS.serverToken).description('server 模式的接入口令（非空时要求 ?token= 匹配）'),
    toolMode: z.union([z.const('grouped'), z.const('flat')]).default(DEFAULTS.toolMode).description('工具编织方式：grouped=按语音意图聚合；flat=与 REST 能力一一对应'),
    disabledGroups: z.array(z.string()).default([]).description('关闭的工具组'),
    promptTimeoutMs: z.natural().default(DEFAULTS.promptTimeoutMs).description('同步对话工具的等待上限（毫秒）'),
    maxVoiceChars: z.natural().default(DEFAULTS.maxVoiceChars).description('回给语音模型的单条文本上限（字符）'),
    listLimit: z.natural().default(DEFAULTS.listLimit).description('列表类工具最多返回的条数'),
    reconnectMinMs: z.natural().default(DEFAULTS.reconnectMinMs).description('断线重连最小退避（毫秒）'),
    reconnectMaxMs: z.natural().default(DEFAULTS.reconnectMaxMs).description('断线重连最大退避（毫秒）'),
    heartbeatMs: z.natural().default(DEFAULTS.heartbeatMs).description('空闲心跳间隔（毫秒）'),
    apiPathPrefix: z.string().default(DEFAULTS.apiPathPrefix).description('内置 DSH Web REST 层的路由前缀（设置页 API 固定在 /dsh-xiaozhi/admin，不随此值变化）'),
    exposeDshApi: z.boolean().default(DEFAULTS.exposeDshApi).description('是否挂载内置的 DSH Web REST 层'),
    apiKey: z.string().default(DEFAULTS.apiKey).description('内置 REST 层的鉴权 Key（留空不鉴权）'),
    cors: z.boolean().default(DEFAULTS.cors).description('是否为内置 REST 层输出跨域响应头'),
    defaultCwd: z.string().default(DEFAULTS.defaultCwd).description('新建会话的默认工作目录（留空为 process.cwd()）'),
    maxUploadBytes: z.natural().default(DEFAULTS.maxUploadBytes).description('文件上传大小上限（字节）'),
    allowWriteTools: z.boolean().default(DEFAULTS.allowWriteTools).description('是否暴露写入类工具（新建/重命名/删除/发消息/中止/改设置）'),
    homeDir: z.string().default(DEFAULTS.homeDir).description('运行时配置目录（留空为 $DSH_HOME/dsh-xiaozhi）'),
    logToolCalls: z.boolean().default(DEFAULTS.logToolCalls).description('是否记录每次工具调用'),
    sendInitializedNotification: z.boolean().default(DEFAULTS.sendInitializedNotification).description('收到 initialize 后是否回发 notifications/initialized（与 ESP32 参考实现一致）'),
    serverName: z.string().default(DEFAULTS.serverName).description('initialize 响应中 serverInfo.name 的值'),
});
/** Directory holding the override document, following the `$DSH_HOME/<plugin>` convention. */
export function resolveHomeDir(config) {
    const explicit = String(config?.homeDir ?? '').trim();
    if (explicit !== '')
        return path.resolve(explicit);
    const env = String(process.env.DSH_XIAOZHI_HOME ?? '').trim();
    if (env !== '')
        return path.resolve(env);
    const dshHome = String(process.env.DSH_HOME ?? '').trim();
    if (dshHome !== '')
        return path.join(path.resolve(dshHome), 'dsh-xiaozhi');
    return path.join(homedir(), '.dsh', 'dsh-xiaozhi');
}
export function resolveSettingsFile(config) {
    return path.join(resolveHomeDir(config), 'settings.json');
}
/** Merge defaults ← row config ← persisted overrides, then normalise. */
export function resolveConfig(row, overrides) {
    const merged = { ...DEFAULTS };
    for (const source of [row, overrides]) {
        if (!source || typeof source !== 'object')
            continue;
        for (const [key, value] of Object.entries(source)) {
            if (value === undefined)
                continue;
            if (key === 'endpointHeaders') {
                merged[key] = { ...merged[key], ...value };
            }
            else {
                merged[key] = value;
            }
        }
    }
    const resolved = merged;
    resolved.mode = resolved.mode === 'server' ? 'server' : 'endpoint';
    resolved.toolMode = resolved.toolMode === 'flat' ? 'flat' : 'grouped';
    resolved.endpoints = normalizeEndpoints(resolved.endpoints);
    resolved.disabledGroups = Array.isArray(resolved.disabledGroups)
        ? resolved.disabledGroups.map(String).filter(Boolean)
        : [];
    resolved.endpointHeaders =
        resolved.endpointHeaders && typeof resolved.endpointHeaders === 'object'
            ? Object.fromEntries(Object.entries(resolved.endpointHeaders).map(([k, v]) => [k, String(v)]))
            : {};
    if (!resolved.serverPath.startsWith('/'))
        resolved.serverPath = `/${resolved.serverPath}`;
    resolved.serverPath = resolved.serverPath.replace(/\/+$/, '') || '/mcp/xiaozhi';
    if (!resolved.apiPathPrefix.startsWith('/'))
        resolved.apiPathPrefix = `/${resolved.apiPathPrefix}`;
    resolved.apiPathPrefix = resolved.apiPathPrefix.replace(/\/+$/, '') || '/dsh-xiaozhi/api';
    resolved.maxVoiceChars = clampInt(resolved.maxVoiceChars, 120, 4_000, DEFAULTS.maxVoiceChars);
    resolved.listLimit = clampInt(resolved.listLimit, 1, 50, DEFAULTS.listLimit);
    resolved.promptTimeoutMs = clampInt(resolved.promptTimeoutMs, 5_000, 3_600_000, DEFAULTS.promptTimeoutMs);
    resolved.reconnectMinMs = clampInt(resolved.reconnectMinMs, 200, 60_000, DEFAULTS.reconnectMinMs);
    resolved.reconnectMaxMs = clampInt(resolved.reconnectMaxMs, resolved.reconnectMinMs, 300_000, DEFAULTS.reconnectMaxMs);
    resolved.heartbeatMs = clampInt(resolved.heartbeatMs, 5_000, 600_000, DEFAULTS.heartbeatMs);
    resolved.maxUploadBytes = clampInt(resolved.maxUploadBytes, 1_024, 4 * 1024 * 1024 * 1024, DEFAULTS.maxUploadBytes);
    resolved.serverPort = clampInt(resolved.serverPort, 0, 65_535, 0);
    return resolved;
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
/**
 * Keys the settings page must not be able to persist.
 *
 * `homeDir` decides where the override file lives, so honouring it *from* that
 * file is circular: the page would report a new directory while the overrides
 * kept being written to the old one. It stays a row-config setting.
 */
const NEVER_PERSISTED = ['homeDir'];
/** Read the persisted override document; a corrupt file is ignored, never fatal. */
export function readOverrides(config) {
    const file = resolveSettingsFile(config);
    try {
        if (!existsSync(file))
            return {};
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const key of NEVER_PERSISTED)
                delete parsed[key];
            return parsed;
        }
    }
    catch {
        /* ignore corrupt overrides; row config still applies */
    }
    return {};
}
/**
 * Merge `patch` into the override document and persist it.
 * @returns the new document plus the fully resolved config.
 */ export function writeOverrides(config, patch) {
    const dir = resolveHomeDir(config);
    const file = path.join(dir, 'settings.json');
    const current = readOverrides(config);
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            continue;
        if (NEVER_PERSISTED.includes(key))
            continue;
        if (key === 'endpointHeaders') {
            next.endpointHeaders = { ...(current.endpointHeaders ?? {}), ...value };
        }
        else {
            ;
            next[key] = value;
        }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { overrides: next, resolved: resolveConfig(undefined, next) };
}
/** Remove the persisted override document, falling back to the row config. */
export function clearOverrides(config) {
    const file = resolveSettingsFile(config);
    try {
        rmSync(file, { force: true });
    }
    catch {
        /* nothing to clear */
    }
}
/** Strip secrets before anything cross the admin HTTP API or the Web UI. */
/** Replacement shown in place of any secret in API responses and logs. */
export const SECRET_MASK = '••••••';
/** ASCII mask for URLs, so serialisation cannot percent-encode it. */
export const URL_TOKEN_MASK = '***';
/**
 * Hide the access-point token in an endpoint URL (logs, admin API, status).
 * String surgery rather than `URL` round-tripping so every other byte of the
 * pasted link survives verbatim, which makes support questions answerable.
 */
export function maskEndpoint(url) {
    if (!url)
        return '';
    return url.replace(/([?&]token=)[^&#]*/i, `$1${URL_TOKEN_MASK}`);
}
/** True when a URL still carries the mask, i.e. the user did not retype it. */
export function isMaskedEndpoint(url) {
    return typeof url === 'string' && /[?&]token=\*\*\*/i.test(url);
}
export function redactConfig(config) {
    const { apiKey, serverToken, endpointHeaders, ...rest } = config;
    const headerNames = Object.keys(endpointHeaders ?? {});
    return {
        ...rest,
        // The access-point token is a bearer credential for the whole tool surface,
        // so it must never survive a round trip through the admin API.
        endpointUrl: maskEndpoint(config.endpointUrl),
        // Devices are redacted individually; the list always reflects what the
        // runtime dials (legacy single-URL configs synthesize their one device),
        // so the settings page can edit devices without knowing about the legacy key.
        // A device without headers keeps having no headers key (same shape as stored).
        endpoints: effectiveEndpoints(config).map(device => {
            const headerNames = Object.keys(device.headers ?? {});
            return {
                ...device,
                url: maskEndpoint(device.url),
                ...(headerNames.length > 0
                    ? { headers: Object.fromEntries(headerNames.map(name => [name, SECRET_MASK])) }
                    : {}),
            };
        }),
        apiKey: apiKey ? SECRET_MASK : '',
        serverToken: serverToken ? SECRET_MASK : '',
        endpointHeaders: Object.fromEntries(headerNames.map(name => [name, SECRET_MASK])),
        _secrets: {
            apiKeySet: Boolean(apiKey),
            serverTokenSet: Boolean(serverToken),
            endpointHeaderNames: headerNames,
        },
    };
}
/**
 * Resolve masked sentinels inside a `patch.endpoints` array against the stored
 * configuration, the same job the admin router does for the legacy secret keys.
 *
 * A row's URL is matched back to its stored twin by `id`, then by the masked
 * URL itself (configs written before ids existed). Masked header values are
 * restored the same way; unknown ones are dropped, which `writeOverrides`'
 * per-key merge turns into "keep the stored value". Rows whose masked URL
 * matches nothing stored cannot be restored and are dropped — writing the
 * literal mask into the config would create a device that can never connect.
 */
export function mergeMaskedEndpoints(rowConfig, patch) {
    if (!Array.isArray(patch.endpoints))
        return { dropped: 0 };
    const storedResolved = resolveConfig(rowConfig, readOverrides(rowConfig));
    const storedList = effectiveEndpoints(storedResolved);
    const findStored = (row) => {
        const id = String(row.id ?? '').trim();
        if (id !== '') {
            const byId = storedList.find(device => device.id === id);
            if (byId)
                return byId;
        }
        const url = String(row.url ?? '');
        if (isMaskedEndpoint(url))
            return storedList.find(device => maskEndpoint(device.url) === url);
        return undefined;
    };
    const resolved = [];
    let dropped = 0;
    for (const raw of patch.endpoints) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const row = { ...raw };
        const match = findStored(row);
        // A masked URL must map back to a stored device, or the row is unrestorable.
        if (isMaskedEndpoint(String(row.url ?? ''))) {
            if (!match) {
                dropped += 1;
                continue;
            }
            row.url = match.url;
        }
        const headers = row.headers;
        if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
            const restored = {};
            for (const [name, value] of Object.entries(headers)) {
                if (value === SECRET_MASK) {
                    const stored = match?.headers?.[name];
                    if (stored !== undefined)
                        restored[name] = stored;
                }
                else {
                    restored[name] = value;
                }
            }
            row.headers = restored;
        }
        resolved.push(row);
    }
    return { endpoints: normalizeEndpoints(resolved), dropped };
}
//# sourceMappingURL=config.js.map