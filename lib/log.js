/**
 * dsh-xiaozhi - bounded in-memory log.
 *
 * The settings page needs the last few connection/tool events to explain a
 * failure ("handshake rejected: HTTP 401", "no route for GET /sessions"). Those
 * live in the DSH host process, so the plugin keeps a small ring buffer instead
 * of asking the user to find a host log file.
 */
export class RingLog {
    capacity;
    prefix;
    sink;
    entries = [];
    startedAt = Date.now();
    constructor(capacity = 300, prefix = 'dsh-xiaozhi', sink) {
        this.capacity = capacity;
        this.prefix = prefix;
        this.sink = sink;
    }
    push(message) {
        const line = `[${new Date().toISOString()}] ${String(message)}`;
        this.entries.push(line);
        if (this.entries.length > this.capacity)
            this.entries.splice(0, this.entries.length - this.capacity);
        try {
            this.sink?.(`${this.prefix}: ${message}`);
        }
        catch {
            /* a broken host logger must not break the plugin */
        }
    }
    lines() {
        return [...this.entries];
    }
    since() {
        return this.startedAt;
    }
    clear() {
        this.entries.length = 0;
    }
}
//# sourceMappingURL=log.js.map