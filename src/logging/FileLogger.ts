/*
Module: FileLogger (append-only JSON/text logs)
Grounding:
- protocol.yaml.logging.required_records
- system behavior in current index.ts (appendFile fallback to appendFileSync)
Responsibilities:
- Provide a simple async logger with .info and .error
- Used by protocol loader, audits, persistence, and bootstrap
Public API (exports):
- class FileLogger { info(message, data?), error(message, data?) }
Consumes: Node fs
Notes:
- Do not embed server logic or state here
*/

import fs from "fs/promises";
import { appendFileSync } from "fs";

export class FileLogger {
  private logFile: string;

  constructor(logFile: string) {
    this.logFile = logFile;
  }

  private async writeLog(level: string, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${level}: ${message}${
      data ? "\n" + JSON.stringify(data, null, 2) : ""
    }\n`;

    try {
      await fs.appendFile(this.logFile, logEntry);
    } catch (error) {
      appendFileSync(this.logFile, logEntry);
    }
  }

  async info(message: string, data?: any) {
    await this.writeLog("INFO", message, data);
  }
  
  async error(message: string, data?: any) {
    await this.writeLog("ERROR", message, data);
  }
}
