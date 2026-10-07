/*
Module: Protocol loader and registries
Grounding:
- protocol.yaml: routes, permission_classes, audit.rules, events, conflict_handling, response_envelope, state_model
Responsibilities:
- Resolve PROTOCOL_PATH and load YAML
- Build and export registries/maps:
  - protocolDoc (raw parsed YAML)
  - routeRegistry (key: "METHOD /path" → Route)
  - permissionToTools (permission_class → [tool names])
  - auditRules (array from audit.rules)
  - eventSchemas (event.id → payload_schema)
  - conflictScenarios (scenario.id → resolution_hint)
Public API (exports):
- types: ProtocolDocument, Route, AuditRule (as in existing code)
- function loadProtocolYaml(logger): Promise<void>
- getters for registries (or exported consts initialized after load)
Consumes:
- src/logging/FileLogger.ts
- yaml, fs, path, url utilities
Notes:
- No server state or audit logic here; read-only interpreter of YAML
*/

import fs from "fs/promises";
import fsSync from "fs";
import yaml from "js-yaml";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { FileLogger } from "../logging/FileLogger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ProtocolDocument {
  protocol: any;
  transaction_model: any;
  mcp_binding: any;
  tools_catalog: any;
  permission_classes: any;
  signals: any;
  response_envelope: any;
  audit: any;
  state_model: any;
  events: any[];
  routes: any[];
  schemas: any;
  conflict_handling: any;
  logging: any;
}

export interface Route {
  id: string;
  method: string;
  path: string;
  permission_class: 'investigation' | 'development' | 'control';
  operational_tools_allowed?: string[];
  request_schema?: any;
  preconditions?: any;
  effects?: any;
}

export interface AuditRule {
  id: string;
  when: any;
  require?: any;
  require_if?: any;
  verdict?: 'PASSED' | 'FAILED';
  hold?: boolean;
  reason?: string;
  conflict_on_fail?: any;
}

let protocolDoc: ProtocolDocument;
let routeRegistry: Map<string, Route> = new Map();
let permissionToTools: Map<string, string[]> = new Map();
let auditRules: AuditRule[] = [];
let eventSchemas: Map<string, any> = new Map();
let conflictScenarios: Map<string, string> = new Map();

function resolveProtocolPath(): string {
  const envPath = process.env.PROTOCOL_PATH;
  if (envPath && fsSync.existsSync(envPath)) return envPath;
  const candidates = [
    // project root
    path.join(process.cwd(), "protocol.yaml"),
    path.join(process.cwd(), "protocol.yml"),
    // common src locations
    path.join(process.cwd(), "src", "protocol.yaml"),
    path.join(process.cwd(), "src", "protocol.yml"),
    // relative to server location
    path.join(__dirname, "..", "protocol.yaml"),
    path.join(__dirname, "..", "protocol.yml"),
    path.join(__dirname, "..", "src", "protocol.yaml"),
    path.join(__dirname, "..", "src", "protocol.yml"),
    path.join(__dirname, "..", "..", "protocol.yaml"),
    path.join(__dirname, "..", "..", "protocol.yml"),
    path.join(__dirname, "..", "..", "src", "protocol.yaml"),
    path.join(__dirname, "..", "..", "src", "protocol.yml"),
  ];
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p;
  }
  throw new Error("protocol.yaml not found; set PROTOCOL_PATH or place it at project root.");
}

export async function loadProtocolYaml(logger: FileLogger): Promise<void> {
  try {
    const protocolPath = resolveProtocolPath();
    const yamlContent = await fs.readFile(protocolPath, "utf-8");
    protocolDoc = yaml.load(yamlContent) as ProtocolDocument;
    
    await logger.info("Protocol.yaml loaded", {
      version: protocolDoc.protocol.version,
      routes_count: protocolDoc.routes.length
    });
    
    // Build route registry from protocol
    for (const route of protocolDoc.routes) {
      const key = `${route.method} ${route.path}`;
      routeRegistry.set(key, route);
    }
    
    // Build permission to tools mapping from protocol
    for (const [className, config] of Object.entries(protocolDoc.permission_classes)) {
      permissionToTools.set(className, (config as any).allowed_tools || []);
    }
    
    // Extract audit rules from protocol
    auditRules = protocolDoc.audit.rules || [];
    
    // Build event schemas from protocol
    for (const event of protocolDoc.events) {
      eventSchemas.set(event.id, event.payload_schema);
    }
    
    // Build conflict resolution hints from protocol
    for (const scenario of protocolDoc.conflict_handling.scenarios) {
      conflictScenarios.set(scenario.id, scenario.resolution_hint);
    }
    
  } catch (error) {
    await logger.error("Failed to load protocol.yaml", { error });
    throw new Error("Could not initialize from protocol.yaml");
  }
}

// Getters for registries
export function getProtocolDoc(): ProtocolDocument {
  return protocolDoc;
}

export function getRouteRegistry(): Map<string, Route> {
  return routeRegistry;
}

export function getPermissionToTools(): Map<string, string[]> {
  return permissionToTools;
}

export function getAuditRules(): AuditRule[] {
  return auditRules;
}

export function getEventSchemas(): Map<string, any> {
  return eventSchemas;
}

export function getConflictScenarios(): Map<string, string> {
  return conflictScenarios;
}
