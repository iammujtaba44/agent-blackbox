// Shared types for Agent Black Box.

export type EnforcementAction = "block" | "redact" | "warn";

export interface SecretsPolicy {
  /** What to do when a secret is detected in an outbound request. */
  action: EnforcementAction;
  /** Glob-ish allowlist of values to ignore (e.g. "test_key_*"). */
  allow: string[];
  /** Also scan for values found in the project's .env file(s). */
  scanEnvFiles: boolean;
}

export interface BudgetPolicy {
  /** Hard ceiling for a single proxy session (USD). 0 disables. */
  perSession: number;
  /** Hard ceiling per calendar day (USD). 0 disables. */
  perDay: number;
  /** What to do when a ceiling is hit. "warn" never halts the agent. */
  action: "block" | "warn";
}

export interface Config {
  port: number;
  secrets: SecretsPolicy;
  budget: BudgetPolicy;
  /** Enabled provider routes. */
  providers: ProviderId[];
}

export type ProviderId = "anthropic" | "openai";

export interface DetectedSecret {
  /** Human label, e.g. "AWS Access Key". */
  type: string;
  /** The matched value (already truncated for display). */
  preview: string;
  /** Where in the request it was found, e.g. "messages[2].content". */
  where: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface RequestRecord {
  id: string;
  ts: number;
  provider: ProviderId;
  model: string;
  usage: Usage;
  costUsd: number;
  blocked: boolean;
  blockReason?: string;
  secrets: DetectedSecret[];
}
