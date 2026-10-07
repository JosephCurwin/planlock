/* eslint-disable @typescript-eslint/no-explicit-any */
/*
Module: External VM job packet builder + writer
Purpose:
- Build a canonical job_packet JSON for a Feature step based on the current transaction history.
- Write the job packet to EXTERNAL_VM_DIR/outbox/<txnId>.job.json for an external VM/test harness.
Notes:
- Asynchronous, non-blocking. The server does not wait for VM results in this implementation.
*/

import fs from "fs/promises";
import path from "path";
import { loadDomainProfile } from "../domain/profile.js";

function toOps(history: Array<{ tool_name: string; tool_input: any }>): any[] {
  const ops: any[] = [];
  for (const h of history) {
    const op = h.tool_name;
    const rec: any = { op };
    if (h.tool_input && typeof h.tool_input === "object") {
      Object.assign(rec, h.tool_input);
    }
    ops.push(rec);
  }
  return ops;
}

export function buildJobPacket(
  txn: any,
  seqContext: any,
  transactionHistory: Array<{ tool_name: string; tool_input: any }>,
  verification?: string[],
  extras?: { [k: string]: any }
): any {
  const prof = loadDomainProfile();
  const stepIndex = seqContext?.currentStepIndex || 0;
  const stepName = seqContext?.plan?.steps?.[stepIndex - 1]?.name || `step_${stepIndex}`;
  const packet = {
    job: {
      id: txn?.txnId || "unknown_txn",
      route: `${txn?.method} ${txn?.path}`,
      plan_hash: seqContext?.planHash || "",
      step_index: stepIndex,
      step_name: stepName,
      ops: toOps(transactionHistory),
      verification: Array.isArray(verification) ? verification : []
    },
    env: {
      material: process.env.VM_MATERIAL || "generic",
      thickness_mm: Number(process.env.VM_THICKNESS_MM || "0"),
      max_segment_length: Number(process.env.VM_MAX_SEGMENT_LEN || "0"),
      chaos_seed: Number(process.env.VM_CHAOS_SEED || "0"),
      ...(prof.job_packet?.env || {})
    },
    ...(extras || {})
  };
  return packet;
}

export async function writeJobPacket(baseDir: string, txnId: string, jobPacket: any): Promise<void> {
  const outbox = path.join(baseDir, "outbox");
  await fs.mkdir(outbox, { recursive: true });
  const filePath = path.join(outbox, `${txnId}.job.json`);
  await fs.writeFile(filePath, JSON.stringify(jobPacket, null, 2), "utf-8");
}
