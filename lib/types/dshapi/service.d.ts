/**
 * dsh-xiaozhi - bundled DSH Web REST layer.
 *
 * This is a **copy** of the route modules of `@dsh-external/dsh-web-service`
 * v0.1.11 (BSD-3-Clause, see NOTICE) kept inside this bundle so the plugin is
 * self-contained: it works whether or not `@dsh-external/dsh-web-service` is
 * installed in the profile, and its own `/dsh-xiaozhi/api` prefix cannot
 * collide with that plugin's `/api/v1`.
 *
 * Only the modules the MCP tool surface needs are mounted here; the reference
 * plugin's `/fs/*` routes are intentionally left out (there is no voice use
 * case for raw filesystem browsing outside a session workspace).
 */
import type { Context } from '@deepseek-ai/cordis';
import { HttpRouter } from './router.js';
import type { WebServiceConfig } from './types.js';
export interface DshApiOptions extends WebServiceConfig {
    /**
     * The plugin's own system-status payload. When omitted (tests, a bare
     * router), a self-contained equivalent is served instead.
     */
    systemStatus?: () => unknown | Promise<unknown>;
}
/**
 * Build the bundled router. The caller owns dispatch: the plugin serves it
 * over HTTP (so a human can curl it) *and* drives it in-process for tool calls.
 */
export declare function createDshApiRouter(ctx: Context, config: DshApiOptions): HttpRouter;
export { HttpRouter };
export { sendJson, readJsonBody, readRawBody, initSseStream } from './router.js';
export type { WebServiceConfig } from './types.js';
