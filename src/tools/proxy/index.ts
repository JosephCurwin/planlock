/* eslint-disable @typescript-eslint/no-explicit-any */
/*
Module: Proxied operational tools (Business MCP upstream)
Responsibilities:
- Re-expose upstream Business tool descriptors 1:1.
- Enforce Guardrail transaction/permission discipline before proxying.
- Record tool_call in transaction history for Commit Gate and job_packets.
- Normalize upstream failures to standardized envelopes (no verbatim errors).
*/

import { getCurrentTransaction, recordToolCall, getStateSnapshot } from "../../state/index.js";
import { buildResponseEnvelope } from "../../router/index.js";
import { logRecord } from "../../persistence/index.js";
import { getConflictScenarios } from "../../protocol/index.js";
import * as Upstream from "../../upstream/index.js";
import { FileLogger } from "../../logging/FileLogger.js";
import { loadDomainProfile } from "../../domain/profile.js";
import { checkArgs, reserveCall, readResultField, markSucceeded } from "../../guardrails/bindings.js";

interface ToolEnv {
  logger: FileLogger;
}

export function getProxiedOperationalToolDescriptors() {
  // Re-expose upstream descriptors 1:1 to the client
  return Upstream.getAvailableToolDescriptors();
}

export async function handleProxiedOperationalToolCall(name: string, args: any, env: ToolEnv): Promise<any> {
  const txn = getCurrentTransaction();
  if (!txn) {
    return buildResponseEnvelope({
      statusCode: 400,
      body: { message: "No active transaction. Call action_start first." }
    }, getStateSnapshot());
  }
  
  if (!txn.routeAllowedTools?.includes(name)) {
    const hint = getConflictScenarios().get('violate_route_permissions');
    await logRecord("permission_denied", {
      txn_id: txn.txnId,
      route: txn.route,
      tool: name,
      allowed_tools_source: txn.routeAllowedTools ? "route" : "permission_class"
    });
    return buildResponseEnvelope({
      statusCode: 409,
      body: {
        message: `Blocked: ${name} is not allowed in the current step. Allowed now: ${(txn.routeAllowedTools || []).join(", ") || "none"}.`,
        resolution_hint: hint
      }
    }, getStateSnapshot());
  }

  const binding = txn.binding;
  if (binding && name in binding.tools) {
    const spec = binding.tools[name];
    const violation = checkArgs(name, spec, args) || reserveCall(binding.key, name, spec);
    if (violation) {
      await logRecord("binding_violation", { txn_id: txn.txnId, route: txn.route, tool: name, violation });
      return buildResponseEnvelope({
        statusCode: 403,
        body: { message: `Blocked by approved plan: ${violation}`, resolution_hint: "The call was not executed. Only calls within the approved plan's limits can run; a different call needs a new plan approved by the human." }
      }, getStateSnapshot());
    }
    if (spec.pin) {
      // The guardrail (not the agent) verifies the upstream still matches what was approved.
      let actual: any;
      const readOnly = loadDomainProfile().investigation_read_only_tools || [];
      if (!readOnly.includes(spec.pin.tool)) {
        actual = undefined; // never let a pin trigger a non-read-only tool
      } else try {
        const pinResult = await Upstream.callTool(spec.pin.tool, spec.pin.args || {}, 30000);
        actual = readResultField(pinResult, spec.pin.field);
      } catch { actual = undefined; }
      if (JSON.stringify(actual) !== JSON.stringify(spec.pin.eq)) {
        await logRecord("binding_violation", { txn_id: txn.txnId, route: txn.route, tool: name, violation: "pin_mismatch", expected: spec.pin.eq, actual });
        recordToolCall(name, args || {}, { content: [{ type: "text", text: "pin mismatch" }], isError: true });
        return buildResponseEnvelope({
          statusCode: 409,
          body: { message: `Blocked by approved plan: ${spec.pin.tool} ${spec.pin.field} is ${JSON.stringify(actual)}, approved ${JSON.stringify(spec.pin.eq)}. The upstream changed since approval.`, resolution_hint: "The call was not executed. A new plan with the current version must be approved by the human." }
        }, getStateSnapshot());
      }
    }
  }

  try {
    const timeoutMs = Number(process.env.UPSTREAM_TOOL_TIMEOUT_MS || "30000");
    const result = await Upstream.callTool(name, args, timeoutMs);
    recordToolCall(name, args || {}, result);
    if (binding && name in binding.tools && !(result as any)?.isError) markSucceeded(binding.key);
    await logRecord("tool_call", { txn_id: txn.txnId, route: txn.route, tool: name });
    return result;
  } catch (e: any) {
    const msg = String(e?.message || e);
    recordToolCall(name, args || {}, { content: [{ type: "text", text: "Upstream tool error" }], isError: true });
    await logRecord("tool_call_error", { txn_id: txn.txnId, route: txn.route, tool: name, error: msg });
    return buildResponseEnvelope({
      statusCode: 500,
      body: { message: "Upstream tool error" }
    }, getStateSnapshot());
  }
}
