import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DetectedSecret, SecretsPolicy } from "../types.js";

interface Rule {
  type: string;
  re: RegExp;
  /** Capture-group index holding the secret value (default 0 = whole match). */
  group?: number;
  /** If the captured value matches this, it's treated as a placeholder/non-secret. */
  reject?: RegExp;
}

// Obvious non-secrets that show up in `key = "..."`-style assignments.
const PLACEHOLDER =
  /^(?:changeme|change_me|example|examples?|your[_-]?\w*|my[_-]?\w*|placeholder|todo|tbd|xxx+|x{3,}|none|null|undefined|true|false|test|testing|dummy|sample|redacted|secret|password|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|process\.env\.\w+)$/i;

// High-confidence, low-false-positive patterns for well-known credentials.
const RULES: Rule[] = [
  { type: "AWS Access Key", re: /\b(?:AKIA|ASIA|AGPA|AIDA)[0-9A-Z]{16}\b/g },
  { type: "GitHub Token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "GitHub Fine-Grained Token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  // Anthropic must precede the generic OpenAI `sk-` rule (more specific first).
  { type: "Anthropic API Key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: "OpenAI API Key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: "Stripe Secret Key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { type: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "Google OAuth Client Secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  { type: "Slack Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "Slack Webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { type: "SendGrid API Key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { type: "Twilio API Key", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { type: "npm Token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: "DigitalOcean Token", re: /\bdop_v1_[a-f0-9]{64}\b/g },
  { type: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: "Private Key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { type: "Generic Bearer Secret", re: /\b(?:bearer\s+)([A-Za-z0-9_\-.=]{24,})\b/gi, group: 1 },
  // Generic `secret/api_key/token/password = "<value>"` — value must be long
  // enough and not a placeholder. Captures only the value (group 2) for redaction.
  {
    type: "Hardcoded Credential",
    re: /\b(api[_-]?key|secret[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    group: 2,
    reject: PLACEHOLDER,
  },
];

function preview(value: string): string {
  const v = value.replace(/\s+/g, " ").trim();
  if (v.length <= 12) return v[0] + "…" + v.slice(-2);
  return v.slice(0, 4) + "…" + v.slice(-4);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isAllowed(value: string, allow: string[]): boolean {
  return allow.some((g) => globToRegExp(g).test(value));
}

/** Shannon entropy in bits/char — used as a conservative generic catch. */
function entropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  let e = 0;
  for (const c in freq) {
    const p = freq[c] / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

function looksHighEntropy(token: string): boolean {
  if (token.length < 24) return false;
  if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) return false; // mixed charset
  if (/\s/.test(token)) return false;
  return entropy(token) >= 4.0;
}

/** Load secret-like values from project .env files (filtered to avoid noise). */
export function loadEnvSecrets(cwd: string = process.cwd()): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const files = [".env", ".env.local", ".env.development", ".env.production"];
  for (const f of files) {
    const p = resolve(cwd, f);
    if (!existsSync(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const name = m[1];
      let value = m[2].trim().replace(/^["']|["']$/g, "");
      if (value.length < 8) continue; // too short to be a meaningful secret
      const sensitiveName = /(secret|key|token|password|passwd|pwd|api|auth|credential|private)/i.test(name);
      if (sensitiveName || looksHighEntropy(value)) {
        out.push({ name, value });
      }
    }
  }
  return out;
}

export interface SecretScanner {
  scan(text: string, where: string): DetectedSecret[];
  /** Replace every detected secret value in `text` with a typed placeholder. */
  redact(text: string): string;
}

/** Build a scanner bound to the current policy + (optionally) project .env values. */
export function createScanner(policy: SecretsPolicy, cwd: string = process.cwd()): SecretScanner {
  const envSecrets = policy.scanEnvFiles ? loadEnvSecrets(cwd) : [];

  function scan(text: string, where: string): DetectedSecret[] {
    if (!text) return [];
    const found: DetectedSecret[] = [];
    const seen = new Set<string>();

    const push = (type: string, value: string) => {
      if (isAllowed(value, policy.allow)) return;
      // Dedupe by value so the first (most-specific) rule that matches wins —
      // e.g. an `sk-ant-…` key is classified Anthropic, not generic OpenAI.
      if (seen.has(value)) return;
      seen.add(value);
      found.push({ type, preview: preview(value), where });
    };

    for (const { type, re, group, reject } of RULES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const value = group != null ? m[group] : m[0];
        if (!value) continue;
        if (reject && reject.test(value)) continue;
        push(type, value);
        if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
      }
    }

    // Verbatim matches of known .env secret values.
    for (const { name, value } of envSecrets) {
      if (text.includes(value)) push(`.env value (${name})`, value);
    }

    return found;
  }

  function redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const { type, re, group, reject } of RULES) {
      out = out.replace(new RegExp(re.source, re.flags), (match, ...args) => {
        // args = [g1, g2, ..., offset, fullString]; capture groups are 0-indexed there.
        const value = group != null ? (args[group - 1] as string | undefined) : match;
        if (!value) return match;
        if (reject && reject.test(value)) return match;
        if (isAllowed(value, policy.allow)) return match;
        // Replace only the secret value within the match (keeps `key=` prefix).
        return match.replace(value, `[REDACTED:${type}]`);
      });
    }
    for (const { name, value } of envSecrets) {
      if (!isAllowed(value, policy.allow)) {
        out = out.split(value).join(`[REDACTED:.env ${name}]`);
      }
    }
    return out;
  }

  return { scan, redact };
}

/**
 * Walk a parsed request body and scan every string field, recording a
 * dotted path so the user knows *where* the leak is.
 */
export function scanRequestBody(scanner: SecretScanner, body: unknown): DetectedSecret[] {
  const out: DetectedSecret[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      out.push(...scanner.scan(node, path || "body"));
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(body, "");
  return out;
}
