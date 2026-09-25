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
import { SECRET_MASK, isMaskedEndpoint } from './config.js';
import { HttpRouter, sendJson } from './dshapi/router.js';
import { ADMIN_CSRF_HEADER } from './shared.js';
/** Build the admin router. `cors: false` is intentional: see the module doc. */
export function createAdminRouter(deps) {
    const router = new HttpRouter({ cors: false, apiKey: '' });
    const guard = (mutating, handler) => {
        return async (req, res, params, query, body) => {
            // Layer 1: let the Host connection service judge the request when it can.
            // It must be called *as a method* (it reads `this`), so the deps callback
            // owns that call. A throw means "cannot judge", never "allow".
            let rejection;
            try {
                rejection = deps.connectionRejection?.(req);
            }
            catch {
                rejection = undefined;
            }
            if (rejection !== undefined && rejection !== 0) {
                deps.log(`admin request refused: host connection returned ${rejection}`);
                sendJson(res, rejection, { ok: false, error: 'request rejected by the host connection', code: 'FORBIDDEN_HOST' });
                return;
            }
            // Layer 2: same-origin only. The settings page is always same-origin.
            const origin = req.headers.origin;
            if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
                const host = String(req.headers.host ?? '');
                const allowed = host !== '' && (origin === `http://${host}` || origin === `https://${host}`);
                if (!allowed) {
                    deps.log(`admin request refused: cross-site origin ${origin}`);
                    sendJson(res, 403, { ok: false, error: 'cross-site requests are not allowed', code: 'FORBIDDEN_ORIGIN' });
                    return;
                }
            }
            // A browser states the request's site relationship outright; honour it.
            if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') {
                deps.log('admin request refused: sec-fetch-site= cross-site');
                sendJson(res, 403, { ok: false, error: 'cross-site requests are not allowed', code: 'FORBIDDEN_ORIGIN' });
                return;
            }
            // Layer 3: every call - read or write - must prove it is the settings page
            // by carrying a custom header. Reads are included so a cross-site script
            // cannot even enumerate the config through this API.
            if (String(req.headers[ADMIN_CSRF_HEADER] ?? '') !== '1') {
                deps.log(`admin request refused: missing ${ADMIN_CSRF_HEADER} header`);
                sendJson(res, 403, {
                    ok: false,
                    error: `admin calls require the ${ADMIN_CSRF_HEADER}: 1 header`,
                    code: 'FORBIDDEN_CSRF',
                });
                return;
            }
            if (mutating && ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method ?? 'GET').toUpperCase())) {
                // Unreachable today (mutating routes are POST/PATCH), kept as a tripwire.
                deps.log('admin request refused: mutating handler on a safe method');
                sendJson(res, 405, { ok: false, error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
                return;
            }
            try {
                await handler(req, res, params, query, body);
            }
            catch (err) {
                const message = err?.message ?? String(err);
                deps.log(`admin handler failed: ${message}`);
                if (!res.headersSent) {
                    sendJson(res, 500, { ok: false, error: message, code: 'ADMIN_ERROR' });
                }
            }
        };
    };
    router.get('/status', guard(false, async (_req, res) => {
        sendJson(res, 200, { ok: true, data: await deps.status() });
    }));
    router.patch('/config', guard(true, async (req, res, _params, _query, body) => {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(res, 400, { ok: false, error: 'config body must be a JSON object', code: 'BAD_REQUEST' });
            return;
        }
        // The page loads a redacted config, so the user is very likely saving
        // masked sentinels back. Never let a sentinel overwrite a real secret.
        const patch = { ...body };
        for (const key of ['apiKey', 'serverToken']) {
            if (patch[key] === SECRET_MASK)
                delete patch[key];
        }
        if (isMaskedEndpoint(patch.endpointUrl))
            delete patch.endpointUrl;
        if (patch.endpointHeaders) {
            patch.endpointHeaders = Object.fromEntries(Object.entries(patch.endpointHeaders).filter(([, value]) => value !== SECRET_MASK));
        }
        sendJson(res, 200, { ok: true, data: await deps.patchConfig(patch) });
    }));
    router.post('/config/reset', guard(true, async (_req, res) => {
        sendJson(res, 200, { ok: true, data: await deps.resetConfig() });
    }));
    router.get('/tools', guard(false, async (_req, res) => {
        sendJson(res, 200, { ok: true, data: deps.tools() });
    }));
    router.get('/capabilities', guard(false, async (_req, res) => {
        sendJson(res, 200, { ok: true, data: deps.capabilities() });
    }));
    router.get('/logs', guard(false, async (_req, res) => {
        sendJson(res, 200, { ok: true, data: { lines: deps.logs() } });
    }));
    router.post('/reconnect', guard(true, async (_req, res) => {
        sendJson(res, 200, { ok: true, data: await deps.reconnect() });
    }));
    router.post('/test', guard(true, async (_req, res) => {
        sendJson(res, 200, { ok: true, data: await deps.test() });
    }));
    return router;
}
//# sourceMappingURL=admin.js.map