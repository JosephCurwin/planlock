import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAllToolDescriptors, dispatchToolCall } from "./tools/index.js";
import { FileLogger } from "./logging/FileLogger.js";

export function createServer(logger: FileLogger) {
  const server = new Server(
    {
      name: "planlock",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getAllToolDescriptors();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchToolCall(name, args, { logger });
  });

  return server;
}
