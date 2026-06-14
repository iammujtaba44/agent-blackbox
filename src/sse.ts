/**
 * Incremental Server-Sent-Events parser. We never modify or buffer the
 * upstream stream for the client — bytes pass through immediately. We only
 * *observe* a copy to pull out `data:` JSON payloads (for usage accounting).
 */
export class SSEParser {
  private buf = "";

  /** Feed a decoded text chunk; returns any complete JSON `data:` objects. */
  push(chunk: string): Record<string, any>[] {
    this.buf += chunk;
    const events: Record<string, any>[] = [];

    let idx: number;
    // SSE events are separated by a blank line (\n\n).
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          // Partial / non-JSON data lines are ignored.
        }
      }
    }
    return events;
  }
}
