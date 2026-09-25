/**
 * dsh-xiaozhi - type-only harness imports.
 *
 * Importing for side effects of the `declare module '@deepseek-ai/cordis'`
 * augmentations: the copied `dshapi/*` modules and `capabilities.ts` subscribe
 * to the harness `session/event` firehose, whose event map is declared by
 * `@deepseek-ai/dsh-session`. Nothing here is emitted to JavaScript — these
 * packages are build-time links from the DSH checkout, not runtime deps.
 */
export {};
