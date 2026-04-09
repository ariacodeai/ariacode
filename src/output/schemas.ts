import { z } from 'zod';

// ─── OutputVersion ────────────────────────────────────────────────────────────

export const OutputVersion = '1' as const;
export type OutputVersion = typeof OutputVersion;

// ─── Base schema ──────────────────────────────────────────────────────────────

const BaseOutputSchema = z.object({
  version: z.literal('1'),
});

// ─── Command schemas ──────────────────────────────────────────────────────────

export const AskOutputSchema = BaseOutputSchema.extend({
  answer: z.string(),
  sessionId: z.string().uuid(),
});

export const PlanOutputSchema = BaseOutputSchema.extend({
  plan: z.string(),
  sessionId: z.string().uuid(),
  outputPath: z.string().optional(),
});

export const PatchOutputSchema = BaseOutputSchema.extend({
  applied: z.boolean(),
  affectedFiles: z.array(z.string()),
  sessionId: z.string().uuid(),
  dryRun: z.boolean(),
});

export const ReviewOutputSchema = BaseOutputSchema.extend({
  review: z.string(),
  sessionId: z.string().uuid(),
  branch: z.string().optional(),
});

export const ExploreOutputSchema = BaseOutputSchema.extend({
  summary: z.string(),
  sessionId: z.string().uuid(),
});

export const DbSchemaOutputSchema = BaseOutputSchema.extend({
  models: z.array(
    z.object({
      name: z.string(),
      fieldCount: z.number(),
    }),
  ),
  enumCount: z.number(),
  datasourceProvider: z.string().nullable(),
});

export const DbAskOutputSchema = BaseOutputSchema.extend({
  answer: z.string(),
  sessionId: z.string().uuid(),
});

export const DbExplainOutputSchema = BaseOutputSchema.extend({
  explanation: z.string(),
  sessionId: z.string().uuid(),
});

export const HistoryOutputSchema = BaseOutputSchema.extend({
  sessions: z.array(
    z.object({
      id: z.string(),
      command: z.string(),
      status: z.string(),
      createdAt: z.string(),
      completedAt: z.string().nullable(),
    }),
  ),
  total: z.number(),
});

export const DoctorOutputSchema = BaseOutputSchema.extend({
  checks: z.array(
    z.object({
      name: z.string(),
      passed: z.boolean(),
      message: z.string().optional(),
    }),
  ),
  allPassed: z.boolean(),
});

export const UpgradeDepsOutputSchema = BaseOutputSchema.extend({
  upgrades: z.array(
    z.object({
      name: z.string(),
      current: z.string(),
      target: z.string(),
      risk: z.enum(['patch', 'minor', 'major', 'prerelease']),
    }),
  ),
  applied: z.boolean(),
  dryRun: z.boolean(),
});

// ─── OutputValidationError ────────────────────────────────────────────────────

export class OutputValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'OutputValidationError';
  }
}

// ─── formatOutput ─────────────────────────────────────────────────────────────

/**
 * Render a plain-text representation of a data object with no ANSI codes.
 * Flat scalar fields are rendered as `key\tvalue\n`.
 * Array fields render one item per line.
 */
function renderPlain(data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return String(data) + '\n';
  }

  const obj = data as Record<string, unknown>;
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        if (item !== null && typeof item === 'object') {
          // Render object items as tab-separated key=value pairs on one line
          const parts = Object.entries(item as Record<string, unknown>).map(
            ([k, v]) => `${k}=${v === null ? 'null' : String(v)}`,
          );
          lines.push(`  ${parts.join('\t')}`);
        } else {
          lines.push(`  ${String(item)}`);
        }
      }
    } else if (value !== null && typeof value === 'object') {
      // Nested object — render sub-fields indented
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}\t${v === null ? 'null' : String(v)}`);
      }
    } else {
      lines.push(`${key}\t${value === null ? 'null' : String(value)}`);
    }
  }

  return lines.join('\n') + '\n';
}

export function formatOutput<T>(
  data: T,
  format: 'json' | 'ndjson' | 'plain',
  schema: z.ZodType<T>,
): string {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new OutputValidationError(
      `Output validation failed: ${result.error.issues.map((i) => i.message).join(', ')}`,
      result.error.issues,
    );
  }

  // Use result.data (the validated/transformed output) instead of raw data,
  // in case the schema applies defaults, coercions, or strips unknown keys.
  const validated = result.data;

  switch (format) {
    case 'json':
      return JSON.stringify(validated, null, 2) + '\n';

    case 'ndjson':
      return JSON.stringify(validated) + '\n' + '{"version":"1","event":"done"}\n';

    case 'plain':
      return renderPlain(validated);
  }
}
