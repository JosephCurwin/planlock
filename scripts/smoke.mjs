#!/usr/bin/env node
// End-to-end check against a running server (local or Docker), using the bundled mock upstream.
// Plays both roles: the agent (via MCP) and the human approver (via the approver channel).
//   APPROVER_TOKEN is read from the environment or .env
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mcpUrl = process.env.MCP_URL || `http://127.0.0.1:${process.env.PORT || 3001}/mcp`;
const adminUrl = process.env.ADMIN_URL || `http://127.0.0.1:${process.env.ADMIN_PORT || 4001}`;
const token = process.env.APPROVER_TOKEN;
if (!token) { console.error("APPROVER_TOKEN is required"); process.exit(2); }

const client = new Client({ name: "smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
};
const approve = async (agreement_id, plan_hash) => {
  const r = await fetch(`${adminUrl}/admin/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agreement_id, plan_hash })
  });
  return r.status;
};

let failed = 0;
const check = (label, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };
const executed = (r) => r && r.status_code === undefined && !r.error;
const blocked = (r) => r && (r.status_code >= 400 || !!r.error);

const plan = {
  objective: "Pay recipient r1 at most 25 EUR from acc_main",
  steps: [
    { name: "reserve", description: "Reserve up to 25 EUR", verification: ["reservation exists"],
      tools: { reserveFunds: { max_calls: 1, args: { account: { eq: "acc_main" }, amount: { min: 1, max: 25 } } } } },
    { name: "pay", description: "Submit payout to r1", verification: ["network ref returned"],
      tools: { submitToNetwork: { max_calls: 1, args: { recipient: { eq: "r1" }, amount: { min: 1, max: 25 } } } } }
  ]
};
const start = (agreement_id) => call("action_start", { route: "POST /feature/implement", payload: { plan, agreement_id, _signals: { approval: "PLAN APPROVED" } } });

const tools = (await client.listTools()).tools.map(t => t.name);
check("agreement_approve is not exposed to the agent", !tools.includes("agreement_approve"));
check("write tool without a transaction is blocked", blocked(await call("submitToNetwork", { recipient: "r1", amount: 5 })));

const sub = await call("agreement_submit", { plan_type: "feature_executable", plan });
check("plan submitted", !!sub.agreement_id);
check("start before human approval is blocked", blocked(await start(sub.agreement_id)));
check("human approves via approver channel", (await approve(sub.agreement_id, sub.plan_hash)) === 200);
check("plan established", !blocked(await start(sub.agreement_id)));
await call("action_commit");

const cont = { route: "PATCH /feature/implement/active", payload: { plan: "$ACTIVE_PLAN", plan_hash: sub.plan_hash, _signals: { continue: "Continue" } } };
await call("action_start", cont);
check("step 1: amount over limit is blocked", blocked(await call("reserveFunds", { account: "acc_main", amount: 5000 })));
check("step 1: tool from another step is blocked", blocked(await call("submitToNetwork", { recipient: "r1", amount: 25 })));
check("step 1: approved call executes", executed(await call("reserveFunds", { account: "acc_main", amount: 25 })));
check("step 1: second call is blocked (max_calls)", blocked(await call("reserveFunds", { account: "acc_main", amount: 25 })));
await call("action_commit");

await call("action_start", cont);
check("step 2: other recipient is blocked", blocked(await call("submitToNetwork", { recipient: "r2", amount: 25 })));
check("step 2: approved call executes", executed(await call("submitToNetwork", { recipient: "r1", amount: 25 })));
await call("action_commit");

check("replaying the used approval is blocked", blocked(await start(sub.agreement_id)));

await client.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
