/**
 * dsh-xiaozhi - MCP tool surface.
 *
 * Two weavings of the same capability inventory:
 *
 *   - `grouped` (default): one tool per **voice intent**, several related
 *     capabilities behind an `action` enum. A spoken request maps to a short,
 *     unambiguous tool list, which is what Xiaozhi's function-calling LLM
 *     actually needs.
 *   - `flat`: one tool per REST capability, for integrations that want the raw
 *     surface (and for tests that assert 1:1 coverage).
 *
 * Every tool answers with a single text block sized for speech: lists are
 * trimmed to `listLimit` rows, text is clipped to `maxVoiceChars`, and ids are
 * shortened so the model can still echo them back reliably.
 */
import type { ResolvedConfig, ToolMode } from './config.js';
import { CAPABILITIES, CapabilityRuntime, TOOL_GROUPS, type ToolGroup } from './capabilities.js';
import { type McpToolDefinition, type ToolCallResult } from './protocol.js';
export interface DshToolDefinition {
    name: string;
    description: string;
    /** JSON Schema handed to Xiaozhi's LLM. */
    inputSchema: McpToolDefinition['inputSchema'];
    /** True when the tool can change DSH state. */
    write: boolean;
    /** Tool groups this tool draws capabilities from. */
    groups: ToolGroup[];
    /** Capability ids this tool covers (settings-page index + coverage tests). */
    capabilities: string[];
}
interface GroupedToolSpec {
    name: string;
    description: string;
    properties: Record<string, unknown>;
    required: string[];
    write: boolean;
    groups: ToolGroup[];
    capabilities: string[];
    run(args: Record<string, unknown>, runtime: CapabilityRuntime, config: ResolvedConfig): Promise<unknown>;
}
export interface BuiltTools {
    mode: ToolMode;
    tools: DshToolDefinition[];
    groupedRunners: Map<string, GroupedToolSpec>;
}
/** Build the tool list for the configured mode, filtered by group and write flags. */
export declare function buildTools(config: ResolvedConfig): BuiltTools;
export interface ToolRunnerDeps {
    runtime: CapabilityRuntime;
    config: () => ResolvedConfig;
    /** Sink for one log line per call (the plugin's logger). */
    log?: (message: string) => void;
}
export declare class ToolRunner {
    private readonly deps;
    private built;
    constructor(deps: ToolRunnerDeps);
    /** Rebuild after a config change. */
    refresh(): void;
    get mode(): ToolMode;
    list(): DshToolDefinition[];
    /** MCP `tools/list` payload. */
    definitions(): McpToolDefinition[];
    call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
    private runTool;
    private logCall;
}
/** Capability ids covered by the current tool weaving (coverage assertions). */
export declare function coveredCapabilityIds(tools: readonly DshToolDefinition[]): Set<string>;
export { TOOL_GROUPS, CAPABILITIES };
