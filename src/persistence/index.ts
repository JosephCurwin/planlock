/*
Module: Durable records and rehydration
Grounding:
- protocol.yaml.logging (required_records, format)
- protocol.yaml.state_model.rehydration_invariant
Responsibilities:
- Append JSONL records: tool_call, txn_started, audit_verdict, txn_committed, permission_denied, event_emitted, hold_entered, hold_resolved, abort
- Emit canonical events to session_events.log (one JSON object per line)
- Rehydrate server state on startup by replaying events (PLAN_APPROVED, STEP_IMPLEMENTED, etc.) via state/index.ts helpers
Public API (exports):
- function logRecord(type, data)
- function logEvent(eventName, payload)
- function rehydrateServerStateFromLog(logger): Promise<void>
Consumes:
- src/state/index.ts (to apply transitions during rehydration)
- fs for append/read
Notes:
- Do not implement business decisions here; only record/replay
*/

import fs from "fs/promises";
import { appendFileSync } from "fs";
import path from "path";
import { FileLogger } from "../logging/FileLogger.js";
import * as state from "../state/index.js";
// Explicit imports used in rehydration for agreements
import {
  rehydrateAgreementSubmitted,
  rehydrateAgreementApproved
} from "../state/index.js";

let projectRootDirectory: string = "";

export function setProjectRootDirectory(dir: string): void {
  projectRootDirectory = dir;
}

export async function logRecord(type: string, data: any): Promise<void> {
  const logFilePath = path.join(projectRootDirectory, "session_events.log");
  const entry = {
    timestamp: new Date().toISOString(),
    record_type: type,
    ...data
  };
  
  try {
    await fs.appendFile(logFilePath, JSON.stringify(entry) + "\n");
  } catch (error) {
    appendFileSync(logFilePath, JSON.stringify(entry) + "\n");
  }
}

export async function logEvent(eventName: string, payload: any): Promise<void> {
  const logFilePath = path.join(projectRootDirectory, "session_events.log");
  const logEntry = {
    timestamp: new Date().toISOString(),
    event_name: eventName,
    event_payload: payload
  };
  
  try {
    await fs.appendFile(logFilePath, JSON.stringify(logEntry) + "\n");
  } catch (error) {
    appendFileSync(logFilePath, JSON.stringify(logEntry) + "\n");
  }
}

export async function rehydrateServerStateFromLog(logger: FileLogger): Promise<void> {
  const DEV_MODE = process.env.DEV_MODE === "true";
  
  if (DEV_MODE) {
    console.error("State rehydration disabled in DEV_MODE.");
    return;
  }

  const logFilePath = path.join(projectRootDirectory, "session_events.log");
  try {
    await fs.access(logFilePath);
  } catch (error) {
    await logger.info("No session_events.log found. Starting fresh.");
    return;
  }

  console.error("Rehydrating from session_events.log...");
  
  const fileContent = await fs.readFile(logFilePath, "utf-8");
  const logEntries = fileContent
    .trim()
    .split("\n")
    .filter(line => line.length > 0)
    .map((line) => JSON.parse(line));

  for (const entry of logEntries) {
    switch (entry.event_name) {
      case "AGREEMENT_SUBMITTED": {
        const p = entry.event_payload || {};
        try {
          rehydrateAgreementSubmitted({
            agreement_id: p.agreement_id,
            plan_type: p.plan_type,
            plan_hash: p.plan_hash,
            createdAt: entry.timestamp
          });
        } catch {}
        break;
      }
      case "AGREEMENT_APPROVED": {
        const p = entry.event_payload || {};
        try {
          rehydrateAgreementApproved({
            agreement_id: p.agreement_id,
            plan_type: p.plan_type,
            plan_hash: p.plan_hash,
            approvedAt: entry.timestamp
          });
        } catch {}
        break;
      }
      case "AGREEMENT_CONSUMED": {
        try { state.consumeAgreement(entry.event_payload?.agreement_id); } catch {}
        break;
      }
      case "PLAN_APPROVED":
        const plan = entry.event_payload.plan;
        state.establishPlan(plan);
        break;
        
      case "STEP_IMPLEMENTED":
        state.stepPassedAndMaybeComplete();
        break;
        
      case "SEQUENTIAL_PLAN_ABORTED":
        state.abortSequentialContext();
        break;
        
      case "SEQUENTIAL_PLAN_ON_HOLD":
        state.enterHold("sequential_step", entry.event_payload.reason);
        break;
        
      case "FAILURE_OVERRIDDEN_AND_PROMOTED":
        state.promoteAfterOverride();
        break;
        
      case "BUGFIX_ATTEMPT_LOGGED":
        state.setBugCaptureLogged(true);
        break;
    }
  }
  
  console.error(`Rehydration complete. State: ${state.getServerState()}`);
}
