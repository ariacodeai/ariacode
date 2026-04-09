import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { z } from 'zod';
import {
  formatOutput,
  OutputValidationError,
  AskOutputSchema,
  PlanOutputSchema,
  PatchOutputSchema,
  ReviewOutputSchema,
  ExploreOutputSchema,
  DbSchemaOutputSchema,
  DbAskOutputSchema,
  DbExplainOutputSchema,
  HistoryOutputSchema,
  DoctorOutputSchema,
  UpgradeDepsOutputSchema,
} from '../../src/output/schemas.js';

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const uuidArb = fc.uuid();
const strArb = fc.string({ minLength: 0, maxLength: 50 });
const optStrArb = fc.option(strArb, { nil: undefined });

const askArb = fc.record({
  version: fc.constant('1' as const),
  answer: strArb,
  sessionId: uuidArb,
});

const planArb = fc.record({
  version: fc.constant('1' as const),
  plan: strArb,
  sessionId: uuidArb,
  outputPath: optStrArb,
});

const patchArb = fc.record({
  version: fc.constant('1' as const),
  applied: fc.boolean(),
  affectedFiles: fc.array(strArb, { maxLength: 5 }),
  sessionId: uuidArb,
  dryRun: fc.boolean(),
});

const reviewArb = fc.record({
  version: fc.constant('1' as const),
  review: strArb,
  sessionId: uuidArb,
  branch: optStrArb,
});

const exploreArb = fc.record({
  version: fc.constant('1' as const),
  summary: strArb,
  sessionId: uuidArb,
});

const dbSchemaArb = fc.record({
  version: fc.constant('1' as const),
  models: fc.array(
    fc.record({ name: strArb, fieldCount: fc.integer({ min: 0, max: 100 }) }),
    { maxLength: 5 },
  ),
  enumCount: fc.integer({ min: 0, max: 20 }),
  datasourceProvider: fc.option(strArb, { nil: null }),
});

const dbAskArb = fc.record({
  version: fc.constant('1' as const),
  answer: strArb,
  sessionId: uuidArb,
});

const dbExplainArb = fc.record({
  version: fc.constant('1' as const),
  explanation: strArb,
  sessionId: uuidArb,
});

const historyArb = fc.record({
  version: fc.constant('1' as const),
  sessions: fc.array(
    fc.record({
      id: strArb,
      command: strArb,
      status: strArb,
      createdAt: strArb,
      completedAt: fc.option(strArb, { nil: null }),
    }),
    { maxLength: 5 },
  ),
  total: fc.integer({ min: 0, max: 1000 }),
});

const doctorArb = fc.record({
  version: fc.constant('1' as const),
  checks: fc.array(
    fc.record({
      name: strArb,
      passed: fc.boolean(),
      message: optStrArb,
    }),
    { maxLength: 5 },
  ),
  allPassed: fc.boolean(),
});

const riskArb = fc.constantFrom('patch', 'minor', 'major', 'prerelease') as fc.Arbitrary<
  'patch' | 'minor' | 'major' | 'prerelease'
>;

const upgradeDepsArb = fc.record({
  version: fc.constant('1' as const),
  upgrades: fc.array(
    fc.record({
      name: strArb,
      current: strArb,
      target: strArb,
      risk: riskArb,
    }),
    { maxLength: 5 },
  ),
  applied: fc.boolean(),
  dryRun: fc.boolean(),
});

// All schemas paired with their arbitraries for generic property tests
type SchemaArbitraryPair<T> = {
  schema: z.ZodType<T>;
  arb: fc.Arbitrary<T>;
  name: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const allPairs: SchemaArbitraryPair<any>[] = [
  { name: 'AskOutputSchema', schema: AskOutputSchema, arb: askArb },
  { name: 'PlanOutputSchema', schema: PlanOutputSchema, arb: planArb },
  { name: 'PatchOutputSchema', schema: PatchOutputSchema, arb: patchArb },
  { name: 'ReviewOutputSchema', schema: ReviewOutputSchema, arb: reviewArb },
  { name: 'ExploreOutputSchema', schema: ExploreOutputSchema, arb: exploreArb },
  { name: 'DbSchemaOutputSchema', schema: DbSchemaOutputSchema, arb: dbSchemaArb },
  { name: 'DbAskOutputSchema', schema: DbAskOutputSchema, arb: dbAskArb },
  { name: 'DbExplainOutputSchema', schema: DbExplainOutputSchema, arb: dbExplainArb },
  { name: 'HistoryOutputSchema', schema: HistoryOutputSchema, arb: historyArb },
  { name: 'DoctorOutputSchema', schema: DoctorOutputSchema, arb: doctorArb },
  { name: 'UpgradeDepsOutputSchema', schema: UpgradeDepsOutputSchema, arb: upgradeDepsArb },
];

// ─── Property 9: JSON round-trip ─────────────────────────────────────────────

describe('Property 9: JSON serialization round-trip', () => {
  // Feature: aria-code-v023, Property 9: JSON serialization round-trip
  // Validates: Requirements 7.6
  for (const { name, schema, arb } of allPairs) {
    it(`JSON.parse(formatOutput(o, 'json', s)) deep-equals o — ${name}`, () => {
      fc.assert(
        fc.property(arb, (data) => {
          const json = formatOutput(data, 'json', schema);
          const parsed = JSON.parse(json);
          expect(parsed).toEqual(data);
        }),
        { numRuns: 100 },
      );
    });
  }
});

// ─── Property 10: NDJSON lines individually parseable ────────────────────────

describe('Property 10: NDJSON lines are individually parseable', () => {
  // Feature: aria-code-v023, Property 10: NDJSON lines are individually parseable
  // Validates: Requirements 9.5
  for (const { name, schema, arb } of allPairs) {
    it(`every non-empty line in ndjson output is parseable — ${name}`, () => {
      fc.assert(
        fc.property(arb, (data) => {
          const ndjson = formatOutput(data, 'ndjson', schema);
          const lines = ndjson.split('\n').filter((l) => l.length > 0);
          for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
          }
        }),
        { numRuns: 100 },
      );
    });
  }
});

// ─── Property 11: Plain output has no ANSI codes ─────────────────────────────

describe('Property 11: plain output contains no ANSI escape codes', () => {
  // Feature: aria-code-v023, Property 11: plain output contains no ANSI escape codes
  // Validates: Requirements 10.5
  const ansiRegex = /\x1b\[[0-9;]*m/;

  for (const { name, schema, arb } of allPairs) {
    it(`plain output has no ANSI codes — ${name}`, () => {
      fc.assert(
        fc.property(arb, (data) => {
          const plain = formatOutput(data, 'plain', schema);
          expect(plain).not.toMatch(ansiRegex);
        }),
        { numRuns: 100 },
      );
    });
  }
});

// ─── Property 12: All schemas include version field '1' ──────────────────────

describe('Property 12: all schemas include version field \'1\'', () => {
  // Feature: aria-code-v023, Property 12: all schemas include version field '1'
  // Validates: Requirements 7.3
  for (const { name, schema, arb } of allPairs) {
    it(`version field equals '1' — ${name}`, () => {
      fc.assert(
        fc.property(arb, (data) => {
          // Validate via schema to confirm it's a valid object
          const result = schema.safeParse(data);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.version).toBe('1');
          }
        }),
        { numRuns: 100 },
      );
    });
  }
});

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('formatOutput — unit tests', () => {
  it('throws OutputValidationError when data fails schema validation', () => {
    const invalidData = { version: '1', answer: 123, sessionId: 'not-a-uuid' };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatOutput(invalidData as any, 'json', AskOutputSchema),
    ).toThrow(OutputValidationError);
  });

  it('OutputValidationError has issues array', () => {
    const invalidData = { version: '1', answer: 123, sessionId: 'not-a-uuid' };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatOutput(invalidData as any, 'json', AskOutputSchema);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputValidationError);
      expect((e as OutputValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it('NDJSON output ends with {"version":"1","event":"done"} line', () => {
    const data = { version: '1' as const, answer: 'hello', sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };
    const ndjson = formatOutput(data, 'ndjson', AskOutputSchema);
    const lines = ndjson.split('\n').filter((l) => l.length > 0);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBe('{"version":"1","event":"done"}');
  });

  it('JSON output is pretty-printed with trailing newline', () => {
    const data = { version: '1' as const, answer: 'hello', sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };
    const json = formatOutput(data, 'json', AskOutputSchema);
    expect(json.endsWith('\n')).toBe(true);
    // Pretty-printed means it has newlines inside
    expect(json.includes('\n  ')).toBe(true);
  });

  it('plain output contains no ANSI codes for a concrete example', () => {
    const data = {
      version: '1' as const,
      checks: [{ name: 'node', passed: true, message: 'ok' }],
      allPassed: true,
    };
    const plain = formatOutput(data, 'plain', DoctorOutputSchema);
    expect(plain).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(plain).toContain('allPassed');
    expect(plain).toContain('true');
  });

  it('plain output renders scalar fields as key\\tvalue', () => {
    const data = {
      version: '1' as const,
      answer: 'my answer',
      sessionId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    };
    const plain = formatOutput(data, 'plain', AskOutputSchema);
    expect(plain).toContain('answer\tmy answer');
  });
});
