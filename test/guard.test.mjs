// End-to-end tests: start the built server with the mock upstream, act as agent (MCP) and human
// (approver channel), and assert against the mock ledger what actually reached the upstream.
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3900 + Math.floor(Math.random() * 50);
const ADMIN_PORT = PORT + 100;
const TOKEN = crypto.randomBytes(16).toString("hex");
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "planlock-test-"));
const ledgerPath = path.join(runDir, "mock_ledger.jsonl");
let server;

before(async () => {
  server = spawn(process.execPath, ["dist/http.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT), ADMIN_PORT: String(ADMIN_PORT), ADMIN_HOST: "127.0.0.1",
      APPROVER_TOKEN: TOKEN, APPROVAL_MODE: "human", DEV_MODE: "true", LOG_ROOT: runDir,
      DOMAIN_PROFILE_PATH: path.join(root, "profiles/micropayout.json"),
      UPSTREAM_COMMAND: process.execPath,
      UPSTREAM_ARGS_JSON: JSON.stringify([path.join(root, "examples/mock-business/server.mjs")]),
      MOCK_LEDGER_PATH: ledgerPath, TEST_MODE: "OFF"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 20000);
    let ready = { mcp: false, admin: false };
    const onData = (d) => {
      const s = String(d);
      if (s.includes("listening on port")) ready.mcp = true;
      if (s.includes("Approver channel listening")) ready.admin = true;
      if (ready.mcp && ready.admin) { clearTimeout(timer); resolve(); }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
  });
});

after(() => { server?.kill(); });

async function agent() {
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  return { client, call };
}

async function admin(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}${p}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const writes = () => fs.existsSync(ledgerPath)
  ? fs.readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
      .filter(e => !["checkCompliance", "getAccountBalance", "riskScore"].includes(e.tool))
  : [];
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
const startPlan = (call, p, agreement_id) =>
  call("action_start", { route: "POST /feature/implement", payload: { plan: p, agreement_id, _signals: { approval: "PLAN APPROVED" } } });
const cont = (plan_hash) =>
  ({ route: "PATCH /feature/implement/active", payload: { plan: "$ACTIVE_PLAN", plan_hash, _signals: { continue: "Continue" } } });

test("the agent cannot approve and nothing runs without a human", async () => {
  const { client, call } = await agent();
  const names = (await client.listTools()).tools.map(t => t.name);
  assert.ok(!names.includes("agreement_approve"));
  assert.ok((await call("agreement_approve", { agreement_id: "x" })).error);
  assert.ok(blocked(await call("submitToNetwork", { recipient: "r1", amount: 5 })));

  const sub = await call("agreement_submit", { plan_type: "feature_executable", plan });
  assert.ok(blocked(await startPlan(call, plan, sub.agreement_id)));
  assert.equal((await admin("POST", "/admin/approve", { agreement_id: sub.agreement_id, plan_hash: "wrong" })).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/agreements`)).status, 401);
  assert.deepEqual(writes(), []);
  await client.close();
});

test("an approved plan executes exactly within its limits", async () => {
  const { client, call } = await agent();
  const sub = await call("agreement_submit", { plan_type: "feature_executable", plan });

  const tampered = structuredClone(plan);
  tampered.steps[1].tools.submitToNetwork.args.amount.max = 100000;
  assert.equal((await admin("POST", "/admin/approve", sub)).status, 200);
  assert.ok(blocked(await startPlan(call, tampered, sub.agreement_id)), "tampered plan rejected");

  assert.ok(!blocked(await startPlan(call, plan, sub.agreement_id)));
  await call("action_commit");

  await call("action_start", cont(sub.plan_hash));
  for (const bad of [
    { account: "acc_main", amount: 26 },
    { account: "acc_main", amount: "25" },
    { account: "acc_main", amount: [25] },
    { account: "acc_main", amount: -0 },
    { account: "acc_maіn", amount: 25 },            // Cyrillic і
    { account: "acc_main" },
    { account: "acc_main", amount: 25, evil: "x" },  // undeclared argument
    { account: "acc_main", amount: 25, currency: "BTC" }
  ]) assert.ok(blocked(await call("reserveFunds", bad)), JSON.stringify(bad));
  assert.ok(blocked(await call("submitToNetwork", { recipient: "r1", amount: 25 })), "tool from another step");
  assert.ok(blocked(await call("postLedger", { entry: "x", amount: 1 })), "unlisted write tool");

  // Race: 8 parallel valid calls against max_calls=1
  const race = await Promise.all(Array.from({ length: 8 }, () => call("reserveFunds", { account: "acc_main", amount: 25 })));
  assert.equal(race.filter(executed).length, 1);

  // Restarting the step transaction does not reset the budget
  await call("action_start", cont(sub.plan_hash));
  assert.ok(blocked(await call("reserveFunds", { account: "acc_main", amount: 25 })));
  await call("action_commit");

  await call("action_start", cont(sub.plan_hash));
  assert.ok(blocked(await call("submitToNetwork", { recipient: "r2", amount: 25 })));
  assert.ok(blocked(await call("submitToNetwork", { recipient: "r1", amount: 25, to: "r9" })));
  assert.ok(executed(await call("submitToNetwork", { recipient: "r1", amount: 25 })));
  await call("action_commit");

  // Replay of the used approval, also in parallel
  const replays = await Promise.all(Array.from({ length: 4 }, () => startPlan(call, plan, sub.agreement_id)));
  assert.ok(replays.every(blocked));

  assert.deepEqual(writes().map(w => [w.tool, w.args]), [
    ["reserveFunds", { account: "acc_main", amount: 25 }],
    ["submitToNetwork", { recipient: "r1", amount: 25 }]
  ]);
  await client.close();
});

test("side routes and hold override cannot be used to write", async () => {
  const { client, call } = await agent();
  const before = writes().length;
  const sub = await call("agreement_submit", { plan_type: "feature_executable", plan });
  await admin("POST", "/admin/approve", sub);
  for (const route of ["PATCH /gap/correct", "PATCH /bug/diagnose/implement-fix"]) {
    const r = await call("action_start", { route, payload: { agreement_id: sub.agreement_id, path: "implement_fix", root_cause: "x", modification_plan: [{ change: "x" }],
      tools: { submitToNetwork: { max_calls: 9, args: { recipient: { any: true }, amount: { any: true } } } } } });
    assert.ok(blocked(r), route);
  }
  await call("action_start", { route: "GET /bug/diagnose", payload: {} });
  assert.ok(blocked(await call("submitToNetwork", { recipient: "r1", amount: 1 })), "write in investigation");
  await call("action_commit");
  assert.ok(blocked(await call("action_start", { route: "POST /action/active/acknowledge-audit-failure", payload: { justification: "x", _signals: { override: "x" } } })));
  assert.equal((await admin("POST", "/admin/override", { justification: "x" })).status, 409, "no override grant outside hold");
  assert.equal(writes().length, before);
  await client.close();
});

test("plans with unknown or malformed limits are rejected at submit", async () => {
  const { client, call } = await agent();
  const bad = structuredClone(plan);
  bad.steps[0].tools.reserveFunds.args.amount = { max: 25, approx: true };
  assert.ok((await call("agreement_submit", { plan_type: "feature_executable", plan: bad })).error);
  bad.steps[0].tools.reserveFunds.args.amount = { any: true, max: 25 };
  assert.ok((await call("agreement_submit", { plan_type: "feature_executable", plan: bad })).error);
  await client.close();
});

test("a pin cannot trigger a write tool", async () => {
  const { client, call } = await agent();
  const before = writes().length;
  const p = structuredClone(plan);
  p.steps[0].tools.reserveFunds.pin = { tool: "submitToNetwork", args: { recipient: "evil", amount: 999 }, field: "status", eq: "submitted" };
  const sub = await call("agreement_submit", { plan_type: "feature_executable", plan: p });
  await admin("POST", "/admin/approve", sub);
  await startPlan(call, p, sub.agreement_id);
  await call("action_commit");
  await call("action_start", cont(sub.plan_hash));
  assert.ok(blocked(await call("reserveFunds", { account: "acc_main", amount: 5 })));
  assert.equal(writes().length, before, "neither the pin tool nor the guarded call executed");
  assert.equal((await call("action_commit")).state_snapshot?.state, "hold", "pin-blocked step goes on Hold");
  await call("action_start", { route: "POST /feature/implement/abort", payload: {} });
  await call("action_commit");
  await client.close();
});

test("an override grant only applies to the Hold it was issued for", async () => {
  const { client, call } = await agent();
  const holdOn = async (amount) => {
    const p = structuredClone(plan);
    p.objective += ` ${amount}`;
    const sub = await call("agreement_submit", { plan_type: "feature_executable", plan: p });
    await admin("POST", "/admin/approve", sub);
    await startPlan(call, p, sub.agreement_id);
    await call("action_commit");
    await call("action_start", cont(sub.plan_hash));
    return call("action_commit"); // step committed without executing -> Hold
  };
  assert.equal((await holdOn(1)).state_snapshot?.state, "hold");
  assert.equal((await admin("POST", "/admin/override", { justification: "checked" })).status, 200);
  await call("action_start", { route: "POST /feature/implement/abort", payload: {} }); // agent aborts instead
  await call("action_commit");
  assert.equal((await holdOn(2)).state_snapshot?.state, "hold");
  const ack = await call("action_start", { route: "POST /action/active/acknowledge-audit-failure", payload: { justification: "x", _signals: { override: "x" } } });
  assert.ok(blocked(ack), "stale grant must not clear a new Hold");
  await call("action_start", { route: "POST /feature/implement/abort", payload: {} });
  await call("action_commit");
  await client.close();
});
