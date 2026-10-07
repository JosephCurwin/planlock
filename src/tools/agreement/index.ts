/* eslint-disable @typescript-eslint/no-explicit-any */
/*
Module: Agreement tools (Stage 1 code-first)
Purpose:
 - Eliminate free-text channel by providing a no-op, auditable message tool.
 - Turn Agreement Phase into a tools-only, two-step transaction: submit → approve.
 - Returns agreement_id that must be referenced at action_start to begin execution.
Grounding:
 - task_instruction: "force all communication into a formal, tools-only transaction model"
 - proposal: agreement_phase_message, agreement_submit, agreement_approve
Best practices: enums, descriptions, clear parameter docs.
*/

import { FileLogger } from "../../logging/FileLogger.js";
import { logRecord, logEvent } from "../../persistence/index.js";
import {
  submitAgreement,
  approveAgreement,
  getAgreement,
  AgreementPlanType
} from "../../state/index.js";
import { normalizePayloadForRoute } from "../../router/index.js";
import { getApprovalMode } from "../../approval/index.js";
import { validateExecutableSpecification } from "../../validation/plans.js";

interface ToolEnv {
  logger: FileLogger;
}

export function getAgreementToolDescriptors() {
  const all = getAllAgreementToolDescriptors();
  // In human mode the model never sees an approval tool.
  return getApprovalMode() === "human" ? all.filter(t => t.name !== "agreement_approve") : all;
}

function getAllAgreementToolDescriptors() {
  return [
    {
      name: "agreement_phase_message",
      description: "Auditable, no-op communication channel. Use for human-facing messages, clarifying questions, or summaries during Agreement Phase. This tool has no operational effect.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string", description: "Human-readable message to present to the user." },
          context: { type: "string", description: "Optional short tag for categorization (e.g., 'clarification', 'summary').", nullable: true }
        }
      }
    },
    {
      name: "agreement_submit",
      description: "Submit a plan for server-side storage and review; receive a server-issued agreement_id. The plan is immutable and will be checked against execution requests.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["plan_type", "plan"],
        properties: {
          plan_type: {
            type: "string",
            enum: ["feature_executable", "diagnostic", "correction"],
            description: "Type of plan to submit."
          },
          plan: {
            type: "object",
            description: "The plan object. For feature_executable, include objective, strategic_summary, steps[...]. For diagnostic/correction, include fields consistent with DiagnosticPlanFix/CorrectionPlan minimal shapes."
          }
        }
      }
    },
    {
      name: "agreement_approve",
      description: [
        "Record that the specific agreement was approved by the human. Returns status=approved. Idempotent when already approved.",
        "",
        "Next-step requirement (Feature plans): Immediately begin the Action Phase after approval.",
        "Two valid patterns:",
        "1) Chain-in-one-turn: agreement_approve → action_start (POST /feature/implement with plan, agreement_id, and _signals.approval: \"PLAN APPROVED\") → action_commit.",
        "2) Multi-turn: after approval succeeds, proceed with action_start and then action_commit when you receive your next assistant turn.",
        "",
        "Plan sealing: Do not modify the plan contents between approval and establishment; the execution payload's plan must exactly match the approved plan or it will be rejected."
      ].join(" "),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agreement_id"],
        properties: {
          agreement_id: { type: "string", description: "The identifier returned from agreement_submit." },
          approval_proof: { type: "string", description: "Optional deployment-specific proof of approval.", nullable: true }
        }
      }
    }
  ];
}

export async function handleAgreementToolCall(name: string, args: any, env: ToolEnv): Promise<any> {
  switch (name) {
    case "agreement_phase_message": {
      const message = typeof args?.message === "string" ? args.message : "";
      const context = typeof args?.context === "string" ? args.context : undefined;
      const msgId = `comm_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      await env.logger.info("Agreement message", { msgId, context, message });
      await logRecord("tool_call", { tool: "agreement_phase_message", msgId, context });
      const response = { message_id: msgId, acknowledged: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    }

    case "agreement_submit": {
      const planType = args?.plan_type as AgreementPlanType;
      const plan = args?.plan;
      if (!planType || !["feature_executable", "diagnostic", "correction"].includes(planType)) {
        const err = { error: "plan_type must be one of feature_executable | diagnostic | correction" };
        return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }] };
      }
      if (!plan || typeof plan !== "object") {
        const err = { error: "plan must be an object" };
        return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }] };
      }

      if (planType === "feature_executable") {
        const v = validateExecutableSpecification(plan);
        if (!v.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid plan: ${v.error}` }, null, 2) }] };
        }
      }

      // Normalize the plan for non-feature types so hashes match what action_start will validate later
      let normalizedPlan = plan;
      if (planType === "diagnostic") {
        // Use the same normalization path as action_start → PATCH /bug/diagnose/implement-fix
        normalizedPlan = normalizePayloadForRoute("PATCH /bug/diagnose/implement-fix", plan);
      } else if (planType === "correction") {
        // Use the same normalization path as action_start → PATCH /gap/correct
        normalizedPlan = normalizePayloadForRoute("PATCH /gap/correct", plan);
      }

      const rec = submitAgreement(planType, normalizedPlan);
      await logRecord("tool_call", { tool: "agreement_submit", agreement_id: rec.id, plan_type: planType });
      await logEvent("AGREEMENT_SUBMITTED", {
        agreement_id: rec.id,
        plan_type: planType,
        plan_hash: rec.plan_hash
      });

      const response: any = {
        agreement_id: rec.id,
        status: rec.status,
        plan_hash: rec.plan_hash
      };
      if (getApprovalMode() === "human") {
        response.next = "Awaiting human approval through the approver channel. Present the plan and plan_hash to the user via agreement_phase_message; you cannot approve it yourself.";
      }
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    }

    case "agreement_approve": {
      if (getApprovalMode() === "human") {
        await logRecord("permission_denied", { tool: "agreement_approve", reason: "human approval mode" });
        const err = { error: "agreement_approve is not available: approval is human-only in this deployment." };
        return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }], isError: true };
      }
      const agreementId = String(args?.agreement_id || "");
      const approvalProof = typeof args?.approval_proof === "string" ? args.approval_proof : null;
      if (!agreementId) {
        const err = { error: "agreement_id is required" };
        return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }] };
      }
      const rec = getAgreement(agreementId);
      if (!rec) {
        const err = { error: "agreement not found" };
        return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }] };
      }

      const result = approveAgreement(agreementId, approvalProof);
      await logRecord("tool_call", { tool: "agreement_approve", agreement_id: agreementId, idempotent: !!result.alreadyApproved });
      await logEvent("AGREEMENT_APPROVED", {
        agreement_id: agreementId,
        plan_type: rec.plan_type,
        plan_hash: rec.plan_hash,
        approval_proof: approvalProof || undefined
      });

      const response = {
        agreement_id: agreementId,
        status: "approved",
        plan_hash: rec.plan_hash
      };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    }
  }
  const err = { error: `Unknown agreement tool: ${name}` };
  return { content: [{ type: "text", text: JSON.stringify(err, null, 2) }] };
}
