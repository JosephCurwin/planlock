/*
Module: All tools aggregator and dispatcher
Grounding:
- Combines control tools and operational tools into unified interface
- protocol.yaml.mcp_binding.control_tools and tools_catalog
Responsibilities:
- Export getAllToolDescriptors(): concatenates control and operational tool descriptors
- Export dispatchToolCall(name, args, env): routes to appropriate tool handler
Public API (exports):
- function getAllToolDescriptors(): ToolDescriptor[]
- function dispatchToolCall(name, args, env): Promise<MCP content>
Consumes:
- src/tools/router/index.ts (control tools)
- src/tools/task-specific/index.ts (operational tools)
Notes:
- Provides single entry point for MCP server tool handling
- Control tools take precedence in dispatch order
- Uses standardized error handling for unknown tools
*/

import { getControlToolDescriptors, handleControlToolCall } from "./router/index.js";
import { getActionHelpDescriptor, handleActionHelp } from "./utility/action_help.js";
import { getAgreementToolDescriptors, handleAgreementToolCall } from "./agreement/index.js";
import { buildResponseEnvelope } from "../router/index.js";
import { getStateSnapshot } from "../state/index.js";
import { getProxiedOperationalToolDescriptors, handleProxiedOperationalToolCall } from "./proxy/index.js";
import * as Upstream from "../upstream/index.js";

export function getAllToolDescriptors() {
  return [
    ...getControlToolDescriptors(),
    // Agreement tools (Stage 1 code-first)
    ...getAgreementToolDescriptors(),
    // Utility (read-only)
    getActionHelpDescriptor(),
    // Operational (domain-specific)
    ...getProxiedOperationalToolDescriptors()
  ];
}

export async function dispatchToolCall(name: string, args: any, env: any): Promise<any> {
  // Check utility tools first
  if (name === "actionHelp") {
    return handleActionHelp(args, env);
  }
  // Agreement tools
  const agreementTools = ["agreement_phase_message", "agreement_submit", "agreement_approve"];
  if (agreementTools.includes(name)) {
    return handleAgreementToolCall(name, args, env);
  }

  // Check control tools first
  const controlToolNames = ["action_start", "action_commit"];
  if (controlToolNames.includes(name)) {
    return handleControlToolCall(name, args, env);
  }
  
  // Operational tools proxied upstream (only if upstream exposes them)
  if (Upstream.getAvailableToolNames().has(name)) {
    return handleProxiedOperationalToolCall(name, args, env);
  }
  
  // Unknown tool
  return buildResponseEnvelope({
    statusCode: 400,
    body: { message: `Unknown tool: ${name}` }
  }, getStateSnapshot());
}
