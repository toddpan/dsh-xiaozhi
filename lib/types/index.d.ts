/**
 * dsh-xiaozhi - plugin entry.
 *
 * `apply()` builds one *runtime*: the bundled DSH Web REST layer, the
 * capability runtime, the MCP tool runner and the transport (outbound access
 * point or inbound server). The settings page can replace that runtime live, so
 * every resource is created inside `boot()` and released by its disposer.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type Config as XiaozhiConfig } from './config.js';
export declare const name = "dsh-xiaozhi";
/** The plugin always needs the browser HTTP carrier: admin API + bundled REST layer. */
export declare const inject: string[];
export declare const Config: z<XiaozhiConfig>;
export declare function apply(ctx: Context, rowConfig: XiaozhiConfig): void;
interface Runtime {
    dispose(): void;
}
/**
 * Replace the live runtime with a freshly booted one, **disposing first**.
 *
 * The order is the whole point. Booting while the previous runtime still owns
 * its routes makes the DSH web server throw `duplicate prefix route`; the old
 * runtime would then be disposed on the way out, leaving the plugin with no
 * transport and no admin API at all. Saving any setting failed that way.
 */
export declare function swapRuntime<T extends Runtime>(previous: T | undefined, boot: () => T, log: (message: string) => void): T;
/** Mirrors the shape checks Xiaozhi itself applies to `mcp_endpoint`. */
export declare function validateEndpointUrl(url: string): string | null;
export {};
