/*
Tool: actionHelp (read-only, out-of-transaction)
Purpose:
- Provide an immediate diagnostic snapshot and copyable next actions to unstick the assistant.
- Safe in all states; no parameters.
Output:
- JSON text with { help: { state_snapshot, active_plan_summary?, hold_source?, next_actions[], resolution_hints{} }, assistant_guidance{} }
Notes:
- Mirrors the GET /action/help route behavior without requiring action_start/action_commit.
*/

import { getStateSnapshot, getServerState, getSeqContext, getHoldSource } from "../../state/index.js";
import { buildPayloadTemplate } from "../../router/index.js";
import { FileLogger } from "../../logging/FileLogger.js";
import { loadDomainProfile } from "../../domain/profile.js";

interface ToolEnv {
  logger: FileLogger;
}

export function getActionHelpDescriptor() {
  const prof = loadDomainProfile();
  const desc = prof.examples?.help_description
    ? prof.examples.help_description
    : "Diagnostic self-help (read-only). Returns the current execution state (idle|seq_active|hold), active plan summary (plan_hash, objective, steps), and copyable next_actions with required_signals and payload_template. Use whenever you are uncertain, encounter 400/409, or see 'plan is still active'. Zero parameters.";
  return {
    name: "actionHelp",
    description: desc,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  };
}

export async function handleActionHelp(args: any, env: ToolEnv): Promise<any> {
  // No transaction required; pure read-only
  const snapshot = getStateSnapshot();
  const state = getServerState();
  const seq = getSeqContext();
  const holdSource = getHoldSource();

  const nextActions: any[] = [];

  if (state === "seq_active") {
    nextActions.push({
      route: "PATCH /feature/implement/active",
      required_signals: ["continue"],
      payload_template: buildPayloadTemplate("PATCH /feature/implement/active", seq)
    });
  } else if (state === "hold") {
    nextActions.push(
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
    );
  } else if (state === "idle") {
    nextActions.push(
      {
        route: "POST /feature/implement",
        required_signals: ["approval"],
        payload_template: buildPayloadTemplate("POST /feature/implement")
      },
      {
        route: "GET /bug/diagnose",
        required_signals: [],
        payload_template: {}
      },
      {
        route: "PATCH /gap/correct",
        required_signals: [],
        payload_template: buildPayloadTemplate("PATCH /gap/correct")
      }
    );
  }

  const response = {
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
      hold_source: holdSource,
      next_actions: nextActions,
      resolution_hints: {
        start_new_plan_while_active:
          "Either supersede the active plan (set supersedes_active_plan:true with plan.justification_for_rewrite) or abort it via POST /feature/implement/abort.",
        feature_plan_hash_mismatch:
          "Your plan_hash does not match the server's. Use the plan_hash returned by the server or fetch via GET /action/help or actionHelp tool.",
        violate_route_permissions:
          "The attempted operation is not permitted in the current route/state.",
        implement_fix_without_capture:
          "Record the prior failed attempt first via POST /bug/capture-failure."
      }
    },
    assistant_guidance: {
      rationale:
        "Use the suggested next action for the current state. Copy the payload_template and include required_signals.",
      call_sequence: [],
      alternatives: []
    }
  };

  const text = JSON.stringify(response, null, 2);
  await env.logger.info("actionHelp returned", { state });
  return { content: [{ type: "text", text }] };
}
