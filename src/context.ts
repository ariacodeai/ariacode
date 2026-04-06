import { z } from "zod";
import * as nodePath from "node:path";

/**
 * Execution mode determines which tools are available
 * - plan: Read-only mode, no mutations allowed
 * - build: Normal mode, mutations allowed with confirmation
 */
export const ExecutionModeSchema = z.enum(["plan", "build"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/**
 * ExecutionContext is passed to all commands and tools
 * Enforces safety boundaries and execution mode
 */
export const ExecutionContextSchema = z.object({
  projectRoot: z.string().refine(
    (path) => nodePath.isAbsolute(path),
    {
      message: "projectRoot must be absolute path",
    }
  ),
  sessionId: z.string().uuid(),
  provider: z.string(),
  model: z.string(),
  mode: ExecutionModeSchema.default("build"),
  dryRun: z.boolean().default(false),
  assumeYes: z.boolean().default(false),
  maxIterations: z.number().int().positive().default(25),
  timeoutSeconds: z.number().int().positive().default(120),
});

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

/**
 * Risk level for mutations
 */
export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * MutationSummary provides a preview of changes before execution
 * Every mutation must produce this summary for user review
 */
export const MutationSummarySchema = z.object({
  action: z.string(),
  affectedFiles: z.array(z.string()),
  commandsToRun: z.array(z.string()).default([]),
  migrations: z.array(z.string()).default([]),
  riskLevel: RiskLevelSchema,
  reversible: z.boolean(),
  rollbackHints: z.array(z.string()),
  diffId: z.string().optional(),
});

export type MutationSummary = z.infer<typeof MutationSummarySchema>;
