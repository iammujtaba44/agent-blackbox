/**
 * MCP's stdio transport frames each JSON-RPC message as a single line of UTF-8
 * JSON terminated by a newline (messages must not contain embedded newlines).
 * This buffers partial chunks and emits one entry per complete line, preserving
 * the raw text so we can pass it through (or substitute a redacted version).
 */
export class LineFramer {
  private buf = "";

  push(chunk: string): Array<{ raw: string; json: any | null }> {
    this.buf += chunk;
    const out: Array<{ raw: string; json: any | null }> = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) {
        out.push({ raw: line + "\n", json: null });
        continue;
      }
      let json: any = null;
      try {
        json = JSON.parse(line);
      } catch {
        /* not JSON — pass through untouched */
      }
      out.push({ raw: line + "\n", json });
    }
    return out;
  }
}
