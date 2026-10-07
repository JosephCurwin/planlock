/*
Module: Step bindings (pre-call enforcement of the approved plan)
Purpose:
 - The plan hash proves the plan text is unchanged; bindings make the plan control behavior.
 - A binding is part of the approved (hashed) plan:
     "tools": {
       "reserveFunds": { "max_calls": 1, "args": { "amount": { "max": 50 }, "recipient": { "enum": ["r1","r2"] } } }
     }
 - Feature plans declare it per step (steps[i].tools); bug/gap payloads at top level (payload.tools).
 - Enforced in the proxy BEFORE the upstream call. Without a binding, only read-only tools are allowed.
 - Optional "pin": before the call, the guardrail itself calls a read tool on the upstream and
   requires a field of its result to equal the approved value, e.g. a Windmill script hash:
     "pin": { "tool": "getScriptByPath", "args": { "path": "f/support/refund" }, "field": "hash", "eq": "89a6..." }
   so a script changed after approval is not executed.
 - Strict: a bound tool may only receive the arguments its binding declares. An argument that may
   take any value must be declared explicitly with { "any": true }.
Constraint ops: eq, enum, min, max, max_length, any. Unknown ops are rejected at validation so the
server never silently ignores a limit a human approved.
*/

const ARG_OPS = new Set(["eq", "enum", "min", "max", "max_length", "any"]);
const TOOL_KEYS = new Set(["max_calls", "args", "pin"]);

export function validateBinding(tools: any, where: string): string | null {
  if (tools === undefined) return null;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return `${where}: tools must be an object keyed by tool name`;
  for (const [toolName, spec] of Object.entries<any>(tools)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return `${where}: tools.${toolName} must be an object`;
    for (const k of Object.keys(spec)) {
      if (!TOOL_KEYS.has(k)) return `${where}: tools.${toolName}.${k} is not a supported key (max_calls, args, pin)`;
    }
    if (spec.max_calls !== undefined && !(Number.isInteger(spec.max_calls) && spec.max_calls >= 1)) {
      return `${where}: tools.${toolName}.max_calls must be a positive integer`;
    }
    if (spec.pin !== undefined) {
      const p = spec.pin;
      if (!p || typeof p !== "object" || typeof p.tool !== "string" || typeof p.field !== "string" || p.eq === undefined
          || (p.args !== undefined && (typeof p.args !== "object" || Array.isArray(p.args)))
          || Object.keys(p).some(k => !["tool", "args", "field", "eq"].includes(k))) {
        return `${where}: tools.${toolName}.pin must be { tool, args?, field, eq }`;
      }
    }
    if (spec.args !== undefined) {
      if (!spec.args || typeof spec.args !== "object" || Array.isArray(spec.args)) return `${where}: tools.${toolName}.args must be an object`;
      for (const [argName, c] of Object.entries<any>(spec.args)) {
        if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length === 0) {
          return `${where}: tools.${toolName}.args.${argName} must be a non-empty constraint object`;
        }
        for (const op of Object.keys(c)) {
          if (!ARG_OPS.has(op)) return `${where}: tools.${toolName}.args.${argName}.${op} is not a supported constraint (${[...ARG_OPS].join(", ")})`;
        }
        if (c.any !== undefined && (c.any !== true || Object.keys(c).length !== 1)) {
          return `${where}: tools.${toolName}.args.${argName}.any must be true and the only key`;
        }
        if (c.enum !== undefined && !Array.isArray(c.enum)) return `${where}: tools.${toolName}.args.${argName}.enum must be an array`;
        for (const op of ["min", "max", "max_length"]) {
          if (c[op] !== undefined && typeof c[op] !== "number") return `${where}: tools.${toolName}.args.${argName}.${op} must be a number`;
        }
      }
    }
  }
  return null;
}

function sameValue(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function checkArgs(toolName: string, spec: any, args: any): string | null {
  const constraints = spec?.args || {};
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    return `${toolName} arguments must be an object`;
  }
  for (const key of Object.keys(args || {})) {
    if (!Object.prototype.hasOwnProperty.call(constraints, key)) {
      return `${toolName}.${key} is not declared in the approved plan`;
    }
  }
  for (const [argName, c] of Object.entries<any>(constraints)) {
    if (c.any === true) continue;
    const v = args?.[argName];
    if (v === undefined) return `${toolName}.${argName} is constrained by the approved plan but was not provided`;
    if (c.eq !== undefined && !sameValue(v, c.eq)) return `${toolName}.${argName} must equal the approved value`;
    if (c.enum !== undefined && !c.enum.some((e: any) => sameValue(v, e))) return `${toolName}.${argName} is not one of the approved values`;
    if (c.min !== undefined || c.max !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v)) return `${toolName}.${argName} must be a finite number`;
      if (c.min !== undefined && v < c.min) return `${toolName}.${argName} is below the approved minimum`;
      if (c.max !== undefined && v > c.max) return `${toolName}.${argName} exceeds the approved maximum`;
    }
    if (c.max_length !== undefined) {
      if (typeof v !== "string" && !Array.isArray(v)) return `${toolName}.${argName} must be a string or array`;
      if (v.length > c.max_length) return `${toolName}.${argName} exceeds the approved max_length`;
    }
  }
  return null;
}

// Call counts per binding key; kept outside the transaction so restarting a
// transaction for the same step does not reset the budget.
const callCounts = new Map<string, number>();

export function reserveCall(bindingKey: string, toolName: string, spec: any): string | null {
  const max = spec?.max_calls ?? 1;
  const k = `${bindingKey}::${toolName}`;
  const used = callCounts.get(k) || 0;
  if (used >= max) return `${toolName} already called ${used} time(s); the approved plan allows ${max} for this step`;
  callCounts.set(k, used + 1);
  return null;
}

// Bound calls that executed successfully, per binding key (approved step).
const succeeded = new Set<string>();

export function markSucceeded(bindingKey: string): void {
  succeeded.add(bindingKey);
}

export function hasSucceeded(bindingKey: string): boolean {
  return succeeded.has(bindingKey);
}

// Reads a dot-separated field from the first JSON text block of an MCP tool result.
export function readResultField(result: any, field: string): any {
  if (result?.isError) return undefined;
  const text = result?.content?.find((c: any) => c?.type === "text")?.text;
  let value: any;
  try { value = JSON.parse(text); } catch { return undefined; }
  for (const part of field.split(".")) {
    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
