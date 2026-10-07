#!/usr/bin/env node
// Human approver CLI for the out-of-band approver channel.
//   node scripts/approve.mjs list                      -> pending plans with the limits that will be enforced
//   node scripts/approve.mjs show <agreement_id>       -> one plan in detail (incl. raw JSON)
//   node scripts/approve.mjs approve <agreement_id> <plan_hash>
//   node scripts/approve.mjs override "<justification>"
// APPROVER_TOKEN is read from the environment or .env
import "dotenv/config";

const base = process.env.ADMIN_URL || `http://127.0.0.1:${process.env.ADMIN_PORT || 4001}`;
const token = process.env.APPROVER_TOKEN;
if (!token) { console.error("APPROVER_TOKEN is required"); process.exit(2); }

const request = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

function describeConstraint(c) {
  if (c.any) return "ANY VALUE";
  const parts = [];
  if (c.eq !== undefined) parts.push(`= ${JSON.stringify(c.eq)}`);
  if (c.enum !== undefined) parts.push(`one of ${c.enum.map(v => JSON.stringify(v)).join(", ")}`);
  if (c.min !== undefined) parts.push(`>= ${c.min}`);
  if (c.max !== undefined) parts.push(`<= ${c.max}`);
  if (c.max_length !== undefined) parts.push(`length <= ${c.max_length}`);
  return parts.join(", ");
}

function describeTools(tools, indent) {
  if (!tools) return [`${indent}(no tools bound: read-only)`];
  const lines = [];
  for (const [name, spec] of Object.entries(tools)) {
    lines.push(`${indent}${name}  — at most ${spec.max_calls ?? 1} call(s)`);
    if (spec.pin) lines.push(`${indent}    version pinned: ${spec.pin.tool}(${JSON.stringify(spec.pin.args || {})}).${spec.pin.field} = ${JSON.stringify(spec.pin.eq)}`);
    const args = Object.entries(spec.args || {});
    if (args.length === 0) lines.push(`${indent}    (no arguments allowed)`);
    for (const [arg, c] of args) lines.push(`${indent}    ${arg}: ${describeConstraint(c)}`);
  }
  return lines;
}

function describe(a) {
  const lines = [
    `Agreement ${a.agreement_id}  [${a.plan_type}]  status=${a.status}${a.consumed ? " (used)" : ""}`,
    `plan_hash ${a.plan_hash}`
  ];
  if (!a.plan) return [...lines, "  (plan content not available)"].join("\n");
  if (a.plan.objective) lines.push(`Objective (agent's words, NOT enforced): ${a.plan.objective}`);
  if (Array.isArray(a.plan.steps)) {
    a.plan.steps.forEach((s, i) => {
      lines.push(`  Step ${i + 1}: ${s.name}`);
      lines.push(...describeTools(s.tools, "    "));
    });
  } else {
    lines.push(...describeTools(a.plan.tools, "  "));
  }
  lines.push("ENFORCED = the tool/argument lines above. Everything else is description only.");
  return lines.join("\n");
}

const [, , cmd, a, b] = process.argv;
if (cmd === "list") {
  const r = await request("GET", "/admin/agreements");
  if (r.status !== 200) { console.log(r.status, r.body); process.exit(1); }
  const pending = r.body.filter(x => x.status !== "approved");
  console.log(pending.length ? pending.map(describe).join("\n\n") : "No plans awaiting approval.");
} else if (cmd === "show") {
  const r = await request("GET", "/admin/agreements");
  const x = (r.body || []).find(y => y.agreement_id === a);
  if (!x) { console.log("not found"); process.exit(1); }
  console.log(describe(x) + "\n\nRaw plan:\n" + JSON.stringify(x.plan, null, 2));
} else if (cmd === "approve") {
  const r = await request("POST", "/admin/approve", { agreement_id: a, plan_hash: b });
  console.log(r.status, JSON.stringify(r.body));
  process.exit(r.status === 200 ? 0 : 1);
} else if (cmd === "override") {
  const r = await request("POST", "/admin/override", { justification: a });
  console.log(r.status, JSON.stringify(r.body));
  process.exit(r.status === 200 ? 0 : 1);
} else {
  console.error("usage: approve.mjs list | show <id> | approve <id> <plan_hash> | override <justification>");
  process.exit(2);
}
