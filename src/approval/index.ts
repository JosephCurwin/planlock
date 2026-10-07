/*
Module: Out-of-band human approval
Purpose:
 - Approval and Hold override are decisions the model must never be able to make.
 - In APPROVAL_MODE=human (default) they are granted only through the admin HTTP
   channel (src/admin.ts), authenticated with APPROVER_TOKEN, which is never
   exposed via MCP and stripped from the upstream child's environment.
 - APPROVAL_MODE=self restores the legacy behavior (model calls agreement_approve).
   It exists only for the older behavior test suite and offers no guarantee.
*/

export type ApprovalMode = "human" | "self";

export function getApprovalMode(): ApprovalMode {
  return process.env.APPROVAL_MODE === "self" ? "self" : "human";
}

// One-time override grant for the current Hold, issued by the human approver.
let overrideGrant: { justification: string; grantedAt: string } | null = null;

export function grantOverride(justification: string): void {
  overrideGrant = { justification, grantedAt: new Date().toISOString() };
}

export function consumeOverrideGrant(): { justification: string; grantedAt: string } | null {
  const g = overrideGrant;
  overrideGrant = null;
  return g;
}

export function clearOverrideGrant(): void {
  overrideGrant = null;
}

export function hasOverrideGrant(): boolean {
  return overrideGrant !== null;
}
