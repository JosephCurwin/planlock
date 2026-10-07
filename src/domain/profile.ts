import fs from "fs";
import { FileLogger } from "../logging/FileLogger.js";

export type DomainProfile = {
  name: string;
  examples?: {
    help_description?: string;
    action_start_use_cases?: string[];
  };
  investigation_read_only_tools?: string[];
  write_tools?: string[];
  testing?: {
    step_fail_reason_template?: string;         
    final_qc_discrepancy_template?: string;     
  };
  job_packet?: {
    env?: Record<string, string | number>;
  };
};

let cached: DomainProfile | null = null;

export function loadDomainProfile(): DomainProfile {
  if (cached) return cached;

  // 1) Highest priority: inline JSON via env (DOMAIN_PROFILE_JSON)
  const jsonEnv = process.env.DOMAIN_PROFILE_JSON;
  if (jsonEnv && jsonEnv.trim().length > 0) {
    try {
      cached = JSON.parse(jsonEnv) as DomainProfile;
      return cached!;
    } catch (e) {
      // fallthrough to PATH or neutral default
      try {
        const logger = new FileLogger(`${process.cwd()}/mcp-judge-debug.log`);
        logger.error("DOMAIN_PROFILE_JSON parse failed", { error: String(e) });
      } catch {}
    }
  }

  // 2) Next: load JSON from a file path (DOMAIN_PROFILE_PATH)
  const profilePath = process.env.DOMAIN_PROFILE_PATH;
  if (profilePath) {
    try {
      const raw = fs.readFileSync(profilePath, "utf-8");
      cached = JSON.parse(raw) as DomainProfile;
      return cached!;
    } catch (e) {
      try {
        const logger = new FileLogger(`${process.cwd()}/mcp-judge-debug.log`);
        logger.error("DOMAIN_PROFILE_PATH load failed", { path: profilePath, error: String(e) });
      } catch {}
      // fallthrough to neutral default
    }
  }

  // 3) Neutral fallback: no domain-specific defaults embedded in code
  cached = {
    name: "default",
    examples: {
      help_description:
        "Diagnostic self-help (read-only). Returns the current execution state (idle|seq_active|hold), active plan summary (plan_hash, objective, steps), and copyable next_actions with required_signals and payload_template.",
      action_start_use_cases: [
        "POST /feature/implement — Establish a two-step plan. Include _signals.approval:\"PLAN APPROVED\" and an approved agreement_id.",
        "PATCH /feature/implement/active — Execute the next step with plan:'$ACTIVE_PLAN' + plan_hash and include a Continue signal."
      ]
    },
    investigation_read_only_tools: [],
    write_tools: [],
    testing: {
      step_fail_reason_template: "Policy check failed at step {step_index}.",
      final_qc_discrepancy_template: "Final QA mismatch detected at step {step_index}."
    },
    job_packet: { env: {} }
  };
  return cached!;
}