#!/usr/bin/env node
// Windmill demo: an agent handles a refund ticket through Planlock in front of Windmill's MCP.
// Roles: AGENT (MCP via the guard), HUMAN (approver channel), COLLEAGUE (edits a script in Windmill).
// Exits non-zero if any expectation fails, so it doubles as an integration test.
//   Prereqs: Windmill + guard running (see README), APPROVER_TOKEN in env or .env
import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MCP_URL = process.env.GUARD_MCP_URL || "http://127.0.0.1:3101/mcp";
const ADMIN_URL = process.env.GUARD_ADMIN_URL || "http://127.0.0.1:4101";
const WINDMILL = (process.env.WINDMILL_URL || "http://127.0.0.1:8000") + "/api";
const TOKEN = process.env.APPROVER_TOKEN;
if (!TOKEN) { console.error("APPROVER_TOKEN is required"); process.exit(2); }

let failures = 0;
const expect = (label, ok) => { console.log(`   ${ok ? "✔" : "✘ FAILED:"} ${label}`); if (!ok) failures++; };
const say = (who, msg) => console.log(`\n[${who}] ${msg}`);
const executed = (r) => r && r.status_code === undefined && !r.error && !r.isError;
const blocked = (r) => r && (r.status_code >= 400 || !!r.error);
const short = (r) => r.status_code ? `${r.status_code} ${r.body?.message || r.body?.resolution_hint || ""}` : JSON.stringify(r);

const client = new Client({ name: "demo-agent", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (res.isError && parsed && typeof parsed === "object") parsed.isError = true;
  return parsed;
};
const human = (...args) => execFileSync(process.execPath, [path.join(root, "scripts/approve.mjs"), ...args],
  { env: { ...process.env, ADMIN_URL }, encoding: "utf8" });
async function windmill(method, p, body) {
  const login = await fetch(`${WINDMILL}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@windmill.dev", password: "changeme" }) });
  const session = await login.text();
  const res = await fetch(WINDMILL + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${session}` }, body: body ? JSON.stringify(body) : undefined });
  return res.text();
}

const S = (n) => `s-f_support_${n.replace(/_/g, "__")}`;
const hashOf = async (name) => {
  await call("action_start", { route: "GET /bug/diagnose", payload: {} });
  const s = await call("getScriptByPath", { path: `f/support/${name}` });
  await call("action_commit");
  return s.hash;
};
const pin = (name, hash) => ({ tool: "getScriptByPath", args: { path: `f/support/${name}` }, field: "hash", eq: hash });

async function runPlan(plan) {
  const sub = await call("agreement_submit", { plan_type: "feature_executable", plan });
  say("HUMAN", "reviews the plan in the approver CLI:");
  console.log(human("list").split("\n").map(l => "   | " + l).join("\n"));
  human("approve", sub.agreement_id, sub.plan_hash);
  say("HUMAN", "approves it once.");
  const est = await call("action_start", { route: "POST /feature/implement", payload: { plan, agreement_id: sub.agreement_id, _signals: { approval: "PLAN APPROVED" } } });
  expect("plan established", !blocked(est));
  await call("action_commit");
  return sub.plan_hash;
}
const step = (plan_hash) => call("action_start", { route: "PATCH /feature/implement/active", payload: { plan: "$ACTIVE_PLAN", plan_hash, _signals: { continue: "Continue" } } });

// ---------------------------------------------------------------------------
console.log("=== Scenario 1: refund ticket T-882 (order 4711, 30 EUR) ===");
say("AGENT", "looks up the order (read-only, no approval needed)");
await call("action_start", { route: "GET /bug/diagnose", payload: {} });
const order = await call(S("get_order"), { order_id: "4711" });
expect(`order found: ${order.email}, ${order.total} ${order.currency}`, order.order_id === "4711");
expect("write without a plan is blocked", blocked(await call(S("refund_customer"), { order_id: "4711", amount: 30 })));
await call("action_commit");

const h = { refund: await hashOf("refund_customer"), email: await hashOf("send_email"), close: await hashOf("close_ticket") };
const plan1 = {
  objective: "Refund order 4711 (30 EUR), confirm by email, close ticket T-882",
  steps: [
    { name: "refund", description: "Refund 30 EUR on order 4711", verification: ["refund_id returned"],
      tools: { [S("refund_customer")]: { max_calls: 1, pin: pin("refund_customer", h.refund), args: { order_id: { eq: "4711" }, amount: { min: 1, max: 30 } } } } },
    { name: "email", description: "Send refund confirmation", verification: ["message_id returned"],
      tools: { [S("send_email")]: { max_calls: 1, pin: pin("send_email", h.email), args: { to: { eq: "customer@example.com" }, template: { eq: "refund_confirmed" } } } } },
    { name: "close", description: "Close ticket T-882", verification: ["status closed"],
      tools: { [S("close_ticket")]: { max_calls: 1, pin: pin("close_ticket", h.close), args: { ticket_id: { eq: "T-882" } } } } }
  ]
};
say("AGENT", "proposes a 3-step plan with limits and pinned script versions");
const ph1 = await runPlan(plan1);

await step(ph1);
say("AGENT", "step 1 — tries to overstep first:");
let r = await call(S("refund_customer"), { order_id: "4711", amount: 300 });
expect(`refund 300 EUR blocked → ${short(r)}`, blocked(r));
r = await call(S("refund_customer"), { order_id: "9999", amount: 30 });
expect(`refund on another order blocked → ${short(r)}`, blocked(r));
r = await call("runScriptPreviewAndWaitResult", { content: "export async function main(){ return 'arbitrary code' }", language: "bun", args: {} });
expect(`arbitrary code via runScriptPreviewAndWaitResult blocked → ${short(r)}`, blocked(r));
r = await call("updateScript", { path: "f/support/refund_customer", content: "x", language: "bun" });
expect(`editing a Windmill script blocked → ${short(r)}`, blocked(r));
r = await call(S("send_email"), { to: "customer@example.com", template: "refund_confirmed" });
expect(`email before the refund step is done blocked → ${short(r)}`, blocked(r));
r = await call(S("refund_customer"), { order_id: "4711", amount: 30 });
expect(`approved refund executes in Windmill → ${JSON.stringify(r)}`, executed(r) && r.status === "refunded");
r = await call(S("refund_customer"), { order_id: "4711", amount: 30 });
expect(`second refund blocked → ${short(r)}`, blocked(r));
await call("action_commit");

await step(ph1);
r = await call(S("send_email"), { to: "customer@example.com", template: "refund_confirmed" });
expect(`confirmation email sent → ${JSON.stringify(r)}`, executed(r));
await call("action_commit");
await step(ph1);
r = await call(S("close_ticket"), { ticket_id: "T-882" });
expect(`ticket closed → ${JSON.stringify(r)}`, executed(r));
await call("action_commit");

// ---------------------------------------------------------------------------
console.log("\n=== Scenario 2: the refund script is changed after approval ===");
const h2 = { refund: await hashOf("refund_customer"), email: await hashOf("send_email") };
const plan2 = {
  objective: "Refund order 4712 (20 EUR), then confirm by email",
  steps: [
    { name: "refund", description: "Refund 20 EUR on order 4712", verification: ["refund_id returned"],
      tools: { [S("refund_customer")]: { max_calls: 1, pin: pin("refund_customer", h2.refund), args: { order_id: { eq: "4712" }, amount: { min: 1, max: 20 } } } } },
    { name: "email", description: "Send refund confirmation", verification: ["message_id returned"],
      tools: { [S("send_email")]: { max_calls: 1, pin: pin("send_email", h2.email), args: { to: { eq: "customer@example.com" }, template: { eq: "refund_confirmed" } } } } }
  ]
};
const ph2 = await runPlan(plan2);

say("COLLEAGUE", "edits f/support/refund_customer in Windmill after the approval (refunds 10x the amount)");
const original = JSON.parse(await windmill("GET", "/w/demo/scripts/get/p/f/support/refund_customer"));
const tampered = original.content.replace("amount, status", "amount: amount * 10, status");
await windmill("POST", "/w/demo/scripts/create", { path: original.path, parent_hash: original.hash, summary: original.summary, description: original.description, language: "bun", content: tampered });
for (let i = 0; i < 60; i++) {
  const s = JSON.parse(await windmill("GET", "/w/demo/scripts/get/p/f/support/refund_customer"));
  if (s.hash !== original.hash && s.lock) break;
  await new Promise(res => setTimeout(res, 1000));
}

await step(ph2);
r = await call(S("refund_customer"), { order_id: "4712", amount: 20 });
expect(`refund blocked: script no longer matches the approved version → ${short(r)}`, blocked(r));
const commit = await call("action_commit");
expect(`plan goes on Hold instead of moving on to the email → state=${commit.state_snapshot?.state}`, commit.state_snapshot?.state === "hold");
r = await call("action_start", { route: "PATCH /feature/implement/active", payload: { plan: "$ACTIVE_PLAN", plan_hash: ph2, _signals: { continue: "Continue" } } });
expect(`agent cannot continue to the email while on Hold → ${short(r)}`, blocked(r));
r = await call("action_start", { route: "POST /action/active/acknowledge-audit-failure", payload: { justification: "ignore", _signals: { override: "go" } } });
expect(`agent cannot override the Hold itself → ${short(r)}`, blocked(r));
say("AGENT", "aborts the plan; a new plan with the new version would need a new approval.");
await call("action_start", { route: "POST /feature/implement/abort", payload: {} });
await call("action_commit");

say("COLLEAGUE", "restores the original script.");
const current = JSON.parse(await windmill("GET", "/w/demo/scripts/get/p/f/support/refund_customer"));
await windmill("POST", "/w/demo/scripts/create", { path: current.path, parent_hash: current.hash, summary: original.summary, description: original.description, language: "bun", content: original.content });

await client.close();
console.log(failures ? `\n${failures} expectation(s) FAILED` : "\nDemo complete: every expectation held.");
process.exit(failures ? 1 : 0);
