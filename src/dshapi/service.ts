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

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { HttpRouter, sendJson } from './router.js'
import { registerWorkspaceRoutes } from './workspaces.js'
import { registerSessionRoutes } from './sessions.js'
import { registerModelRoutes } from './models.js'
import { registerStreamingRoutes } from './streaming.js'
import { registerFileRoutes } from './files.js'
import { registerSkillRoutes } from './skills.js'
import { registerUserQuestionBridge } from './user-questions.js'
import { registerOpenApiRoutes } from './openapi.js'
import type { WebServiceConfig } from './types.js'

export interface DshApiOptions extends WebServiceConfig {
  /**
   * The plugin's own system-status payload. When omitted (tests, a bare
   * router), a self-contained equivalent is served instead.
   */
  systemStatus?: () => unknown | Promise<unknown>
}

/**
 * The reference plugin answers `GET /system/status` from its own code rather
 * than from the copied route modules, so the mirror has to add it back
 * explicitly - otherwise the REST layer serves 34 of the 35 endpoints.
 */
function registerSystemRoutes(
  ctx: Context,
  router: HttpRouter,
  config: DshApiOptions,
  fallback: () => Record<string, unknown>,
): void {
  router.get('/system/status', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      // Resolved per request: the plugin assigns `systemStatus` after the
      // router exists (the capability runtime needs the router's invoker).
      const build = config.systemStatus ?? fallback
      sendJson(res, 200, { ok: true, data: await build() })
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: (err as Error)?.message ?? String(err),
        code: 'INTERNAL_ERROR',
      })
    }
  })
}

/**
 * Build the bundled router. The caller owns dispatch: the plugin serves it
 * over HTTP (so a human can curl it) *and* drives it in-process for tool calls.
 */
export function createDshApiRouter(ctx: Context, config: DshApiOptions): HttpRouter {
  const router = new HttpRouter(config)

  registerSystemRoutes(ctx, router, config, () => {
    const webServer = ctx.get('webServer') as { port?: number; host?: string } | undefined
    const llm = ctx.get('llm') as { listProviders?: () => { id: string }[] } | undefined
    const workspaceRegistry = ctx.get('workspaceRegistry') as { list?: () => unknown[] } | undefined
    return {
      name: 'dsh-xiaozhi',
      version: '0.1.0',
      status: 'running',
      port: webServer?.port ?? 3080,
      host: webServer?.host ?? '127.0.0.1',
      apiPrefix: config.pathPrefix,
      workspacesCount: workspaceRegistry?.list?.()?.length ?? 0,
      providers: llm?.listProviders?.()?.map(provider => provider.id) ?? [],
      authEnabled: Boolean(config.apiKey),
      uptimeSeconds: Math.round(process.uptime()),
      cwd: process.cwd(),
    }
  })
  registerWorkspaceRoutes(ctx, router)
  registerSessionRoutes(ctx, router, config)
  registerModelRoutes(ctx, router)
  registerStreamingRoutes(ctx, router)
  registerFileRoutes(ctx, router, config)
  registerSkillRoutes(ctx, router, config)
  registerUserQuestionBridge(ctx, router)
  registerOpenApiRoutes(router, config)

  return router
}

export { HttpRouter }
export { sendJson, readJsonBody, readRawBody, initSseStream } from './router.js'
export type { WebServiceConfig } from './types.js'
