import type { ProviderId, Usage } from "./types.js";
import type { IncomingHttpHeaders } from "node:http";

export interface ProviderDef {
  id: ProviderId;
  upstream: string; // base origin, no trailing slash
}

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  anthropic: { id: "anthropic", upstream: "https://api.anthropic.com" },
  openai: { id: "openai", upstream: "https://api.openai.com" },
};

/**
 * Decide which upstream a request belongs to, from its path + headers.
 * Anthropic agents send `anthropic-version` / hit `/v1/messages`.
 * OpenAI-compatible agents hit `/v1/chat/completions` or `/v1/responses`.
 */
export function detectProvider(
  path: string,
  headers: IncomingHttpHeaders,
  enabled: ProviderId[],
): ProviderId | null {
  const has = (id: ProviderId) => enabled.includes(id);

  if (headers["anthropic-version"] || path.startsWith("/v1/messages")) {
    return has("anthropic") ? "anthropic" : null;
  }
  if (
    path.includes("/chat/completions") ||
    path.startsWith("/v1/responses") ||
    path.startsWith("/v1/completions") ||
    path.startsWith("/v1/embeddings")
  ) {
    return has("openai") ? "openai" : null;
  }
  // Fall back to the first enabled provider so unknown routes still proxy.
  return enabled[0] ?? null;
}

export function upstreamFor(id: ProviderId): string {
  // Env override lets you point at a mock (tests) or a self-hosted gateway.
  const override = process.env[`BLACKBOX_UPSTREAM_${id.toUpperCase()}`];
  return override ?? PROVIDERS[id].upstream;
}

// ── Pricing ──────────────────────────────────────────────────────────────
// USD per 1M tokens [input, output]. Approximate; meant to be configurable.
// Matched by longest-prefix against the model id.
const PRICING: Array<[prefix: string, input: number, output: number]> = [
  // Anthropic
  ["claude-opus-4", 15, 75],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-4", 1, 5],
  ["claude-3-5-haiku", 0.8, 4],
  ["claude-3-5-sonnet", 3, 15],
  ["claude-3-opus", 15, 75],
  ["claude-3-haiku", 0.25, 1.25],
  ["claude-", 3, 15], // generic fallback
  // OpenAI
  ["gpt-4o-mini", 0.15, 0.6],
  ["gpt-4o", 2.5, 10],
  ["gpt-4.1-mini", 0.4, 1.6],
  ["gpt-4.1", 2, 8],
  ["o3-mini", 1.1, 4.4],
  ["o1", 15, 60],
  ["gpt-", 2.5, 10], // generic fallback
];

const DEFAULT_PRICE: [number, number] = [3, 15];

export function priceFor(model: string): [number, number] {
  const m = model.toLowerCase();
  let best: [number, number] | null = null;
  let bestLen = -1;
  for (const [prefix, input, output] of PRICING) {
    if (m.startsWith(prefix) && prefix.length > bestLen) {
      best = [input, output];
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_PRICE;
}

export function computeCost(model: string, usage: Usage): number {
  const [inP, outP] = priceFor(model);
  const inTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return (inTokens / 1_000_000) * inP + (usage.outputTokens / 1_000_000) * outP;
}

// ── Usage extraction ─────────────────────────────────────────────────────

/** Parse a non-streaming JSON response body for usage + model. */
export function usageFromJson(
  provider: ProviderId,
  body: unknown,
): { model: string; usage: Usage } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const model: string = b.model ?? "unknown";

  if (provider === "anthropic" && b.usage) {
    return {
      model,
      usage: {
        inputTokens: b.usage.input_tokens ?? 0,
        outputTokens: b.usage.output_tokens ?? 0,
        cacheReadTokens: b.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: b.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
  if (provider === "openai" && b.usage) {
    return {
      model,
      usage: {
        inputTokens: b.usage.prompt_tokens ?? 0,
        outputTokens: b.usage.completion_tokens ?? 0,
      },
    };
  }
  return null;
}

/**
 * Stateful accumulator for streaming (SSE) responses. Feed it each parsed
 * `data:` JSON object; it tracks usage as it arrives across events.
 */
export class StreamUsageAccumulator {
  model = "unknown";
  private usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private gotUsage = false;

  constructor(private provider: ProviderId) {}

  feed(event: Record<string, any>) {
    if (this.provider === "anthropic") {
      // message_start carries input + cache usage; message_delta carries final output.
      if (event.type === "message_start" && event.message) {
        this.model = event.message.model ?? this.model;
        const u = event.message.usage ?? {};
        this.usage.inputTokens = u.input_tokens ?? this.usage.inputTokens;
        this.usage.cacheReadTokens = u.cache_read_input_tokens ?? this.usage.cacheReadTokens;
        this.usage.cacheWriteTokens = u.cache_creation_input_tokens ?? this.usage.cacheWriteTokens;
        this.gotUsage = true;
      }
      if (event.type === "message_delta" && event.usage) {
        this.usage.outputTokens = event.usage.output_tokens ?? this.usage.outputTokens;
        this.gotUsage = true;
      }
    } else {
      // OpenAI: usage only present when stream_options.include_usage = true.
      if (event.model) this.model = event.model;
      if (event.usage) {
        this.usage.inputTokens = event.usage.prompt_tokens ?? this.usage.inputTokens;
        this.usage.outputTokens = event.usage.completion_tokens ?? this.usage.outputTokens;
        this.gotUsage = true;
      }
    }
  }

  result(): { model: string; usage: Usage } | null {
    return this.gotUsage ? { model: this.model, usage: this.usage } : null;
  }
}
