/**
 * dsh-xiaozhi - settings-page API.
 *
 * The DSH Web settings page is plain browser JavaScript with no host RPC of its
 * own, so it talks to these routes on the same origin. Three deliberate guards:
 *
 *   - a cross-site `Origin` is refused (the page is always same-origin),
 *   - every mutating call must carry `x-dsh-xiaozhi-admin: 1`, a custom header
 *     a simple cross-site form post cannot set (so no CSRF path exists),
 *   - the copied router is built with `cors: false`, so no `Access-Control-*`
 *     header is ever produced and a cross-origin script cannot read a reply.
 *
 * The routes are unauthenticated by design: they only expose/alter *this
 * plugin's* connection settings, and the DSH web server is loopback-bound in
 * the shipped profile. Deployments that expose it on a LAN should front it
 * with a proxy that authenticates, exactly as they must for the DSH UI itself.
 */
import { type Config } from './config.js';
import { HttpRouter } from './dshapi/router.js';
export interface AdminApiDeps {
    status(): Promise<unknown>;
    patchConfig(patch: Config): Promise<unknown>;
    resetConfig(): Promise<unknown>;
    tools(): unknown;
    capabilities(): unknown;
    logs(): string[];
    /** `body.id` scopes the reconnect to one device; absent reconnects all. */
    reconnect(body?: {
        id?: string;
    }): Promise<unknown>;
    /** `body.id`/`body.url` scope the handshake probe; absent probes every device. */
    test(body?: {
        id?: string;
        url?: string;
    }): Promise<unknown>;
    log(message: string): void;
    /**
     * Optional stronger fence: the Host connection service, when it exists, can
     * reject an untrusted request (browser cookie auth + Host/Origin checks) with
     * 401/403 before the plugin's own guards ever run.
     */
    connectionRejection?(req: unknown): number | undefined;
}
/** Build the admin router. `cors: false` is intentional: see the module doc. */
export declare function createAdminRouter(deps: AdminApiDeps): HttpRouter;
