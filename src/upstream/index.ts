/* eslint-disable @typescript-eslint/no-explicit-any */
/*
Module: Upstream Business MCP manager (child stdio client; version-tolerant)
Responsibilities:
- Spawn the Business MCP server as a child process (Windows-first).
- Connect an MCP client over stdio and discover tool descriptors.
- Provide callTool(name,args,timeout) with a simple timeout.
- Expose getAvailableToolDescriptors() and getAvailableToolNames().
Notes:
- Guardrail remains the source of truth for permissions; upstream is stateless.
*/

import { spawn, ChildProcess } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FileLogger } from "../logging/FileLogger.js";
import type { Readable, Writable } from "stream";

type ToolDescriptor = { name: string; description?: string; inputSchema?: any };

let child: ChildProcess | null = null;
let client: Client | null = null;
let descriptors: ToolDescriptor[] = [];
let toolNames: Set<string> = new Set();
let inited = false;

// Version-tolerant transport factory:
// Different @modelcontextprotocol/sdk versions use different ctor signatures for StdioClientTransport.
// To compile and run across these, we try common signatures with 'any' casts.
function makeStdioClientTransport(input: Readable, output: Writable): any {
  const Ctor: any = StdioClientTransport as any;
  try {
    // Some versions: new StdioClientTransport({ input, output })
    return new Ctor({ input, output });
  } catch {
    try {
      // Others: new StdioClientTransport(input, output)
      return new Ctor(input, output);
    } catch {
      try {
        // Fallback: parameterless (unlikely to work for child stdio, but keeps TS happy in edge cases)
        return new Ctor();
      } catch (e) {
        throw e;
      }
    }
  }
}

// Small helper to ensure a number
function toMs(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function listTools(): Promise<ToolDescriptor[]> {
  if (!client) return [];
  const res: any = await client.listTools();
  const tools = Array.isArray(res?.tools) ? res.tools : [];
  return tools as ToolDescriptor[];
}

export async function initFromEnv(logger: FileLogger): Promise<void> {
  if (inited) return;
  
  console.error("Upstream: Starting initialization...");
  
  const cmd = process.env.UPSTREAM_COMMAND || "node";
  const argsJson = process.env.UPSTREAM_ARGS_JSON || "[]";
  let args: string[] = [];
  try {
    const parsed = JSON.parse(argsJson);
    if (Array.isArray(parsed)) {
      args = parsed.map(String);
    }
  } catch (e) {
    await logger.error("Invalid UPSTREAM_ARGS_JSON; expected JSON array of args", { argsJson });
    throw e;
  }

  console.error(`Upstream: Spawning ${cmd} with args:`, args);

  // Filter out undefined values from process.env
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never hand the approver secret to the business server.
    if (value !== undefined && key !== "APPROVER_TOKEN") {
      env[key] = value;
    }
  }

  // UPSTREAM_URL selects a remote Streamable HTTP upstream (e.g. Windmill's MCP endpoint);
  // otherwise the upstream is spawned as a stdio child process.
  const upstreamUrl = process.env.UPSTREAM_URL;
  const transport: any = upstreamUrl
    ? new StreamableHTTPClientTransport(new URL(upstreamUrl))
    : new StdioClientTransport({ command: cmd, args: args, env: env });
  if (upstreamUrl) console.error(`Upstream: Using Streamable HTTP at ${new URL(upstreamUrl).origin}`);

  // Create and connect client with timeout
  client = new Client(
    { name: "planlock", version: "1.0.0" }, 
    { capabilities: {} }
  );
  
  console.error("Upstream: Connecting to transport...");
  
  // Add a timeout wrapper
  const connectWithTimeout = async (timeoutMs: number = 10000) => {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Connection timeout")), timeoutMs)
    );
    try {
      await Promise.race([
        client!.connect(transport),
        timeoutPromise
      ]);
    } catch (e) {
      console.error("Upstream: Connection failed:", e);
      throw e;
    }
  };
  
  try {
    await connectWithTimeout();
    console.error("Upstream: Connected successfully");
  } catch (e) {
    await logger.error("Failed to connect to upstream", { error: String(e) });
    throw e;
  }

  // Discover tools
  console.error("Upstream: Discovering tools...");
  try {
    descriptors = await listTools();
    toolNames = new Set(descriptors.map(t => t.name));
    inited = true;

    console.error(`Upstream: Found ${descriptors.length} tools`);
    await logger.info("Upstream connected", {
      command: cmd, 
      args,
      tool_count: descriptors.length,
      tools: descriptors.map(d => d.name)
    });
  } catch (e) {
    console.error("Upstream: Tool discovery failed:", e);
    await logger.error("Failed to list upstream tools", { error: String(e) });
    throw e;
  }
}




export function getAvailableToolDescriptors(): ToolDescriptor[] {
  return descriptors;
}

export function getAvailableToolNames(): Set<string> {
  return toolNames;
}

export async function callTool(name: string, args: any, timeoutMs?: number): Promise<any> {
  if (!client) throw new Error("Upstream not connected");
  const to = toMs(timeoutMs ?? process.env.UPSTREAM_TOOL_TIMEOUT_MS, 30000);
  const p = (client as any).callTool({ name, arguments: args }) as Promise<any>;
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error("Upstream tool timeout")), to));
  return await Promise.race([p, timer]) as any;
}
