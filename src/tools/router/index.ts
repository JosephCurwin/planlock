/*
Module: Control tools aggregator
Grounding:
- Aggregates control tool descriptors from action_start and action_commit
- Provides dispatcher for control tool calls
Responsibilities:
- Export getControlToolDescriptors(): returns descriptors from action_start and action_commit
- Export handleControlToolCall(name, args, env): dispatches to appropriate control tool handler
Public API (exports):
- function getControlToolDescriptors(): ToolDescriptor[]
- function handleControlToolCall(name, args, env): Promise<MCP content>
Consumes: src/tools/router/action_start.ts, src/tools/router/action_commit.ts
Notes:
- Provides clean interface for control tools without exposing implementation details
*/

import { descriptor as actionStartDescriptor, handleActionStart } from "./action_start.js";
import { descriptor as actionCommitDescriptor, handleActionCommit } from "./action_commit.js";

export function getControlToolDescriptors() {
  return [
    actionStartDescriptor,
    actionCommitDescriptor
  ];
}

export async function handleControlToolCall(name: string, args: any, env: any): Promise<any> {
  switch (name) {
    case "action_start":
      return handleActionStart(args, env);
    case "action_commit":
      return handleActionCommit(args, env);
    default:
      throw new Error(`Unknown control tool: ${name}`);
  }
}
