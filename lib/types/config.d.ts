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
import z from '@deepseek-ai/schemastery';
export type XiaozhiMode = 'endpoint' | 'server';
export type ToolMode = 'grouped' | 'flat';
/**
 * One bound Xiaozhi device (an MCP access point). `endpointUrl` above stays as
 * the single-device legacy key; when `endpoints` is non-empty it is
 * authoritative and the legacy key is ignored — see `effectiveEndpoints`.
 */
export interface EndpointDevice {
    /** Stable identity the settings page keys status and masked URLs on. */
    id: string;
    /** Optional display name, e.g. 客厅小智. */
    name?: string;
    /** Xiaozhi MCP access point, ws:// or wss://, containing /mcp/ and a token. */
    url: string;
    /** Per-device handshake headers, merged over the global `endpointHeaders`. */
    headers?: Record<string, string>;
}
/** Deterministic device id derived from the URL, so ids survive re-resolves. */
export declare function hashEndpointId(url: string): string;
/** Coerce arbitrary rows into devices, assigning stable ids and deduping them. */
export declare function normalizeEndpoints(value: unknown): EndpointDevice[];
/**
 * The devices the runtime should actually dial: the configured list, or — for
 * configs written before multi-device support — the legacy single URL.
 */
export declare function effectiveEndpoints(resolved: Pick<ResolvedConfig, 'endpoints' | 'endpointUrl' | 'endpointHeaders'>): EndpointDevice[];
export declare const DEFAULTS: {
    readonly enabled: true;
    readonly mode: XiaozhiMode;
    /** Legacy single-device Xiaozhi MCP access point, e.g. wss://api.xiaozhi.me/mcp/?token=... */
    readonly endpointUrl: "";
    /** Multi-device access points; non-empty makes this list authoritative. */
    readonly endpoints: EndpointDevice[];
    /** Extra handshake headers for endpoint mode (may hold a secret). */
    readonly endpointHeaders: Record<string, string>;
    /** Exact upgrade path served by `mode: server`. */
    readonly serverPath: "/mcp/xiaozhi";
    /** Extra standalone listener for `mode: server`; 0 = only on the DSH web server. */
    readonly serverPort: 0;
    /** Optional shared secret enforced as `?token=` for `mode: server`. */
    readonly serverToken: "";
    /** How the exposed tools are woven: intent-grouped or one per REST capability. */
    readonly toolMode: ToolMode;
    /** Tool groups switched off (see `docs/TOOLS.md`). */
    readonly disabledGroups: string[];
    /** Upper bound for a synchronous `prompt` tool call. */
    readonly promptTimeoutMs: 120000;
    /** Longest text block handed back to the voice LLM. */
    readonly maxVoiceChars: 700;
    /** Most list rows any single tool returns. */
    readonly listLimit: 10;
    readonly reconnectMinMs: 1000;
    readonly reconnectMaxMs: 30000;
    /** RFC 6455 ping interval on an idle connection. */
    readonly heartbeatMs: 30000;
    /** Prefix the bundled DSH Web REST layer + admin API mount on. */
    readonly apiPathPrefix: "/dsh-xiaozhi/api";
    /** Mount the bundled copy of the DSH Web REST layer. */
    readonly exposeDshApi: true;
    /** Bearer/X-API-Key auth for the bundled REST layer; empty = no auth. */
    readonly apiKey: "";
    /** Emit `Access-Control-*` headers on the bundled REST layer. */
    readonly cors: false;
    readonly defaultCwd: "";
    readonly maxUploadBytes: number;
    /** Expose mutating tools (create/rename/delete/prompt/cancel/settings patch). */
    readonly allowWriteTools: true;
    /** Home for the override document; empty = DSH_HOME/dsh-xiaozhi. */
    readonly homeDir: "";
    /** Log every inbound tool call to the DSH log. */
    readonly logToolCalls: true;
    /** Mirror the access point's `notifications/initialized` reply (matches the ESP32 reference). */
    readonly sendInitializedNotification: true;
    /** Advertised in `initialize.serverInfo.name`. */
    readonly serverName: "DSH";
};
/** Row config as written in `cordis.patch.yml` / persisted overrides. */
export interface Config {
    enabled?: boolean;
    mode?: XiaozhiMode;
    endpointUrl?: string;
    endpoints?: EndpointDevice[];
    endpointHeaders?: Record<string, string>;
    serverPath?: string;
    serverPort?: number;
    serverToken?: string;
    toolMode?: ToolMode;
    disabledGroups?: string[];
    promptTimeoutMs?: number;
    maxVoiceChars?: number;
    listLimit?: number;
    reconnectMinMs?: number;
    reconnectMaxMs?: number;
    heartbeatMs?: number;
    apiPathPrefix?: string;
    exposeDshApi?: boolean;
    apiKey?: string;
    cors?: boolean;
    defaultCwd?: string;
    maxUploadBytes?: number;
    allowWriteTools?: boolean;
    homeDir?: string;
    logToolCalls?: boolean;
    sendInitializedNotification?: boolean;
    serverName?: string;
}
/** Fully resolved runtime configuration (no optional fields, no literal types). */
export interface ResolvedConfig {
    enabled: boolean;
    mode: XiaozhiMode;
    endpointUrl: string;
    endpoints: EndpointDevice[];
    endpointHeaders: Record<string, string>;
    serverPath: string;
    serverPort: number;
    serverToken: string;
    toolMode: ToolMode;
    disabledGroups: string[];
    promptTimeoutMs: number;
    maxVoiceChars: number;
    listLimit: number;
    reconnectMinMs: number;
    reconnectMaxMs: number;
    heartbeatMs: number;
    apiPathPrefix: string;
    exposeDshApi: boolean;
    apiKey: string;
    cors: boolean;
    defaultCwd: string;
    maxUploadBytes: number;
    allowWriteTools: boolean;
    homeDir: string;
    logToolCalls: boolean;
    sendInitializedNotification: boolean;
    serverName: string;
}
export declare const Config: z<Config>;
/** Directory holding the override document, following the `$DSH_HOME/<plugin>` convention. */
export declare function resolveHomeDir(config?: Pick<Config, 'homeDir'>): string;
export declare function resolveSettingsFile(config?: Pick<Config, 'homeDir'>): string;
/** Merge defaults ← row config ← persisted overrides, then normalise. */
export declare function resolveConfig(row: Config | undefined, overrides?: Config | undefined): ResolvedConfig;
/** Read the persisted override document; a corrupt file is ignored, never fatal. */
export declare function readOverrides(config?: Pick<Config, 'homeDir'>): Config;
/**
 * Merge `patch` into the override document and persist it.
 * @returns the new document plus the fully resolved config.
 */ export declare function writeOverrides(config: Pick<Config, 'homeDir'>, patch: Config): {
    overrides: Config;
    resolved: ResolvedConfig;
};
/** Remove the persisted override document, falling back to the row config. */
export declare function clearOverrides(config: Pick<Config, 'homeDir'>): void;
/** Strip secrets before anything cross the admin HTTP API or the Web UI. */
/** Replacement shown in place of any secret in API responses and logs. */
export declare const SECRET_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022";
/** ASCII mask for URLs, so serialisation cannot percent-encode it. */
export declare const URL_TOKEN_MASK = "***";
/**
 * Hide the access-point token in an endpoint URL (logs, admin API, status).
 * String surgery rather than `URL` round-tripping so every other byte of the
 * pasted link survives verbatim, which makes support questions answerable.
 */
export declare function maskEndpoint(url: string): string;
/** True when a URL still carries the mask, i.e. the user did not retype it. */
export declare function isMaskedEndpoint(url: unknown): boolean;
export declare function redactConfig(config: ResolvedConfig): Record<string, unknown>;
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
export declare function mergeMaskedEndpoints(rowConfig: Pick<Config, 'homeDir'> | undefined, patch: Config): {
    endpoints?: EndpointDevice[];
    dropped: number;
};
