#!/usr/bin/env node
// Minimal MCP client for the router's Streamable HTTP endpoint.
//   node scripts/mcp-call.mjs list
//   node scripts/mcp-call.mjs <toolName> '<json args>'
// MCP_URL defaults to http://127.0.0.1:3001/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL || "http://127.0.0.1:3001/mcp";
const [, , tool, rawArgs] = process.argv;
if (!tool) {
  console.error("usage: mcp-call.mjs list | <tool> '<json args>'");
  process.exit(2);
}
const client = new Client({ name: "mcp-call", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
try {
  if (tool === "list") {
    const { tools } = await client.listTools();
    console.log(JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), null, 2));
  } else {
    const res = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
    for (const c of res.content || []) console.log(c.type === "text" ? c.text : JSON.stringify(c));
    if (res.isError) console.log("[isError]");
  }
} finally {
  await client.close();
}
