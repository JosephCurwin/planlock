/*
Module: Approver channel (human-only, out-of-band)
Responsibilities:
- Separate HTTP listener on 127.0.0.1:ADMIN_PORT, never reachable through MCP.
- Bearer APPROVER_TOKEN required; without a token the channel is disabled and nothing
  can be approved (fail closed).
Endpoints:
- GET  /admin/agreements                      -> submitted plans (full plan + plan_hash) for review
- POST /admin/approve  { agreement_id, plan_hash } -> approve; plan_hash must match what the human reviewed
- POST /admin/override { justification }      -> one-time grant to resolve the current Hold
*/

import http from "http";
import crypto from "crypto";
import { listAgreements, getAgreement, approveAgreement, getServerState } from "./state/index.js";
import { logEvent } from "./persistence/index.js";
import { grantOverride } from "./approval/index.js";
import { FileLogger } from "./logging/FileLogger.js";

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
  });
}

function send(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body, null, 2));
}

export function startAdminServer(logger: FileLogger, token: string | undefined, port: number) {
  if (!token) {
    console.error("APPROVER_TOKEN not set: approver channel disabled; no plan can be approved.");
    return;
  }
  const server = http.createServer(async (req, res) => {
    if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && req.url === "/admin/agreements") {
      return send(res, 200, listAgreements().map(a => ({
        agreement_id: a.id, plan_type: a.plan_type, status: a.status,
        consumed: !!a.consumedAt, plan_hash: a.plan_hash, plan: a.plan
      })));
    }

    if (req.method === "POST" && req.url === "/admin/approve") {
      const body = await readJson(req);
      const rec = body?.agreement_id ? getAgreement(String(body.agreement_id)) : undefined;
      if (!rec) return send(res, 404, { error: "agreement not found" });
      if (body.plan_hash !== rec.plan_hash) return send(res, 409, { error: "plan_hash does not match the submitted plan; review the current plan first" });
      approveAgreement(rec.id, "human");
      await logEvent("AGREEMENT_APPROVED", { agreement_id: rec.id, plan_type: rec.plan_type, plan_hash: rec.plan_hash, approved_by: "human" });
      await logger.info("Agreement approved by human", { agreement_id: rec.id });
      return send(res, 200, { agreement_id: rec.id, status: "approved", plan_hash: rec.plan_hash });
    }

    if (req.method === "POST" && req.url === "/admin/override") {
      const body = await readJson(req);
      if (getServerState() !== "hold") return send(res, 409, { error: "not in hold" });
      if (!body?.justification || typeof body.justification !== "string") return send(res, 400, { error: "justification required" });
      grantOverride(body.justification);
      await logEvent("OVERRIDE_GRANTED", { justification: body.justification, granted_by: "human" });
      return send(res, 200, { granted: true });
    }

    send(res, 404, { error: "not found" });
  });
  const host = process.env.ADMIN_HOST || "127.0.0.1";
  server.listen(port, host, () => console.error(`Approver channel listening on ${host}:${port}`));
}
