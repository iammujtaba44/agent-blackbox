import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./types.js";

export const DEFAULT_CONFIG: Config = {
  port: 4000,
  secrets: {
    action: "block",
    allow: [],
    scanEnvFiles: true,
  },
  budget: {
    perSession: 5.0,
    perDay: 50.0,
    action: "block",
  },
  providers: ["anthropic", "openai"],
};

/**
 * Load `.blackbox.json` from the current working directory if present,
 * shallow-merging it over the defaults. Missing file = pure defaults
 * (the tool must work with zero config).
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  const path = resolve(cwd, ".blackbox.json");
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);

  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid .blackbox.json: ${(err as Error).message}`);
  }

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    secrets: { ...DEFAULT_CONFIG.secrets, ...parsed.secrets },
    budget: { ...DEFAULT_CONFIG.budget, ...parsed.budget },
    providers: parsed.providers ?? DEFAULT_CONFIG.providers,
  };
}
