import { describe, it, expect } from "vitest";
import { ExecutionContextSchema, MutationSummarySchema } from "../../src/context.js";

describe("ExecutionContextSchema", () => {
  const validContext = {
    projectRoot: "/absolute/path",
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    mode: "build" as const,
    dryRun: false,
    assumeYes: false,
    maxIterations: 25,
    timeoutSeconds: 120,
  };

  it("accepts a valid execution context", () => {
    expect(() => ExecutionContextSchema.parse(validContext)).not.toThrow();
  });

  it("rejects relative projectRoot", () => {
    expect(() =>
      ExecutionContextSchema.parse({ ...validContext, projectRoot: "relative/path" })
    ).toThrow();
  });

  it("rejects invalid sessionId (not UUID)", () => {
    expect(() =>
      ExecutionContextSchema.parse({ ...validContext, sessionId: "not-a-uuid" })
    ).toThrow();
  });

  it("rejects invalid mode", () => {
    expect(() =>
      ExecutionContextSchema.parse({ ...validContext, mode: "invalid" })
    ).toThrow();
  });

  it("rejects negative maxIterations", () => {
    expect(() =>
      ExecutionContextSchema.parse({ ...validContext, maxIterations: -1 })
    ).toThrow();
  });

  it("rejects zero maxIterations", () => {
    expect(() =>
      ExecutionContextSchema.parse({ ...validContext, maxIterations: 0 })
    ).toThrow();
  });

  it("applies defaults for optional fields", () => {
    const minimal = {
      projectRoot: "/absolute/path",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    };
    const result = ExecutionContextSchema.parse(minimal);
    expect(result.mode).toBe("build");
    expect(result.dryRun).toBe(false);
    expect(result.assumeYes).toBe(false);
    expect(result.maxIterations).toBe(25);
    expect(result.timeoutSeconds).toBe(120);
  });

  it("accepts plan mode", () => {
    const result = ExecutionContextSchema.parse({ ...validContext, mode: "plan" });
    expect(result.mode).toBe("plan");
  });
});

describe("MutationSummarySchema", () => {
  const validSummary = {
    action: "apply_diff",
    affectedFiles: ["src/index.ts"],
    riskLevel: "low" as const,
    reversible: true,
    rollbackHints: ["git checkout -- src/index.ts"],
  };

  it("accepts a valid mutation summary", () => {
    expect(() => MutationSummarySchema.parse(validSummary)).not.toThrow();
  });

  it("accepts all risk levels", () => {
    for (const riskLevel of ["low", "medium", "high"] as const) {
      expect(() =>
        MutationSummarySchema.parse({ ...validSummary, riskLevel })
      ).not.toThrow();
    }
  });

  it("rejects invalid risk level", () => {
    expect(() =>
      MutationSummarySchema.parse({ ...validSummary, riskLevel: "critical" })
    ).toThrow();
  });

  it("applies defaults for optional arrays", () => {
    const result = MutationSummarySchema.parse(validSummary);
    expect(result.commandsToRun).toEqual([]);
    expect(result.migrations).toEqual([]);
  });

  it("accepts optional diffId", () => {
    const result = MutationSummarySchema.parse({
      ...validSummary,
      diffId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.diffId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
