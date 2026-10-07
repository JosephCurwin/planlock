/* eslint-disable @typescript-eslint/no-explicit-any */
/*
Module: Control tool 'action_commit' (Commit Gate)
Grounding:
- system prompt: Commit Gate, standardized response envelope
- protocol.yaml.audit, response_envelope, routes effects, events
Responsibilities:
- Close the current transaction, run protocol audit rules and external audit if required
- Apply route-specific effects (events, state transitions, flags)
- On FAILED: enter Hold and include next_actions and assistant_guidance from the current implementation
- On PASSED: apply per-route behavior (feature step increment, instrumentation flags, abort semantics, etc.)
- Always return standardized response envelope with X-Audit-Verdict header when audit runs
Public API (exports):
- descriptor for ListTools (name, description, inputSchema)
- function handleActionCommit(args, env): Promise<MCP content>
Consumes:
- src/state/index.ts (get/clear transaction, transitions)
- src/guardrails/index.ts (enforceProtocolAuditRules, runComplianceAudit)
- src/router/index.ts (buildResponseEnvelope)
- src/persistence/index.ts (logRecord, logEvent)
Notes:
- Keep special cases: DELETE /feature/implement/active idempotent PASSED; POST /action/active/acknowledge-audit-failure promotion; bug routes flags/events
*/

import { 
  getCurrentTransaction, 
  clearCurrentTransaction, 
  getTransactionHistory,
  getServerState,
  setServerState,
  getSeqContext,
  setSeqContext,
  abortSequentialContext,
  promoteAfterOverride,
  stepPassedAndMaybeComplete,
  enterHold,
  setBugCaptureLogged,
  getBugCaptureLogged,
  getStateSnapshot,
  getHoldSource
} from "../../state/index.js";
import { enforceProtocolAuditRules } from "../../guardrails/index.js";
import { hasSucceeded } from "../../guardrails/bindings.js";
import { buildResponseEnvelope, buildPayloadTemplate } from "../../router/index.js";
import { logRecord, logEvent } from "../../persistence/index.js";
import { FileLogger } from "../../logging/FileLogger.js";
import { getTestConfig, emitJobPacketIfFeatureContinuation, computeStepOverride, computeFinalVerificationIfNeeded } from "../../testing/index.js";

interface ToolEnv {
  logger: FileLogger;
}

export const descriptor = {
  name: "action_commit",
  description: `Finalize the active transaction and run the audit. Returns structured guidance for what to do next.
When to use: After you finish all operational tool calls for the current transaction.

How to handle the response:
- If FAILED:
  • Do not call operational tools.
  • Present the audit/conflict info the server returned.
  • Follow next_actions (typically acknowledge-audit-failure with justification, or abort).
  • STOP until instructed to proceed.

- If PASSED:
  • For Feature steps: copy announcement_template and step_verification verbatim when reporting status; STOP and wait for instruction to continue.
  • For Bug/Gap: follow any next_actions if present, or return to Agreement as instructed.

Edge case: If there is no active transaction, the server returns 400; call action_start to begin one.

Tiny example:
- After a start call and operational tools: call action_commit with {}. If the Feature step passed, report with the provided announcement_template and step_verification, then STOP.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
    description: "No parameters. Commits the current transaction established by action_start."
  }
};

export async function handleActionCommit(args: any, env: ToolEnv): Promise<any> {
  const txn = getCurrentTransaction();
  
  if (!txn) {
    // No active transaction; nothing to commit
    return buildResponseEnvelope({
      statusCode: 400,
      body: { message: "No active transaction to commit" }
    }, getStateSnapshot());
  }
  
  const routeKey = `${txn.method} ${txn.path}`;
  const txnHistory = getTransactionHistory();
  const currentState = getServerState();
  const seqContext = getSeqContext();
  const testCfg = getTestConfig();
  
  clearCurrentTransaction();
  
  // GET /action/help — return diagnostic snapshot and suggested next actions
  if (routeKey === 'GET /action/help') {
    const snapshot = getStateSnapshot();
    const state = getServerState();
    const seq = getSeqContext();
    const holdReason = getHoldSource();

    // Allowed routes now (from protocol gating)
    // We rely on protocol.yaml for gating; mirror the common next steps
    const nextActions: any[] = [];

    if (state === 'seq_active') {
      nextActions.push({
        route: 'PATCH /feature/implement/active',
        required_signals: ['continue'],
        payload_template: buildPayloadTemplate('PATCH /feature/implement/active', seq)
      });
    } else if (state === 'hold') {
      nextActions.push(
        {
          route: 'POST /action/active/acknowledge-audit-failure',
          required_signals: ['override'],
          payload_template: { justification: "", _signals: { override: "" } }
        },
        {
          route: 'POST /feature/implement/abort',
          required_signals: [],
          payload_template: {}
        }
      );
    } else if (state === 'idle') {
      // Offer common starting routes
      nextActions.push(
        {
          route: 'POST /feature/implement',
          required_signals: ['approval'],
          payload_template: buildPayloadTemplate('POST /feature/implement')
        },
        {
          route: 'GET /bug/diagnose',
          required_signals: [],
          payload_template: {}
        },
        {
          route: 'PATCH /gap/correct',
          required_signals: [],
          payload_template: buildPayloadTemplate('PATCH /gap/correct')
        }
      );
    }

    const body: any = {
      message: "Assistant diagnostic help",
      help: {
        state_snapshot: snapshot,
        active_plan_summary: seq
          ? {
              plan_hash: seq.planHash,
              objective: seq.plan?.objective,
              total_steps: seq.totalSteps,
              current_step_index: seq.currentStepIndex,
              awaiting_continue: !!seq.awaiting_continue
            }
          : null,
        hold_source: holdReason,
        next_actions: nextActions,
        resolution_hints: {
          start_new_plan_while_active: "Either supersede the active plan (set supersedes_active_plan:true with plan.justification_for_rewrite) or abort it via POST /feature/implement/abort.",
          feature_plan_hash_mismatch: "Your plan_hash does not match the server's. Use the plan_hash returned by the server or fetch via GET /action/help.",
          violate_route_permissions: "The attempted operation is not permitted in the current route/state.",
          implement_fix_without_capture: "Record the prior failed attempt first via POST /bug/capture-failure."
        }
      },
      next_actions: nextActions,
      assistant_guidance: {
        rationale: "Use the suggested next action for the current state. Copy the payload_template and include required_signals.",
        call_sequence: [{ tool: "action_commit", args: {} }],
        alternatives: []
      }
    };

    const envelope = buildResponseEnvelope({ statusCode: 200, verdict: 'PASSED', body }, getStateSnapshot());
    await logRecord("txn_committed", { txn_id: txn.txnId, route: txn.route, status_code: 200 });
    return envelope;
  }

  // DELETE /feature/implement/active (abort) - include PASSED verdict and audit_verdict record
  if (routeKey === 'POST /feature/implement/abort') {
    abortSequentialContext();
    
    await logRecord("abort", { txn_id: txn.txnId, route: txn.route });
    await logEvent("SEQUENTIAL_PLAN_ABORTED", { reason: "Explicit abort" });
    await logRecord("event_emitted", { txn_id: txn.txnId, route: txn.route, event: "SEQUENTIAL_PLAN_ABORTED" });
    await logRecord("audit_verdict", { txn_id: txn.txnId, route: txn.route, verdict: 'PASSED' });

    const envelope = buildResponseEnvelope({
      statusCode: 200,
      verdict: 'PASSED',
      body: { message: "Sequential plan aborted successfully" }
    }, getStateSnapshot());

    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 200
    });
    return envelope;
  }

  
  if (routeKey === 'POST /action/active/acknowledge-audit-failure') {
    promoteAfterOverride();
    
    if (seqContext) {
      await logEvent("FAILURE_OVERRIDDEN_AND_PROMOTED", {
        justification: txn.payload.justification,
        resolved_step_index: seqContext.currentStepIndex - 1,
        next_step_index: seqContext.currentStepIndex
      });
      await logRecord("event_emitted", { txn_id: txn.txnId, route: txn.route, event: "FAILURE_OVERRIDDEN_AND_PROMOTED" });
    }

    await logRecord("hold_resolved", { txn_id: txn.txnId, route: txn.route });
    await logRecord("audit_verdict", { txn_id: txn.txnId, route: txn.route, verdict: 'PASSED' });

    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 200
    });

    return buildResponseEnvelope({
      statusCode: 200,
      verdict: 'PASSED',
      body: { message: "Hold acknowledged and resolved" }
    }, getStateSnapshot());
  }
  
  if (routeKey === 'POST /bug/capture-failure') {
    setBugCaptureLogged(true);
    await logEvent("BUGFIX_ATTEMPT_LOGGED", {
      failed_approach: txn.payload.failed_approach,
      observed_failure: txn.payload.observed_failure
    });
    await logRecord("event_emitted", { txn_id: txn.txnId, route: txn.route, event: "BUGFIX_ATTEMPT_LOGGED" });
    await logRecord("audit_verdict", { txn_id: txn.txnId, route: txn.route, verdict: 'PASSED' });

    const envelope = buildResponseEnvelope({
      statusCode: 200,
      verdict: 'PASSED',
      body: { message: "Bug capture logged successfully" }
    }, getStateSnapshot());

    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 200
    });
    return envelope;
  }
  
  // Protocol audit rules (internal)
  const protocolAudit = enforceProtocolAuditRules(txn, {
    bugCaptureLogged: getBugCaptureLogged()
  });
  
  // Prepare VM job_packet for Feature step commits (asynchronous export; detached)
  let jobPacket: any = null;
  if (routeKey === 'PATCH /feature/implement/active' && seqContext) {
    try {
      const verification = seqContext.plan?.steps?.[seqContext.currentStepIndex - 1]?.verification;
      const { jobPacket: jp, wrote, outboxDir } = await emitJobPacketIfFeatureContinuation({ routeKey, txn, seqContext, txnHistory, verification, cfg: testCfg });
      if (jp) jobPacket = jp;
      if (wrote) await logRecord("external_job_emitted", { txn_id: txn.txnId, route: txn.route, outbox_dir: outboxDir });
    } catch (e: any) {
      // Non-fatal: if job emission fails, continue with internal audit behavior
      await logRecord("external_job_emit_error", { txn_id: txn.txnId, route: txn.route, error: String(e && e.message || e) });
    }
  }

  // Start with internal protocol verdict; may be overridden by test harness
  
  if (protocolAudit.conflictStatus === 409) {
    // Conflict caused by audit rule → treat as FAILED audit outcome
    await logRecord("audit_verdict", {
      txn_id: txn.txnId,
      route: txn.route,
      verdict: 'FAILED'
    });

    const envelope = buildResponseEnvelope({
      statusCode: 409,
      verdict: 'FAILED',
      body: { resolution_hint: protocolAudit.conflictHint }
    }, getStateSnapshot());

    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 409
    });

    return envelope;
  }

  let finalVerdict: 'PASSED' | 'FAILED' = protocolAudit.verdict;
  let auditReport = "";

  // Real outcome check: a step whose write call failed upstream does not pass.
  if (routeKey === 'PATCH /feature/implement/active' && finalVerdict === 'PASSED') {
    const history = getTransactionHistory();
    const failedCall = history.find(h => h.tool_output?.isError);
    const boundTools = Object.keys(txn.binding?.tools || {});
    const boundSucceeded = !!txn.binding && hasSucceeded(txn.binding.key);
    if (failedCall) {
      finalVerdict = 'FAILED';
      auditReport = `Upstream call ${failedCall.tool_name} failed during this step.`;
      await logRecord("upstream_failure", { txn_id: txn.txnId, route: txn.route, tool: failedCall.tool_name });
    } else if (boundTools.length > 0 && !boundSucceeded) {
      // A step that was approved to do something cannot pass without having done it.
      finalVerdict = 'FAILED';
      auditReport = `Step did not execute any of its approved tools (${boundTools.join(", ")}).`;
      await logRecord("step_not_executed", { txn_id: txn.txnId, route: txn.route });
    }
  }

  // Detached step override (hidden; no test-mode markers in response)
  if (routeKey === 'PATCH /feature/implement/active' && seqContext) {
    const override = computeStepOverride({ routeKey, seqContext, cfg: testCfg });
    if (override.overrideVerdict === 'FAILED') {
      finalVerdict = 'FAILED';
      auditReport = override.reason || "";
      await logRecord("external_job_result", { txn_id: txn.txnId, route: txn.route, verdict: 'FAILED', reason: auditReport });
    }
  }
  
  // Log audit verdict record
  await logRecord("audit_verdict", {
    txn_id: txn.txnId,
    route: txn.route,
    verdict: finalVerdict
  });
  
  // Handle FAILED verdict
  if (finalVerdict === 'FAILED') {
    // Prefer injected auditReport over internal reason
    const failureDetail = auditReport || protocolAudit.reason || "External audit failed";
    enterHold(routeKey, failureDetail);
    
    // Log hold entered record
    await logRecord("hold_entered", {
      txn_id: txn.txnId,
      route: txn.route,
      reason: failureDetail
    });
    
    // Only emit SEQUENTIAL_PLAN_ON_HOLD for sequential step failures
    if (routeKey === 'PATCH /feature/implement/active' && seqContext) {
      await logEvent("SEQUENTIAL_PLAN_ON_HOLD", {
        reason: failureDetail,
        step_index: seqContext.currentStepIndex,
        audit_report: failureDetail
      });
      
      await logRecord("event_emitted", {
        txn_id: txn.txnId,
        route: txn.route,
        event: "SEQUENTIAL_PLAN_ON_HOLD"
      });
    }
    
    // Build structured next actions and guidance on FAILED
    const next = [
      {
        route: "POST /action/active/acknowledge-audit-failure",
        required_signals: ["override"],
        payload_template: { justification: "", _signals: { override: "" } }
      },
      {
        route: "POST /feature/implement/abort",
        required_signals: [],
        payload_template: {}
      }
    ];

    const guidance = {
      rationale: "Audit failed; either override with justification or abort the sequential context.",
      call_sequence: [
        { tool: "action_start", args: { route: "POST /action/active/acknowledge-audit-failure", payload: { justification: "<brief-factual>", _signals: { override: "<text>" } } } },
        { tool: "action_commit", args: {} }
      ],
      alternatives: [
        { tool: "action_start", args: { route: "POST /feature/implement/abort", payload: {} } },
        { tool: "action_commit", args: {} }
      ]
    };

    const envelope = buildResponseEnvelope({
      statusCode: 403,
      verdict: 'FAILED',
      body: {
        message: "[AUDIT FAILED]",
        reason: failureDetail,
        audit_report: failureDetail,
        on_hold: true,
        job_packet: jobPacket || null,
        next_actions: next,
        assistant_guidance: guidance
      }
    }, getStateSnapshot());
    
    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 403
    });
    
    return envelope;
  }
  
  // Handle PASSED with route-specific effects
  if (routeKey === 'POST /feature/implement') {
    const body: any = {
      message: "Plan approved and established",
      seq_state: seqContext,
      plan_hash: seqContext?.planHash
    };
    body.next_actions = [{
      route: "PATCH /feature/implement/active",
      required_signals: ["continue"],
      payload_template: { plan: "$ACTIVE_PLAN", plan_hash: seqContext!.planHash, _signals: { continue: "" } }
    }];
    const envelope = buildResponseEnvelope({
      statusCode: 200,
      verdict: 'PASSED',
      body
    }, getStateSnapshot());

    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 200
    });
    return envelope;
  }
  
  if (routeKey === 'PATCH /feature/implement/active') {
    // Capture verification items from currently executing step before calling stepPassedAndMaybeComplete
    const prevSeq = getSeqContext();
    const verification = prevSeq?.plan.steps[prevSeq.currentStepIndex - 1].verification;
    
    const stepResult = stepPassedAndMaybeComplete();
    const implementedStep = stepResult.implementedStep;
    const stepName = stepResult.stepName;
    
    await logEvent("STEP_IMPLEMENTED", {
      step_index: implementedStep,
      step_name: stepName
    });
    
    await logRecord("event_emitted", {
      txn_id: txn.txnId,
      route: txn.route,
      event: "STEP_IMPLEMENTED"
    });
    
    if (stepResult.completed) {
      // Optional final QC discrepancy via test harness (hidden; no test-mode markers)
      const finalVerification = computeFinalVerificationIfNeeded({
        implementedStep,
        cfg: testCfg
      });

      const envelope = buildResponseEnvelope({
        statusCode: 200,
        verdict: 'PASSED',
        body: {
          message: "Final step complete. Plan finished.",
          event: "STEP_IMPLEMENTED",
          implemented_step: implementedStep,
          final: true,
          step_verification: verification,
          announcement_template: `Step ${implementedStep}: ${stepName} implemented.`,
          job_packet: jobPacket || null,
          final_verification: finalVerification,
          assistant_guidance: {
            rationale: "Plan finished; return to the Agreement Phase or await PE instructions.",
            call_sequence: []
          }
        }
      }, getStateSnapshot());
      
      await logRecord("txn_committed", {
        txn_id: txn.txnId,
        route: txn.route,
        status_code: 200
      });
      
      return envelope;
    } else {
      const announcement = `Step ${implementedStep}: ${stepName} implemented. Awaiting Continue Signal.`;
      const newSeqContext = getSeqContext();

      const body: any = {
        message: announcement,
        event: "STEP_IMPLEMENTED",
        implemented_step: implementedStep,
        awaiting_continue: true,
        step_verification: verification,
        announcement_template: announcement,
        job_packet: jobPacket || null,
        next_actions: [{
          route: "PATCH /feature/implement/active",
          required_signals: ["continue"],
          payload_template: { plan: "$ACTIVE_PLAN", plan_hash: newSeqContext!.planHash, _signals: { continue: "" } }
        }]
      };

      const envelope = buildResponseEnvelope({
        statusCode: 200,
        verdict: 'PASSED',
        body
      }, getStateSnapshot());
      
      await logRecord("txn_committed", {
        txn_id: txn.txnId,
        route: txn.route,
        status_code: 200
      });
      
      return envelope;
    }
  }
  
  if (routeKey === 'GET /bug/diagnose') {
    const envelope = buildResponseEnvelope({
      statusCode: 200,
      verdict: 'PASSED',
      body: { message: "Read-only investigation completed" }
    }, getStateSnapshot());
    
    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 200
    });
    
    return envelope;
  }
  
  // gather-evidence route removed in derived protocol
  
  if (routeKey === 'PATCH /bug/diagnose/implement-fix') {
    // Clear only bugCaptureLogged as per derived protocol
    setBugCaptureLogged(false);

    const envelope = buildResponseEnvelope({
      statusCode: 200,
      verdict: 'PASSED',
      body: {
        message: "Bug fix implemented"
      }
    }, getStateSnapshot());
    
    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 200
    });
    
    return envelope;
  }
  
  if (routeKey === 'PATCH /gap/correct') {
    await logEvent("CORRECTION_PLAN_APPROVED", { plan: txn.payload });
    
    await logRecord("event_emitted", {
      txn_id: txn.txnId,
      route: txn.route,
      event: "CORRECTION_PLAN_APPROVED"
    });
    
    const envelope = buildResponseEnvelope({
      statusCode: 200,
      verdict: 'PASSED',
      body: { message: "Correction applied successfully" }
    }, getStateSnapshot());
    
    await logRecord("txn_committed", {
      txn_id: txn.txnId,
      route: txn.route,
      status_code: 200
    });
    
    return envelope;
  }
  
  // Default success
  const envelope = buildResponseEnvelope({
    statusCode: 200,
    verdict: 'PASSED',
    body: { message: "Transaction committed successfully" }
  }, getStateSnapshot());
  
  await logRecord("txn_committed", {
    txn_id: txn.txnId,
    route: txn.route,
    status_code: 200
  });
  
  return envelope;
}
