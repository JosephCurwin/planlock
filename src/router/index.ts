/*
Module: Router preconditions, payload normalization, templates, and response envelopes
Grounding:
- protocol.yaml.routes (preconditions, effects, shorthand semantics)
- protocol.yaml.response_envelope (fields and headers)
- system prompt: plan:'$ACTIVE_PLAN' + plan_hash shorthand, Hold behavior
Responsibilities:
- Guard action_start against state/hold using allowed_routes_by_state
- Validate/normalize payloads (Bug/Gap macros and shorthands)
- Plan integrity checks and shorthand expansion for Feature continuation
- Provide payload templates and required signals per route for Start-Ack
- Build standardized response envelopes for action_commit results
Public API (exports):
- function checkRouteAllowedInState(routeKey, currentState): { ok, hint? }
- function normalizePayloadForRoute(routeKey, payload, flags): normalizedPayload
- function verifyPlanIntegrityForContinuation(inputPlanOrShorthand, activePlan, activePlanHash): { ok, conflictHint? }
- function buildPayloadTemplate(routeKey, seqContext?): object
- function signalsForRoute(routeKey): string[]
- function buildResponseEnvelope({ statusCode, verdict?, body?, error? }, stateSnapshot): MCP-compatible content
Consumes:
- src/protocol/index.ts (routes, conflict scenarios)
- src/state/index.ts (seqContext snapshot)
- src/validation/plans.ts
Notes:
- Do not log or mutate state here
*/

import { getProtocolDoc, getConflictScenarios } from "../protocol/index.js";
import { SequentialContext, computePlanHash } from "../state/index.js";

export interface RouteCheckResult {
  ok: boolean;
  hint?: string;
}

export function checkRouteAllowedInState(routeKey: string, currentState: string): RouteCheckResult {
  const protocolDoc = getProtocolDoc();
  const allowedByState = protocolDoc.state_model.allowed_routes_by_state?.[currentState] || [];
  
  if (allowedByState.includes(routeKey)) {
    return { ok: true };
  }
  
  const hint = currentState === 'seq_active'
    ? 'Only PATCH /feature/implement/active is allowed while a sequential plan is active.'
    : `Route not permitted in state ${currentState}.`;
    
  return { ok: false, hint };
}

export function normalizePayloadForRoute(routeKey: string, payload: any): any {
  const normalized = { ...payload };

  if (routeKey === 'PATCH /bug/diagnose/implement-fix') {
    return normalizeDiagnosticFixPayload(normalized);
  }
  
  if (routeKey === 'PATCH /gap/correct') {
    return normalizeCorrectionPlanPayload(normalized);
  }
  
  return normalized;
}

function normalizeDiagnosticFixPayload(p: any): any {
  const out = { ...p };
  if (typeof out.cleanup === "undefined") {
    out.cleanup = [];
  }
  return out;
}

function normalizeCorrectionPlanPayload(p: any): any {
  const out = { ...p };
  if (Array.isArray(out.modification_plan)) {
    out.modification_plan = out.modification_plan.map((entry: any) => {
      if (typeof entry === "string") {
        return { change: entry };
      }
      // if already { change: "..." }, keep it
      return entry;
    });
  }
  return out;
}

export interface PlanIntegrityResult {
  ok: boolean;
  conflictHint?: string;
  expandedPayload?: any;
}

export function verifyPlanIntegrityForContinuation(
  inputPlanOrShorthand: any, 
  activePlan: any, 
  activePlanHash: string
): PlanIntegrityResult {
  const payload = { ...inputPlanOrShorthand };
  
  // Handle shorthand
  if (payload.plan === "$ACTIVE_PLAN") {
    if (!('plan_hash' in payload) || typeof payload.plan_hash !== 'string') {
      return {
        ok: false,
        conflictHint: "Feature continuation shorthand requires plan_hash"
      };
    }
    const providedHash = payload.plan_hash;
    if (!activePlan || providedHash !== activePlanHash) {
      const conflictScenarios = getConflictScenarios();
      const hint = conflictScenarios.get('feature_plan_hash_mismatch') || 
        "Plan hash mismatch. Provide the full unchanged plan or resend plan:'$ACTIVE_PLAN' with the correct plan_hash from the last response.";
      return { ok: false, conflictHint: hint };
    }
    // Expand shorthand to full plan
    payload.plan = activePlan;
  }
  
  // Plan integrity check (deep equality)
  const samePlan = payload.plan && activePlan ? 
    JSON.stringify(payload.plan) === JSON.stringify(activePlan) : false;
    
  if (!samePlan) {
    return {
      ok: false,
      conflictHint: "Plan integrity check failed: Provide the complete unchanged plan identical to the active plan."
    };
  }
  
  return { ok: true, expandedPayload: payload };
}

export function signalsForRoute(routeStr: string): string[] {
  switch (routeStr) {
    case 'GET /action/help': return [];
    case 'POST /feature/implement': return ['approval'];
    case 'PATCH /feature/implement/active': return ['continue'];
    case 'POST /action/active/acknowledge-audit-failure': return ['override'];
    case 'POST /feature/implement/abort': return [];
    default: return [];
  }
}

export function buildPayloadTemplate(routeStr: string, seqContext?: SequentialContext | null): any {
  switch (routeStr) {
    case 'GET /action/help':
      return {};
    case 'POST /feature/implement':
      return {
        plan: {
          objective: "",
          strategic_summary: "",
          steps: [
            {
              name: "", description: "", verification: [""]
            }
          ]
        },
        // Stage 1 Agreement gating: include placeholder; must be replaced with a valid approved agreement_id
        agreement_id: "<approved agreement_id>",
        supersedes_active_plan: false,
        _signals: { approval: "PLAN APPROVED" }
      };
    case 'PATCH /feature/implement/active':
      return seqContext && seqContext.planHash
        ? { plan: "$ACTIVE_PLAN", plan_hash: seqContext.planHash, _signals: { continue: "" } }
        : { plan: seqContext?.plan || {}, _signals: { continue: "" } };
    case 'POST /action/active/acknowledge-audit-failure':
      return { justification: "", _signals: { override: "" } };
    case 'GET /bug/diagnose':
      return {};
    case 'POST /bug/capture-failure':
      return { failed_approach: "", observed_failure: "" };
    case 'PATCH /bug/diagnose/implement-fix':
      return {
        path: "implement_fix",
        previous_attempt_failed: false,
        root_cause: "",
        proposed_fix: "",
        justification: "",
        cleanup: []
        ,
        agreement_id: "<approved agreement_id>"
      };
    case 'PATCH /gap/correct':
      return {
        root_cause: "",
        // Shorthand allowed; server will normalize string into { change }
        modification_plan: ["Describe change to apply"],
        cleanup: []
        ,
        agreement_id: "<approved agreement_id>"
      };
    case 'POST /feature/implement/abort':
      return {};
    default:
      return {};
  }
}

export function buildResponseEnvelope(
  params: {
    statusCode: number;
    verdict?: 'PASSED' | 'FAILED';
    body?: any;
    error?: any;
  },
  stateSnapshot: any
): any {
  const envelope: any = {
    status_code: params.statusCode,
    headers: params.verdict ? { 'X-Audit-Verdict': params.verdict } : {},
    body: params.body || {},
    state_snapshot: stateSnapshot
  };
  
  if (params.error) {
    envelope.error = params.error;
  }
  
  return {
    content: [{
      type: "text",
      text: JSON.stringify(envelope, null, 2)
    }]
  };
}
