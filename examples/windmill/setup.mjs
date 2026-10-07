#!/usr/bin/env node
// Prepares the local Windmill for the demo: workspace "demo", folder "support", four scripts
// (get_order, refund_customer, send_email, close_ticket) and an MCP token.
// Writes examples/windmill/.env.windmill with WINDMILL_MCP_TOKEN. Idempotent.
// Uses Windmill's default local login (admin@windmill.dev / changeme).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = (process.env.WINDMILL_URL || "http://127.0.0.1:8000") + "/api";

async function api(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, text: await res.text() };
}

// First start runs database migrations; wait up to 5 minutes.
console.log("Waiting for Windmill...");
for (let i = 0; ; i++) {
  try {
    const r = await fetch(base + "/version", { signal: AbortSignal.timeout(3000) });
    if (r.status === 200) break;
  } catch {}
  if (i === 100) { console.error("Windmill is not reachable at " + base); process.exit(1); }
  await new Promise(r => setTimeout(r, 3000));
}

const login = await api("POST", "/auth/login", { email: "admin@windmill.dev", password: "changeme" });
if (login.status !== 200) { console.error("login failed", login); process.exit(1); }
const session = login.text;

await api("POST", "/workspaces/create", { id: "demo", name: "demo" }, session);
await api("POST", "/w/demo/folders/create", { name: "support" }, session);

const scripts = {
  get_order: ["Look up an order", "READ: order details.",
    `export async function main(order_id: string) {\n  return { order_id, customer: "c_42", email: "customer@example.com", total: 30, currency: "EUR" };\n}\n`],
  refund_customer: ["Refund an order", "WRITE: refunds money to the customer of an order.",
    `export async function main(order_id: string, amount: number) {\n  if (amount > 500) throw new Error("refund limit exceeded");\n  return { refund_id: \`rf_\${Date.now()}\`, order_id, amount, status: "refunded" };\n}\n`],
  send_email: ["Send templated email", "WRITE: sends an email to a customer.",
    `export async function main(to: string, template: string) {\n  return { message_id: \`msg_\${Date.now()}\`, to, template, status: "sent" };\n}\n`],
  close_ticket: ["Close a support ticket", "WRITE: closes a ticket.",
    `export async function main(ticket_id: string) {\n  return { ticket_id, status: "closed" };\n}\n`]
};
for (const [name, [summary, description, content]] of Object.entries(scripts)) {
  const p = `f/support/${name}`;
  const exists = (await api("GET", `/w/demo/scripts/exists/p/${p}`, null, session)).text === "true";
  if (!exists) {
    const r = await api("POST", "/w/demo/scripts/create", { path: p, summary, description, language: "bun", content }, session);
    console.log(`created ${p} (${r.text})`);
  }
}

const envFile = path.join(here, ".env.windmill");
if (!fs.existsSync(envFile)) {
  const t = await api("POST", "/users/tokens/create", { label: "planlock-mcp", scopes: ["mcp:all"], workspace_id: "demo" }, session);
  if (t.status !== 201 && t.status !== 200) { console.error("token creation failed", t); process.exit(1); }
  fs.writeFileSync(envFile, `WINDMILL_MCP_TOKEN=${t.text}\n`);
  console.log(`wrote ${envFile}`);
}

// Wait until every script has its lockfile (only locked versions are runnable).
for (const name of Object.keys(scripts)) {
  for (let i = 0; i < 60; i++) {
    const s = JSON.parse((await api("GET", `/w/demo/scripts/get/p/f/support/${name}`, null, session)).text);
    if (s.lock !== null && s.lock !== undefined) break;
    if (s.lock_error_logs) { console.error(`lock failed for ${name}: ${s.lock_error_logs}`); process.exit(1); }
    await new Promise(r => setTimeout(r, 1000));
  }
}
console.log("Windmill demo workspace ready.");
