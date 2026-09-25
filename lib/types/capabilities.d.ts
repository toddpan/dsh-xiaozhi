/**
 * dsh-xiaozhi - capability table.
 *
 * One entry per DSH Web REST/SSE capability the user asked to expose (the
 * route inventory of `@dsh-external/dsh-web-service` v0.1.11). This is the
 * single source of truth for:
 *
 *   - the `flat` tool mode (one MCP tool per capability),
 *   - the `grouped` tool mode (one MCP tool per voice intent, dispatching to
 *     several capabilities behind an `action` enum),
 *   - the settings page's capability index.
 *
 * Three capabilities are not a plain route call and own a bespoke handler:
 * `system.status` (no route in the trimmed copy), `sessions.events` (the SSE
 * route never completes, so it is bounded to a time window) and `docs.info`
 * (returns entry-point URLs rather than flooding the voice channel with the
 * full OpenAPI document).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './config.js';
import { LocalInvoker, type InvokeRequest } from './dispatcher.js';
export type ToolGroup = 'system' | 'workspaces' | 'sessions' | 'conversation' | 'files' | 'models' | 'settings' | 'docs';
export declare const TOOL_GROUPS: readonly ToolGroup[];
export declare const TOOL_GROUP_LABELS: Record<ToolGroup, string>;
export type BodyKind = 'none' | 'json' | 'raw' | 'passthrough';
export interface CapabilitySpec {
    /** Stable dotted id, e.g. `sessions.history`. */
    id: string;
    group: ToolGroup;
    /** Mutating: hidden when `allowWriteTools` is false. */
    write: boolean;
    /** Route method; ignored by bespoke handlers. */
    method: InvokeRequest['method'];
    /** Route path with `:params`; ignored by bespoke handlers. */
    path: string;
    pathParams: string[];
    queryParams: string[];
    body: BodyKind;
    /** For `body: 'json'`: the body fields copied out of the tool arguments. */
    bodyFields: string[];
    /** How long this capability may run (ms). */
    timeoutMs: number;
    /** Chinese summary shown in the settings page capability index. */
    summary: string;
}
/** The complete capability inventory. */
export declare const CAPABILITIES: readonly CapabilitySpec[];
export declare function getCapability(id: string): CapabilitySpec | undefined;
/** User-facing failure raised while running a capability. */
export declare class CapabilityError extends Error {
    readonly capability?: string | undefined;
    readonly status?: number | undefined;
    constructor(message: string, capability?: string | undefined, status?: number | undefined);
}
export interface CapabilityRuntimeDeps {
    ctx: Context;
    invoker: LocalInvoker;
    /** Live config accessor: the settings page can change it without a reload. */
    config: () => ResolvedConfig;
    /** URL prefix the bundled REST layer is served under (for `docs.info`). */
    apiBase: () => string;
    /** MCP transport snapshot merged into `system.status`. */
    mcpStatus: () => unknown;
    /** Optional DSH log sink. */
    log: (message: string) => void;
}
/**
 * Runs capabilities. REST-backed capabilities are dispatched in-process
 * through {@link LocalInvoker}; the three bespoke ones are implemented here.
 */
export declare class CapabilityRuntime {
    private readonly deps;
    constructor(deps: CapabilityRuntimeDeps);
    get specs(): readonly CapabilitySpec[];
    /** Capabilities currently exposed (group filter + read-only filter). */
    available(): CapabilitySpec[];
    run(id: string, args: Record<string, unknown>): Promise<unknown>;
    private dispatchRest;
    /**
     * Shared by the `dsh_status` tool and the bundled REST layer's
     * `GET /system/status`, so the two can never disagree.
     */
    systemStatus(): Promise<unknown>;
    /**
     * `GET /sessions/:id/events` is an open-ended SSE stream, so over MCP it is
     * bounded: subscribe for `seconds` (default 5, max 30), then answer with a
     * compact digest instead of the raw event payloads.
     */
    private sessionEvents;
    private docsInfo;
    /**
     * `GET /openapi.json` is hundreds of kilobytes; inlining it would blow the
     * voice budget and the MCP frame, so summarise it and keep the URL.
     */
    private openApiSummary;
}
export declare function pluginVersion(): string;
