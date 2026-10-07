/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TestConfig {
  mode: "OFF" | "MAKE_STEP_FAIL" | "MAKE_FINAL_QC_MISMATCH";
  testStep?: number;
  externalVmDir: string;
}

export interface TestAdapter {
  // Called for Feature continuation transactions to produce a job packet
  emitJobPacket?(params: {
    routeKey: string;
    txn: any;
    seqContext: any;
    txnHistory: Array<{ tool_name: string; tool_input: any }>;
    verification?: string[];
    cfg: TestConfig;
  }): Promise<{ jobPacket: any | null; wrote: boolean; outboxDir: string | null }>;

  // Optionally override the step verdict
  computeStepOverride?(params: {
    routeKey: string;
    seqContext: any;
    cfg: TestConfig;
  }): { overrideVerdict?: "PASSED" | "FAILED"; reason?: string };

  // Optionally provide a final QC discrepancy when the plan finishes PASSED
  computeFinalVerification?(params: {
    implementedStep: number;
    cfg: TestConfig;
  }): { status: "FAILED"; discrepancies: string[] } | undefined;
}
