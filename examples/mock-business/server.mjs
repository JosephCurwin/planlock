#!/usr/bin/env node
// Mock micropayout Business MCP (stdio). Stateless executor for local testing.
// Every executed call is appended to MOCK_LEDGER_PATH (JSONL), which is the ground
// truth for "did a write actually reach the business system".
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "fs";

const ledgerPath = process.env.MOCK_LEDGER_PATH || "mock_ledger.jsonl";

const str = { type: "string" };
const num = { type: "number" };
const tools = [
  { name: "checkCompliance", description: "Read-only compliance check for a recipient.", props: { recipient: str }, required: ["recipient"] },
  { name: "getAccountBalance", description: "Read-only balance of a funding account.", props: { account: str }, required: ["account"] },
  { name: "riskScore", description: "Read-only risk score for a recipient.", props: { recipient: str }, required: ["recipient"] },
  { name: "reserveFunds", description: "WRITE: reserve funds on an account.", props: { account: str, amount: num }, required: ["account", "amount"] },
  { name: "assembleInstruction", description: "WRITE: assemble a payout instruction.", props: { recipient: str, amount: num, currency: str }, required: ["recipient", "amount"] },
  { name: "submitToNetwork", description: "WRITE: submit an instruction to the payment network (moves money).", props: { recipient: str, amount: num, instruction_id: str }, required: ["recipient", "amount"] },
  { name: "postLedger", description: "WRITE: post a ledger entry.", props: { entry: str, amount: num }, required: ["entry", "amount"] }
];

const server = new Server({ name: "mock-micropayouts", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.props, required: t.required } }))
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (!tools.some(t => t.name === name)) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), tool: name, args }) + "\n");
  const results = {
    checkCompliance: { recipient: args.recipient, compliant: true },
    getAccountBalance: { account: args.account, balance: 10000, currency: "EUR" },
    riskScore: { recipient: args.recipient, score: 12 },
    reserveFunds: { reservation_id: `res_${Date.now()}`, account: args.account, amount: args.amount },
    assembleInstruction: { instruction_id: `ins_${Date.now()}`, recipient: args.recipient, amount: args.amount },
    submitToNetwork: { network_ref: `net_${Date.now()}`, status: "submitted", recipient: args.recipient, amount: args.amount },
    postLedger: { ledger_id: `led_${Date.now()}`, entry: args.entry, amount: args.amount }
  };
  return { content: [{ type: "text", text: JSON.stringify(results[name]) }] };
});

await server.connect(new StdioServerTransport());
