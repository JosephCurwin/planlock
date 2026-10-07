/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path";
import { buildJobPacket, writeJobPacket } from "../../external/vm.js";
import { TestAdapter, TestConfig } from "../adapter.js";
import { loadDomainProfile } from "../../domain/profile.js";

export const EnvInjectAdapter: TestAdapter = {
  async emitJobPacket(params) {
    const { routeKey, txn, seqContext, txnHistory, verification, cfg } = params;
    if (routeKey !== "PATCH /feature/implement/active" || !seqContext) {
      return { jobPacket: null, wrote: false, outboxDir: null };
    }
    const jobPacket = buildJobPacket(txn, seqContext, txnHistory, verification);
    await writeJobPacket(cfg.externalVmDir, txn.txnId, jobPacket);
    return { jobPacket, wrote: true, outboxDir: cfg.externalVmDir };
  },

  computeStepOverride({ routeKey, seqContext, cfg }) {
    if (routeKey !== "PATCH /feature/implement/active" || !seqContext) return {};
    const stepIndex = seqContext?.currentStepIndex || 0;
    const targeted = typeof cfg.testStep === "number" ? cfg.testStep === stepIndex : true;
    if (cfg.mode === "MAKE_STEP_FAIL" && targeted) {
      const prof = loadDomainProfile();
      const tpl = prof.testing?.step_fail_reason_template || "Policy check failed at step {step_index}.";
      const reason = tpl.replace("{step_index}", String(stepIndex));
      return { overrideVerdict: "FAILED", reason };
    }
    return {};
  },

  computeFinalVerification({ implementedStep, cfg }) {
    if (cfg.mode === "MAKE_FINAL_QC_MISMATCH") {
      const prof = loadDomainProfile();
      const tpl =
        prof.testing?.final_qc_discrepancy_template ||
        "Final QA mismatch detected at step {step_index}.";
      const msg = tpl.replace("{step_index}", String(implementedStep));
      return {
        status: "FAILED",
        discrepancies: [msg]
      };
    }
    return undefined;
  }
};
