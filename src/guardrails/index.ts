import { getAuditRules } from "../protocol/index.js";
import { Transaction } from "../state/index.js";
import { loadDomainProfile } from "../domain/profile.js";

export interface AuditResult {
  verdict: 'PASSED' | 'FAILED';
  reason?: string;
  conflictStatus?: number;
  conflictHint?: string;
}

export function enforceProtocolAuditRules(
  txn: Transaction,
  params: { bugCaptureLogged: boolean }
): AuditResult {
  const routeKey = `${txn.method} ${txn.path}`;
  const auditRules = getAuditRules();
  
  for (const rule of auditRules) {
    // Rule: disallow write/edit under investigation
    if (rule.id === 'disallow_write_in_investigation') {
      if (txn.permission_class === 'investigation') {
        const prof = loadDomainProfile();
        const allowed = new Set(txn.routeAllowedTools || []);
        const domainWrites = new Set(prof.write_tools || []);
        let illegalUsed: string[] = [];
        if (domainWrites.size > 0) {
          // Use domain-configured write tools when provided
          illegalUsed = txn.usedTools.filter(t => domainWrites.has(t));
        } else {
          // Generic fallback: any tool not allowed by Start-Ack in investigation is illegal
          illegalUsed = txn.usedTools.filter(t => !allowed.has(t));
        }
        if (illegalUsed.length > 0) {
          return { verdict: 'FAILED', reason: rule.reason };
        }
      }
    }

    // Rule: implement_fix requires capture if previous failed
    if (rule.id === 'implement_fix_requires_capture_if_previous_failed' && routeKey === 'PATCH /bug/diagnose/implement-fix') {
      if (txn.payload?.previous_attempt_failed && !params.bugCaptureLogged) {
        return { 
          verdict: 'FAILED', 
          conflictStatus: 409,
          conflictHint: rule.conflict_on_fail?.body?.resolution_hint || "Record the prior failed attempt first via POST /bug/capture-failure."
        };
      }
    }

  }
  
  return { verdict: 'PASSED' };
}
