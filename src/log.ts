/**
 * dsh-xiaozhi - bounded in-memory log.
 *
 * The settings page needs the last few connection/tool events to explain a
 * failure ("handshake rejected: HTTP 401", "no route for GET /sessions"). Those
 * live in the DSH host process, so the plugin keeps a small ring buffer instead
 * of asking the user to find a host log file.
 */

export class RingLog {
  private readonly entries: string[] = []
  private readonly startedAt = Date.now()

  constructor(
    private readonly capacity = 300,
    private readonly prefix = 'dsh-xiaozhi',
    private readonly sink?: (line: string) => void,
  ) {}

  push(message: string): void {
    const line = `[${new Date().toISOString()}] ${String(message)}`
    this.entries.push(line)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    try {
      this.sink?.(`${this.prefix}: ${message}`)
    } catch {
      /* a broken host logger must not break the plugin */
    }
  }

  lines(): string[] {
    return [...this.entries]
  }

  since(): number {
    return this.startedAt
  }

  clear(): void {
    this.entries.length = 0
  }
}
