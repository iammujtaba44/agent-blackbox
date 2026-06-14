import type { BudgetPolicy } from "../types.js";
import type { Session } from "../session.js";
import { usd } from "../log.js";

export type BudgetLevel = "ok" | "warn" | "block";

export interface BudgetVerdict {
  level: BudgetLevel;
  reason?: string;
}

const WARN_RATIO = 0.8;

/**
 * Pre-flight kill-switch. Enforced on spend already accumulated: once a
 * ceiling is reached, every further request is refused until the user
 * grants more budget. `action: "warn"` never blocks, only signals.
 */
export function checkBudget(session: Session, policy: BudgetPolicy): BudgetVerdict {
  const checks: Array<{ label: string; spent: number; limit: number }> = [];
  if (policy.perSession > 0) {
    checks.push({ label: "session", spent: session.sessionTotal, limit: policy.perSession + session.sessionGrant });
  }
  if (policy.perDay > 0) {
    checks.push({ label: "daily", spent: session.dailyTotal, limit: policy.perDay + session.dailyGrant });
  }

  let level: BudgetLevel = "ok";
  let reason: string | undefined;

  for (const c of checks) {
    if (c.spent >= c.limit) {
      const msg = `${c.label} budget reached (${usd(c.spent)} / ${usd(c.limit)})`;
      if (policy.action === "block") return { level: "block", reason: msg };
      level = "warn";
      reason = msg;
    } else if (c.spent >= c.limit * WARN_RATIO) {
      level = "warn";
      reason = `approaching ${c.label} budget (${usd(c.spent)} / ${usd(c.limit)})`;
    }
  }

  return { level, reason };
}
