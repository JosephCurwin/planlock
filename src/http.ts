/*
Module: MCP HTTP Server Bootstrap (Streamable HTTP, stateless)
Grounding:
- HTTP_REFACTOR_NOTES.md
Responsibilities:
- Initialize protocol, persistence, and upstream as in stdio bootstrap
- Expose a Streamable HTTP endpoint at /mcp (POST only in stateless mode)
*/

import dotenv from "dotenv";
dotenv.config();

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import fs from "fs/promises";
import path from "path";
import { FileLogger } from "./logging/FileLogger.js";
import { loadProtocolYaml, getProtocolDoc } from "./protocol/index.js";
import { setProjectRootDirectory, rehydrateServerStateFromLog } from "./persistence/index.js";
import * as Upstream from "./upstream/index.js";
import { loadDomainProfile } from "./domain/profile.js";
import { createServer } from "./server.js";
import { startAdminServer } from "./admin.js";
import { getApprovalMode } from "./approval/index.js";

const projectRootDirectory = path.resolve(process.env.LOG_ROOT || process.cwd());

async function ensureLogDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const stats = await fs.stat(dir);
  if (!stats.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
}

async function bootstrap(): Promise<{ logger: FileLogger }> {
  await ensureLogDirectory(projectRootDirectory);
  const logger = new FileLogger(`${projectRootDirectory}/mcp-judge-debug.log`);

  await loadProtocolYaml(logger);
  setProjectRootDirectory(projectRootDirectory);
  await rehydrateServerStateFromLog(logger);

  try {
    await Upstream.initFromEnv(logger);
  } catch (error) {
    console.error("Upstream init failed; continuing without operational tools:", error);
    await logger.error("Upstream init failed", { error });
  }

  try {
    const prof = loadDomainProfile();
    console.error(`Domain profile: ${prof.name}`);
  } catch {}

  const protocolDoc = getProtocolDoc();
  const DEV_MODE = process.env.DEV_MODE === "true";
  console.error("Planlock HTTP server starting");
  console.error(`Protocol version: ${protocolDoc?.protocol?.version || "unknown"}`);
  console.error(`Log root directory: ${projectRootDirectory}`);
  console.error(`DEV_MODE: ${DEV_MODE}`);
  console.error(`Upstream tools available: ${[...Upstream.getAvailableToolNames()].length}`);

  await logger.info("MCP HTTP Server starting", {
    protocol_version: protocolDoc?.protocol?.version,
    log_root_directory: projectRootDirectory,
    dev_mode: DEV_MODE,
    tools_count: 0,
  });

  return { logger };
}

async function startHttpServer() {
  let logger: FileLogger;
  try {
    ({ logger } = await bootstrap());
  } catch (error) {
    console.error("Failed to bootstrap HTTP server:", error);
    process.exit(1);
  }

  console.error(`Approval mode: ${getApprovalMode()}`);
  if (getApprovalMode() === "human") {
    startAdminServer(logger, process.env.APPROVER_TOKEN, Number(process.env.ADMIN_PORT) || (Number(process.env.PORT) || 4000) + 1000);
  }

  const app = createMcpExpressApp();

  app.post("/mcp", async (req: any, res: any) => {
    const server = createServer(logger);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (_req: any, res: any) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      })
    );
  });

  app.delete("/mcp", async (_req: any, res: any) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      })
    );
  });

  const port = Number(process.env.PORT) || 4000;
  app.listen(port, (error?: Error) => {
    if (error) {
      console.error("Failed to start HTTP server:", error);
      process.exit(1);
    }
    console.log(`Planlock HTTP server listening on port ${port}`);
  });
}

startHttpServer().catch((error) => {
  console.error("Fatal HTTP server error:", error);
  process.exit(1);
});
