/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path";
import { TestAdapter, TestConfig } from "./adapter.js";
import { EnvInjectAdapter } from "./adapters/env_inject.js";

export function getTestConfig(): TestConfig {
  const mode = String(process.env.TEST_MODE || "OFF").toUpperCase() as TestConfig["mode"];
  const stepStr = process.env.TEST_STEP;
  const testStep = stepStr ? parseInt(stepStr, 10) : undefined;
  const externalVmDir = process.env.EXTERNAL_VM_DIR || path.join(process.cwd(), "vm_io");
  return { mode, testStep, externalVmDir };
}

function selectAdapter(): TestAdapter {
  // Placeholder for future: ENV TEST_ADAPTER to pick different adapters
  // For now we always return the env-based injection adapter
  return EnvInjectAdapter;
}

export async function emitJobPacketIfFeatureContinuation(params: {
  routeKey: string;
  txn: any;
  seqContext: any;
  txnHistory: Array<{ tool_name: string; tool_input: any }>;
  verification?: string[];
  cfg: TestConfig;
}): Promise<{ jobPacket: any | null; wrote: boolean; outboxDir: string | null }> {
  const adapter = selectAdapter();
  if (!adapter.emitJobPacket) return { jobPacket: null, wrote: false, outboxDir: null };
  return adapter.emitJobPacket(params);
}

export function computeStepOverride(params: {
  routeKey: string;
  seqContext: any;
  cfg: TestConfig;
}): { overrideVerdict?: "PASSED" | "FAILED"; reason?: string } {
  const adapter = selectAdapter();
  return adapter.computeStepOverride ? adapter.computeStepOverride(params) : {};
}

export function computeFinalVerificationIfNeeded(params: {
  implementedStep: number;
  cfg: TestConfig;
}): { status: "FAILED"; discrepancies: string[] } | undefined {
  const adapter = selectAdapter();
  return adapter.computeFinalVerification ? adapter.computeFinalVerification(params) : undefined;
}
