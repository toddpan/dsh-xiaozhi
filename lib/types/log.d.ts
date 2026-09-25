/**
 * dsh-xiaozhi - bounded in-memory log.
 *
 * The settings page needs the last few connection/tool events to explain a
 * failure ("handshake rejected: HTTP 401", "no route for GET /sessions"). Those
 * live in the DSH host process, so the plugin keeps a small ring buffer instead
 * of asking the user to find a host log file.
 */
export declare class RingLog {
    private readonly capacity;
    private readonly prefix;
    private readonly sink?;
    private readonly entries;
    private readonly startedAt;
    constructor(capacity?: number, prefix?: string, sink?: ((line: string) => void) | undefined);
    push(message: string): void;
    lines(): string[];
    since(): number;
    clear(): void;
}
