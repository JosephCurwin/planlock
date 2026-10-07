/*
Module: Server state store and transaction lifecycle
Grounding:
- protocol.yaml.state_model (states, flags, allowed_routes_by_state, rehydration_invariant)
- protocol.yaml.events (canonical event names)
+ - Stage 1 code-first: Agreement Registry and gating (tools-only Agreement flow)
Responsibilities:
- Hold and mutate server state:
  - state: 'idle' | 'seq_active' | 'hold'
  - seqContext: { plan, planHash, currentStepIndex, totalSteps, awaiting_continue }
  - flags: instrumentationActive, bugCaptureLogged, holdSource
- Transaction model:
  - currentTransaction and transactionHistory
  - helpers to start/record/complete transactions
- Transition helpers for router/commit paths (establishPlan, stepPassed, enterHold, resolveHold, abortPlan, resetFlagsAfterFix, getStateSnapshot)
Public API (exports):
- getters/setters for state and flags
- Agreement Registry (Stage 1):
  - submitAgreement(plan_type, plan) -> AgreementRecord
  - approveAgreement(agreementId, approval_proof?)
  - getAgreement(agreementId), setActiveAgreementForPlan(agreementId), getActiveAgreementId()
- functions:
  - computePlanHash(plan)
  - getStateSnapshot()
  - startTransaction({route, method, path, permission_class, payload, allowedTools}): txn
  - recordToolCall(name, args, toolResult)
  - getCurrentTransaction(), clearCurrentTransaction()
  - establishPlan(plan, directive, plan_type)
  - promoteAfterOverride()
  - stepPassedAndMaybeComplete()
  - enterHold(source, reason)
  - abortSequentialContext()
  - resetFlagsAfterFix()
  - setBugCaptureLogged(bool), setInstrumentationActive(bool)
Consumes: crypto (for plan hash)
Notes:
- This file owns all state mutations. Other modules must call these helpers, not mutate globals
*/

import crypto from "crypto";
import { clearOverrideGrant } from "../approval/index.js";

export type State = 'idle' | 'seq_active' | 'hold';

export type AgreementPlanType = 'feature_executable' | 'diagnostic' | 'correction';

export interface AgreementRecord {
  id: string;
  plan_type: AgreementPlanType;
  plan: any;
  plan_hash: string;
  status: 'submitted' | 'approved';
  createdAt: string;
  approvedAt?: string;
  // An approved agreement authorizes exactly one execution; replays are rejected.
  consumedAt?: string;
}

export interface SequentialContext {
  plan: any;  // ExecutableSpecification from protocol
  planHash: string;
  currentStepIndex: number;
  totalSteps: number;
  awaiting_continue: boolean;
}

export interface Transaction {
  route: string;
  method: string;
  path: string;
  permission_class: 'investigation' | 'development' | 'control';
  payload: any;
  usedTools: string[];
  routeAllowedTools?: string[];
  // Tool/argument limits from the approved plan step (or bug/gap payload) for this transaction.
  binding?: { key: string; tools: Record<string, any> };
  startTime: number;
  txnId: string;
}

// State variables
let serverState: State = 'idle';
let seqContext: SequentialContext | null = null;
let bugCaptureLogged = false;
let holdSource: string | null = null;
// Agreements (Stage 1)
const agreements: Map<string, AgreementRecord> = new Map();
let activeAgreementId: string | null = null;

// Transaction variables
let currentTransaction: Transaction | null = null;
let transactionHistory: Array<{
  tool_name: string;
  tool_input: object;
  tool_output: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}> = [];

// Utility functions
function stableStringify(obj: any): string {
  // Deep, recursive key sort to avoid false hash mismatches from different key orders
  const seen = new WeakSet();
  const sorter = (value: any): any => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return value; // guard cycles (should not occur here)
    seen.add(value);
    if (Array.isArray(value)) return value.map(sorter);
    const keys = Object.keys(value).sort();
    const out: any = {};
    for (const k of keys) {
      out[k] = sorter(value[k]);
    }
    return out;
  };
  return JSON.stringify(sorter(obj));
}

// Hash utility (used also by Agreement plan equality checks)

export function computePlanHash(plan: any): string {
  return crypto.createHash("sha256").update(stableStringify(plan)).digest("hex");
}

// State getters and setters
export function getServerState(): State {
  return serverState;
}

export function setServerState(newState: State): void {
  serverState = newState;
}

export function getSeqContext(): SequentialContext | null {
  return seqContext;
}

export function setSeqContext(context: SequentialContext | null): void {
  seqContext = context;
}

export function getBugCaptureLogged(): boolean {
  return bugCaptureLogged;
}

export function setBugCaptureLogged(value: boolean): void {
  bugCaptureLogged = value;
}

export function getHoldSource(): string | null {
  return holdSource;
}

export function setHoldSource(source: string | null): void {
  holdSource = source;
}

// State snapshot for responses
export function getStateSnapshot() {
  return {
    state: serverState,
    seq_context: seqContext ? {
      current_step_index: seqContext.currentStepIndex,
      total_steps: seqContext.totalSteps,
      awaiting_continue: !!seqContext.awaiting_continue
    } : null
  };
}

// Transaction management
export function startTransaction(params: {
  route: string;
  method: string;
  path: string;
  permission_class: 'investigation' | 'development' | 'control';
  payload: any;
  allowedTools: string[];
  binding?: { key: string; tools: Record<string, any> };
}): Transaction {
  currentTransaction = {
    route: params.route,
    method: params.method,
    path: params.path,
    permission_class: params.permission_class,
    payload: params.payload,
    usedTools: [],
    routeAllowedTools: params.allowedTools,
    binding: params.binding,
    startTime: Date.now(),
    txnId: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  
  transactionHistory = [];
  return currentTransaction;
}

export function recordToolCall(name: string, args: object, toolResult: any): void {
  if (currentTransaction) {
    currentTransaction.usedTools.push(name);
    transactionHistory.push({
      tool_name: name,
      tool_input: args,
      tool_output: toolResult
    });
  }
}

export function getCurrentTransaction(): Transaction | null {
  return currentTransaction;
}

export function clearCurrentTransaction(): void {
  currentTransaction = null;
  transactionHistory = [];
}

export function getTransactionHistory(): typeof transactionHistory {
  return transactionHistory;
}

// State transition helpers
export function establishPlan(plan: any, directive?: string, plan_type?: string): void {
  seqContext = {
    plan: plan,
    planHash: computePlanHash(plan),
    currentStepIndex: 1,
    totalSteps: plan.steps.length,
    awaiting_continue: false
  };
  serverState = 'seq_active';
}

export function promoteAfterOverride(): void {
  if (seqContext) {
    seqContext.currentStepIndex++;
    if (seqContext.currentStepIndex > seqContext.totalSteps) {
      serverState = 'idle';
      seqContext = null;
    } else {
      serverState = 'seq_active';
      seqContext.awaiting_continue = true;
    }
  } else {
    serverState = 'idle';
  }
  holdSource = null;
}

export function stepPassedAndMaybeComplete(): { completed: boolean; implementedStep: number; stepName?: string } {
  if (!seqContext) {
    return { completed: false, implementedStep: 0 };
  }
  
  const implementedStep = seqContext.currentStepIndex;
  const stepName = seqContext.plan.steps[implementedStep - 1].name;
  seqContext.currentStepIndex++;
  
  if (seqContext.currentStepIndex > seqContext.totalSteps) {
    serverState = 'idle';
    const completed = true;
    seqContext = null;
    return { completed, implementedStep, stepName };
  } else {
    seqContext.awaiting_continue = true;
    return { completed: false, implementedStep, stepName };
  }
}

export function enterHold(source: string, reason: string): void {
  // A grant issued for an earlier Hold must not clear this one.
  clearOverrideGrant();
  serverState = 'hold';
  holdSource = source;
}

export function abortSequentialContext(): void {
  clearOverrideGrant();
  serverState = 'idle';
  seqContext = null;
}

// ============ Agreement Registry (Stage 1 code-first) ============
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function submitAgreement(plan_type: AgreementPlanType, plan: any): AgreementRecord {
  const id = genId("agr");
  const rec: AgreementRecord = {
    id,
    plan_type,
    plan,
    plan_hash: computePlanHash(plan),
    status: 'submitted',
    createdAt: new Date().toISOString()
  };
  agreements.set(id, rec);
  return rec;
}

export function approveAgreement(agreementId: string, _approvalProof?: string | null): { ok: boolean; alreadyApproved?: boolean } {
  const rec = agreements.get(agreementId);
  if (!rec) return { ok: false };
  if (rec.status === 'approved') return { ok: true, alreadyApproved: true };
  rec.status = 'approved';
  rec.approvedAt = new Date().toISOString();
  agreements.set(agreementId, rec);
  return { ok: true };
}

export function consumeAgreement(agreementId: string): boolean {
  const rec = agreements.get(agreementId);
  if (!rec || rec.consumedAt) return false;
  rec.consumedAt = new Date().toISOString();
  return true;
}

export function listAgreements(): AgreementRecord[] {
  return [...agreements.values()];
}

export function getAgreement(agreementId: string): AgreementRecord | undefined {
  return agreements.get(agreementId);
}

export function setActiveAgreementForPlan(agreementId: string): void {
  activeAgreementId = agreementId;
}

export function getActiveAgreementId(): string | null {
  return activeAgreementId;
}

// Rehydration helpers for Agreement Registry (used by persistence.rehydrate)
export function rehydrateAgreementSubmitted(params: {
  agreement_id: string;
  plan_type: AgreementPlanType;
  plan_hash: string;
  createdAt?: string;
}): void {
  const { agreement_id, plan_type, plan_hash, createdAt } = params;
  // Create minimal record; plan content is not required at runtime checks,
  // only plan_hash is compared during action_start.
  const rec: AgreementRecord = {
    id: agreement_id,
    plan_type,
    plan: null,
    plan_hash,
    status: 'submitted',
    createdAt: createdAt || new Date().toISOString()
  };
  agreements.set(agreement_id, rec);
}

export function rehydrateAgreementApproved(params: {
  agreement_id: string;
  plan_type: AgreementPlanType;
  plan_hash: string;
  approvedAt?: string;
}): void {
  const { agreement_id, plan_type, plan_hash, approvedAt } = params;
  const existing = agreements.get(agreement_id);
  if (existing) {
    existing.status = 'approved';
    existing.approvedAt = approvedAt || new Date().toISOString();
    agreements.set(agreement_id, existing);
  } else {
    const rec: AgreementRecord = {
      id: agreement_id, plan_type, plan: null, plan_hash,
      status: 'approved', createdAt: approvedAt || new Date().toISOString(), approvedAt
    };
    agreements.set(agreement_id, rec);
  }
}


