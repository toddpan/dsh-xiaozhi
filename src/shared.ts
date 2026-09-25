/**
 * dsh-xiaozhi - constants shared between the Host half and the browser page.
 *
 * A DSH client bundle must not import a Host package (the browser module table
 * only carries `react` and other client bundles), so this file exists to hold
 * the values both halves must agree on. `client/client.js` repeats the literals,
 * and `test/client.test.mjs` fails if the two ever drift apart.
 */

import type { ConnectionState } from './mcp-server.js'

/**
 * Fixed mount point of the settings-page API.
 *
 * Deliberately *not* derived from `apiPathPrefix`: the browser page cannot read
 * the Host config, so a configurable admin path would break the page the moment
 * an operator changed it. The configurable prefix only shapes the bundled REST
 * layer (`<apiPathPrefix>/v1`), which external callers discover themselves.
 */
export const ADMIN_BASE = '/dsh-xiaozhi/admin'

/**
 * CSRF guard header required on every admin request.
 *
 * A simple cross-site form post or image tag cannot set a custom header, and a
 * cross-origin `fetch` that sets one must preflight - which this router (built
 * with `cors: false`) never approves. This is what makes an unauthenticated
 * loopback admin API safe to expose on the same origin as the DSH UI.
 */
export const ADMIN_CSRF_HEADER = 'x-dsh-xiaozhi-admin'

/** Badge tone of a connection state on the settings page. */
export type ConnectionTone = 'ok' | 'warn' | 'bad' | 'idle'

/**
 * Which badge tone each connection state maps to.
 *
 * Typed as a total `Record<ConnectionState, …>` on purpose: adding a state to
 * the Host union makes this file fail to compile until the mapping is updated,
 * which is exactly how the page shipped a red badge for a healthy connection
 * once (`ready` was missing from the client's hand-written list).
 */
export const CONNECTION_TONES: Record<ConnectionState, ConnectionTone> = {
  ready: 'ok',
  connecting: 'warn',
  idle: 'idle',
  disabled: 'idle',
  error: 'bad',
}

/** Connection states in display order, for the page's legend and tests. */
export const CONNECTION_STATES = Object.keys(CONNECTION_TONES) as ConnectionState[]

