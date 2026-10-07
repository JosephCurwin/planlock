/*
Module: Control tool 'action_start'
Grounding:
- system prompt: "Action Start Acknowledgment (Start-Ack…)"
- protocol.yaml.routes preconditions; allowed_routes_by_state; signals_required
Responsibilities:
- Accept { route: "METHOD /path", payload: {} }
- Enforce allowed routes by current state and Hold restrictions
- Apply route-specific validations and normalizations (via router and validation modules)
- Handle special Feature semantics: Approval Signal, supersedence (requires justification_for_rewrite), plan validation
- Start a transaction with effective allowed tools (permission class + route override)
- Return Start-Ack: { allowed_tools, signals_required, payload_template }
Public API (exports):
- descriptor for ListTools (name, description, inputSchema)
- function handleActionStart(args, env): Promise<MCP content>
Consumes:
- src/protocol/index.ts, src/router/index.ts, src/validation/plans.ts
- src/state/index.ts (startTransaction, establishPlan path only for POST /feature/implement after approval)
- src/persistence/index.ts (logRecord: txn_started; logEvent when plan approved)
- src/logging/FileLogger.ts
Notes:
- Do not perform operational tool actions here; only start the transaction and validate
*/

import { getRouteRegistry, getPermissionToTools, getConflictScenarios, getProtocolDoc } from "../../protocol/index.js";
import { 
  getServerState, 
  getSeqContext, 
  getBugCaptureLogged,
  startTransaction, 
  establishPlan 
} from "../../state/index.js";
import { 
  checkRouteAllowedInState, 
  normalizePayloadForRoute, 
  verifyPlanIntegrityForContinuation,
  signalsForRoute,
  buildPayloadTemplate,
  buildResponseEnvelope 
} from "../../router/index.js";
import { 
  validateExecutableSpecification,
  validateDiagnosticPlanFix,
  validateCorrectionPlan,
  validateKnowledgeCaptureRecord 
} from "../../validation/plans.js";
import { logRecord, logEvent } from "../../persistence/index.js";
import { FileLogger } from "../../logging/FileLogger.js";
import {
  getAgreement,
  setActiveAgreementForPlan,
  computePlanHash
} from "../../state/index.js";
import { getAvailableToolNames } from "../../upstream/index.js";
import { loadDomainProfile } from "../../domain/profile.js";
import { consumeAgreement } from "../../state/index.js";
import { getApprovalMode, consumeOverrideGrant } from "../../approval/index.js";

function notApprovedHint(): string {
  return getApprovalMode() === "human"
    ? "Agreement is not approved. Only a human approver can approve it (out-of-band approver channel). Present the plan via agreement_phase_message and wait."
    : "Agreement is not approved. Call agreement_approve before starting execution.";
}

const CONSUMED_HINT = "This agreement was already used for an execution. Each approval authorizes exactly one execution; submit a new plan for approval.";

interface ToolEnv {
  logger: FileLogger;
}

function buildActionStartDescription(): string {
  const prof = loadDomainProfile();
  const lines: string[] = [];
  lines.push(
    "Begin a transaction by declaring the route and payload (Start-Ack). The server validates the payload for that route and responds with allowed_tools, signals_required, and a payload_template. " +
    "Use only tools from allowed_tools, and prefer copying the payload_template and filling required signal fields with non-empty values for the next call."
  );
  const uses = prof.examples?.action_start_use_cases || [
    "POST /feature/implement — Establish a two-step plan (prepare; apply). Include _signals.approval:\"PLAN APPROVED\" and an approved agreement_id.",
    "PATCH /feature/implement/active — Execute the next step with plan:'$ACTIVE_PLAN' + plan_hash and include a Continue signal.",
    "POST /action/active/acknowledge-audit-failure — Resolve Hold with Override signal and justification (Hold-only).",
    "POST /feature/implement/abort — Abort the active plan (Hold-only).",
    "GET /bug/diagnose — Read-only triage.",
    "POST /bug/capture-failure — Knowledge capture for a prior failed bug fix.",
    "PATCH /bug/diagnose/implement-fix — Apply a bug fix (requires agreement_id; prior capture if previous_attempt_failed=true).",
    "PATCH /gap/correct — Apply a correction plan (requires agreement_id)."
  ];
  lines.push("Use cases:");
  for (const u of uses) lines.push(`- ${u}`);
  return lines.join("\n");
}

export const descriptor = {
  name: "action_start",
  description: buildActionStartDescription(),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["route", "payload"],
    properties: {
      route: {
        type: "string",
        description: "METHOD SP PATH format matching a declared server route, e.g., 'POST /feature/implement'. Determines which validation schema applies to payload.",
        pattern: "^(GET|POST|PATCH|DELETE)\\s\\/.+"
      },
      payload: {
        type: "object",
        description: "Route-specific payload object that must conform to the route's expected schema. See description for minimal shapes."
      }
    }
  }
};

export async function handleActionStart(args: any, env: ToolEnv): Promise<any> {
  const route = args?.route as string;
  const payload = args?.payload || {};
  
  const routeRegistry = getRouteRegistry();
  const routeInfo = routeRegistry.get(route);
  if (!routeInfo) {
    return buildResponseEnvelope({
      statusCode: 400,
      body: { message: `Unknown route: ${route}` }
    }, { state: getServerState(), seq_context: null });
  }
  
  const currentState = getServerState();
  const seqContext = getSeqContext();
  const protocolDoc = getProtocolDoc();
  
  // Hold state enforcement from protocol
  if (currentState === 'hold') {
    const allowedInHold = protocolDoc.state_model.allowed_routes_by_state.hold || [];
    const allowedRoutes = allowedInHold.map((r: string) => {
      const parts = r.split(' ');
      return `${parts[0]} ${parts.slice(1).join(' ')}`;
    });
    
    if (!allowedRoutes.includes(route)) {
      return buildResponseEnvelope({
        statusCode: 403,
        body: {
          message: "[HOLD STATE] Operation not permitted while on hold",
          allowed_routes: allowedRoutes
        }
      }, { state: currentState, seq_context: null });
    }
  }
  
  // Enforce allowed routes by state (idle, seq_active)
  const routeStr = route; // "METHOD /path"
  
  // Supersedence exception: allow POST /feature/implement in seq_active only when supersedence is properly declared
  let supersedenceOK = false;
  if (currentState === 'seq_active' && routeStr === 'POST /feature/implement') {
    const fp = payload;
    supersedenceOK = !!fp?.supersedes_active_plan && !!fp?.plan?.justification_for_rewrite;
  }
  
  const routeCheck = checkRouteAllowedInState(routeStr, currentState);
  if (currentState !== 'hold') {
    if (!routeCheck.ok && !supersedenceOK) {
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: routeCheck.hint }
      }, { state: currentState, seq_context: null });
    }
  }
  
  // Route-specific preconditions and validations
  let processedPayload = payload;
  
  if (route === 'POST /feature/implement') {
    const approval = payload?._signals?.approval;
    if (approval !== "PLAN APPROVED") {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: "Missing required Approval Signal: exact text 'PLAN APPROVED'." }
      }, { state: currentState, seq_context: null });
    }
    const plan = payload.plan;
    const v = validateExecutableSpecification(plan);
    if (!v.ok) {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: `Invalid plan: ${v.error}` }
      }, { state: currentState, seq_context: null });
    }
    
    // Handle supersedence
    if (currentState === 'seq_active' && seqContext) {
      const supersedes = payload.supersedes_active_plan;
      const justification = payload.plan?.justification_for_rewrite;
      
      if (!supersedes || !justification) {
        const conflictScenarios = getConflictScenarios();
        const hint = conflictScenarios.get('start_new_plan_while_active');
        return buildResponseEnvelope({
          statusCode: 409,
          body: {
            resolution_hint: hint,
            active_plan: seqContext.plan
          }
        }, { state: currentState, seq_context: null });
      }
    }
    
    // Stage 1 Agreement gate for Feature plan establishment
    // Require an approved agreement_id whose plan exactly equals the payload.plan
    const agreementId = payload?.agreement_id;
    if (!agreementId || typeof agreementId !== "string") {
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: "Missing or invalid agreement_id. Submit the plan via agreement_submit, then agreement_approve, then include agreement_id in this payload." }
      }, { state: currentState, seq_context: null });
    }
    const rec = getAgreement(agreementId);
    if (!rec) {
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: "agreement_id was not found. Re-submit the plan with agreement_submit and include the returned id." }
      }, { state: currentState, seq_context: null });
    }
    if (rec.status !== 'approved') {
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: notApprovedHint() }
      }, { state: currentState, seq_context: null });
    }
    if (rec.plan_type !== 'feature_executable') {
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: "Agreement type mismatch. Expected feature_executable for POST /feature/implement." }
      }, { state: currentState, seq_context: null });
    }
    const incomingHash = computePlanHash(plan);
    if (incomingHash !== rec.plan_hash) {
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: "Agreement-plan mismatch. The execution payload's plan must exactly match the approved agreement's plan." }
      }, { state: currentState, seq_context: null });
    }
    if (!consumeAgreement(agreementId)) {
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: CONSUMED_HINT }
      }, { state: currentState, seq_context: null });
    }
    await logEvent("AGREEMENT_CONSUMED", { agreement_id: agreementId });
    // Establish new plan and link the agreement
    establishPlan(plan, payload.directive, payload.plan_type);
    setActiveAgreementForPlan(agreementId);
    await logEvent("PLAN_APPROVED", { 
      plan: plan,
      directive: payload.directive,
      plan_type: payload.plan_type
    });
    // For Start-Ack response later
    processedPayload = payload;
  }
  else if (route === 'PATCH /feature/implement/active') {
    if (currentState !== 'seq_active' || !seqContext) {
      const conflictScenarios = getConflictScenarios();
      const hint = conflictScenarios.get('continue_without_active_plan');
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: hint }
      }, { state: currentState, seq_context: null });
    }
    const cont = payload?._signals?.continue;
    if (!cont) {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: "Missing required Continue Signal to proceed to the next Step." }
      }, { state: currentState, seq_context: null });
    }
    
    // Handle explicit shorthand case before verifyPlanIntegrityForContinuation
    if (payload.plan === "$ACTIVE_PLAN") {
      if (!('plan_hash' in payload) || typeof payload.plan_hash !== 'string') {
        return buildResponseEnvelope({
          statusCode: 400,
          body: { message: "Feature continuation shorthand requires plan_hash" }
        }, { state: currentState, seq_context: null });
      }
      if (payload.plan_hash !== seqContext.planHash) {
        const conflictScenarios = getConflictScenarios();
        const hint = conflictScenarios.get('feature_plan_hash_mismatch');
        return buildResponseEnvelope({
          statusCode: 409,
          verdict: 'FAILED',
          body: { resolution_hint: hint }
        }, { state: currentState, seq_context: null });
      }
      // Expand shorthand
      processedPayload = { ...payload, plan: seqContext.plan };
    } else {
      processedPayload = payload;
    }
    
    // Plan integrity check for general equality (after shorthand expansion)
    const integrityResult = verifyPlanIntegrityForContinuation(processedPayload, seqContext.plan, seqContext.planHash);
    if (!integrityResult.ok) {
      const statusCode = integrityResult.conflictHint?.includes("hash mismatch") ? 409 : 400;
      const verdict = statusCode === 409 ? 'FAILED' : undefined;
      return buildResponseEnvelope({
        statusCode,
        verdict,
        body: { 
          message: integrityResult.conflictHint || "Plan validation failed",
          resolution_hint: integrityResult.conflictHint 
        }
      }, { state: currentState, seq_context: null });
    }
  }
  else if (route === 'GET /action/help') {
    // No validation or signals; purely informational route
    processedPayload = payload || {};
  }
  else if (route === 'POST /action/active/acknowledge-audit-failure') {
    if (currentState !== 'hold') {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: "Not in hold state. Nothing to acknowledge." }
      }, { state: currentState, seq_context: null });
    }
    const overrideSig = payload?._signals?.override;
    if (!overrideSig) {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: "Missing required Override Signal." }
      }, { state: currentState, seq_context: null });
    }
    if (!payload.justification) {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: "justification string is required" }
      }, { state: currentState, seq_context: null });
    }
    if (getApprovalMode() === "human") {
      const grant = consumeOverrideGrant();
      if (!grant) {
        return buildResponseEnvelope({
          statusCode: 403,
          body: { message: "Override requires a grant from the human approver (out-of-band approver channel). Explain the hold via agreement_phase_message and wait, or abort." }
        }, { state: currentState, seq_context: null });
      }
      processedPayload = { ...payload, human_override: grant };
    }
  }
  else if (route === 'PATCH /bug/diagnose/implement-fix') {
    // Early 409 check for implement-fix when previous_attempt_failed=true and no prior capture
    const bugCaptureLogged = getBugCaptureLogged();
    if (payload.previous_attempt_failed === true && bugCaptureLogged === false) {
      const conflictScenarios = getConflictScenarios();
      const hint = conflictScenarios.get('implement_fix_without_capture');
      return buildResponseEnvelope({
        statusCode: 409,
        body: { resolution_hint: hint }
      }, { state: currentState, seq_context: null, instrumentationActive: false });
    }
    
    const normalized = normalizePayloadForRoute(route, payload);
    const vfix = validateDiagnosticPlanFix(normalized);
    if (!vfix.ok) {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: vfix.error }
      }, { state: currentState, seq_context: null, instrumentationActive: false });
    }
    processedPayload = normalized;
    // Stage 1 Agreement gate for diagnostic fix execution
    {
      const agreementId = payload?.agreement_id;
      if (!agreementId || typeof agreementId !== "string") {
        return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "Missing or invalid agreement_id. Submit the plan via agreement_submit, then agreement_approve, then include agreement_id in this payload." } }, { state: currentState, seq_context: null });
      }
      const rec = getAgreement(agreementId);
      if (!rec) return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "agreement_id was not found. Re-submit the plan with agreement_submit and include the returned id." } }, { state: currentState, seq_context: null });
      if (rec.status !== 'approved') return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: notApprovedHint() } }, { state: currentState, seq_context: null });
      if (rec.plan_type !== 'diagnostic') return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "Agreement type mismatch. Expected diagnostic for PATCH /bug/diagnose/implement-fix." } }, { state: currentState, seq_context: null });
      if (computePlanHash(processedPayload) !== rec.plan_hash) return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "Agreement-plan mismatch. The execution payload's plan must exactly match the approved agreement's plan." } }, { state: currentState, seq_context: null });
      if (!consumeAgreement(agreementId)) return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: CONSUMED_HINT } }, { state: currentState, seq_context: null });
      await logEvent("AGREEMENT_CONSUMED", { agreement_id: agreementId });
    }
  }
  else if (route === 'PATCH /gap/correct') {
    const normalized = normalizePayloadForRoute(route, payload);
    const v = validateCorrectionPlan(normalized);
    if (!v.ok) { 
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: v.error }
      }, { state: currentState, seq_context: null, instrumentationActive: false });
    }
    processedPayload = normalized;
    // Stage 1 Agreement gate for correction execution
    {
      const agreementId = payload?.agreement_id;
      if (!agreementId || typeof agreementId !== "string") {
        return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "Missing or invalid agreement_id. Submit the plan via agreement_submit, then agreement_approve, then include agreement_id in this payload." } }, { state: currentState, seq_context: null });
      }
      const rec = getAgreement(agreementId);
      if (!rec) return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "agreement_id was not found. Re-submit the plan with agreement_submit and include the returned id." } }, { state: currentState, seq_context: null });
      if (rec.status !== 'approved') return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: notApprovedHint() } }, { state: currentState, seq_context: null });
      if (rec.plan_type !== 'correction') return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "Agreement type mismatch. Expected correction for PATCH /gap/correct." } }, { state: currentState, seq_context: null });
      if (computePlanHash(processedPayload) !== rec.plan_hash) return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: "Agreement-plan mismatch. The execution payload's plan must exactly match the approved agreement's plan." } }, { state: currentState, seq_context: null });
      if (!consumeAgreement(agreementId)) return buildResponseEnvelope({ statusCode: 409, body: { resolution_hint: CONSUMED_HINT } }, { state: currentState, seq_context: null });
      await logEvent("AGREEMENT_CONSUMED", { agreement_id: agreementId });
    }
  }
  else if (route === 'POST /bug/capture-failure') {
    const v = validateKnowledgeCaptureRecord(payload);
    if (!v.ok) {
      return buildResponseEnvelope({
        statusCode: 400,
        body: { message: v.error }
      }, { state: currentState, seq_context: null, instrumentationActive: false });
    }
  }
  
  // Start transaction
  const permissionToTools = getPermissionToTools();
  const routeSpecificAllowed = Array.isArray((routeInfo as any).operational_tools_allowed)
    ? (routeInfo as any).operational_tools_allowed
    : null;
  const baseAllowed = permissionToTools.get(routeInfo.permission_class) || [];
  // Intersect with upstream available tools to avoid advertising tools not present upstream
  const upstreamNames = getAvailableToolNames();
  let filteredBase = baseAllowed.filter(t => upstreamNames.has(t));

  // Fallbacks when permission class has no explicit tools in protocol.yaml
  if (filteredBase.length === 0) {
    const prof = loadDomainProfile();
    if (routeInfo.permission_class === 'development') {
      // In development, allow all upstream tools if class list is empty
      filteredBase = [...upstreamNames];
    } else if (routeInfo.permission_class === 'investigation') {
      // In investigation, allow only profile-declared read-only tools (if any)
      const ro = (prof.investigation_read_only_tools || []).filter(t => upstreamNames.has(t));
      filteredBase = ro;
    }
  }

  let effectiveAllowed = (routeSpecificAllowed !== null)
    ? routeSpecificAllowed
    : filteredBase;

  // Step bindings: in development transactions only tools bound by the approved plan
  // (plus profile read-only tools) may run. No binding means read-only.
  let binding: { key: string; tools: Record<string, any> } | undefined;
  if (routeInfo.permission_class === 'development') {
    const seqNow = getSeqContext();
    if (route === 'PATCH /feature/implement/active' && seqNow) {
      const step = seqNow.plan.steps[seqNow.currentStepIndex - 1];
      if (step?.tools) binding = { key: `${seqNow.planHash}:${seqNow.currentStepIndex}`, tools: step.tools };
    } else if ((route === 'PATCH /bug/diagnose/implement-fix' || route === 'PATCH /gap/correct') && processedPayload?.tools) {
      binding = { key: `agreement:${payload.agreement_id}`, tools: processedPayload.tools };
    }
    const readOnly = new Set(loadDomainProfile().investigation_read_only_tools || []);
    effectiveAllowed = effectiveAllowed.filter((t: string) => readOnly.has(t) || (!!binding && t in binding.tools));
  }

  const txn = startTransaction({
    route,
    method: routeInfo.method,
    path: routeInfo.path,
    permission_class: routeInfo.permission_class,
    payload: processedPayload,
    allowedTools: effectiveAllowed,
    binding
  });
  
  // Build Start-Ack response
  const ack = {
    allowed_tools: effectiveAllowed,
    signals_required: signalsForRoute(route),
    payload_template: buildPayloadTemplate(route, seqContext)
  };

  await logRecord("txn_started", { txn_id: txn.txnId, route, permission_class: routeInfo.permission_class, ack });
  
  // Only log PLAN_APPROVED event_emitted for POST /feature/implement after logEvent
  if (route === 'POST /feature/implement') {
    await logRecord("event_emitted", { txn_id: txn.txnId, route, event: "PLAN_APPROVED" });
  }
  
  await env.logger.info("Transaction started", { txnId: txn.txnId, route, permission: routeInfo.permission_class, ack });

  return {
    content: [{
      type: "text",
      text: JSON.stringify(ack, null, 2)
    }]
  };
}
