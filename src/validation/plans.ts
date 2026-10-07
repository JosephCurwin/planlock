/*
Module: Payload validators (strict schema checks)
Grounding:
- protocol.yaml.schemas (ExecutableSpecification, Step, DiagnosticPlan[Logging|Fix], CorrectionPlan, KnowledgeCaptureRecord)
Responsibilities:
- Validate Feature ExecutableSpecification
- Validate DiagnosticPlanLogging and DiagnosticPlanFix
- Validate CorrectionPlan
- Validate KnowledgeCaptureRecord
Public API (exports):
- validateExecutableSpecification(plan)
- validateDiagnosticPlanLogging(payload)
- validateDiagnosticPlanFix(payload)
- validateCorrectionPlan(payload)
- validateKnowledgeCaptureRecord(payload)
Consumes: none
Notes:
- Return { ok: boolean, error?: string } shapes identical to current behavior
*/

import { validateBinding } from "../guardrails/bindings.js";

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateExecutableSpecification(plan: any): ValidationResult {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 1) {
    return { ok: false, error: "steps[] array is required and must have at least 1 item" };
  }
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const idx = i + 1;
    if (!step || typeof step !== "object") {
      return { ok: false, error: `Step ${idx}: must be an object` };
    }
    if (!step.name || typeof step.name !== "string" || step.name.trim().length < 1) {
      return { ok: false, error: `Step ${idx}: name is required` };
    }
    if (!step.description || typeof step.description !== "string" || step.description.trim().length < 1) {
      return { ok: false, error: `Step ${idx}: description is required` };
    }
    // verification: array minItems: 1, strings
    if (!Array.isArray(step.verification) || step.verification.length < 1 || !step.verification.every((v: any) => typeof v === "string" && v.trim().length > 0)) {
      return { ok: false, error: `Step ${idx}: verification must be a non-empty array of strings` };
    }
    const bindingError = validateBinding(step.tools, `Step ${idx}`);
    if (bindingError) return { ok: false, error: bindingError };
  }
  return { ok: true };
}

export function validateDiagnosticPlanFix(p: any): ValidationResult {
  if (!p || p.path !== "implement_fix") {
    return { ok: false, error: "DiagnosticPlanFix.path must be 'implement_fix'" };
  }
  if (typeof p.previous_attempt_failed !== "undefined" && typeof p.previous_attempt_failed !== "boolean") {
    return { ok: false, error: "previous_attempt_failed must be boolean if provided" };
  }
  const bindingError = validateBinding(p.tools, "DiagnosticPlanFix");
  if (bindingError) return { ok: false, error: bindingError };
  return { ok: true };
}

export function validateCorrectionPlan(p: any): ValidationResult {
  if (!p || typeof p.root_cause !== "string" || p.root_cause.trim().length < 1) {
    return { ok: false, error: "root_cause is required" };
  }
  if (!Array.isArray(p.modification_plan) || p.modification_plan.length < 1) {
    return { ok: false, error: "modification_plan must have at least 1 item" };
  }
  for (let i = 0; i < p.modification_plan.length; i++) {
    const it = p.modification_plan[i];
    if (!it || typeof it.change !== "string") {
      return { ok: false, error: `modification_plan[${i}] must include change string` };
    }
  }
  if (typeof p.cleanup !== "undefined" && (!Array.isArray(p.cleanup) || !p.cleanup.every((x: any) => typeof x === "string"))) {
    return { ok: false, error: "cleanup must be an array of strings if provided" };
  }
  const bindingError = validateBinding(p.tools, "CorrectionPlan");
  if (bindingError) return { ok: false, error: bindingError };
  return { ok: true };
}

export function validateKnowledgeCaptureRecord(p: any): ValidationResult {
  if (!p || typeof p.failed_approach !== "string" || p.failed_approach.trim().length < 1) {
    return { ok: false, error: "failed_approach is required" };
  }
  if (typeof p.observed_failure !== "string" || p.observed_failure.trim().length < 1) {
    return { ok: false, error: "observed_failure is required" };
  }
  return { ok: true };
}
