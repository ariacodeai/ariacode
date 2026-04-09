import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { renderDiff, DiffRenderOptions } from '../../src/ui/diff-renderer.js';

// ---------------------------------------------------------------------------
// Helper: strip ANSI escape codes
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Arbitrary: unified diff string with known added/removed/context lines
// ---------------------------------------------------------------------------

/**
 * Generates a valid unified diff string with known file path, added lines,
 * removed lines, and context lines.
 */
const unifiedDiffArbitrary = fc
  .record({
    filePath: fc.stringMatching(/^[a-zA-Z0-9_\-\/\.]+$/).filter((s) => s.length >= 1 && s.length <= 20),
    addedLines: fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.startsWith('+') && !s.startsWith('-') && !s.startsWith(' ') && !s.startsWith('@') && !s.startsWith('\x00')), { minLength: 1, maxLength: 5 }),
    removedLines: fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.startsWith('+') && !s.startsWith('-') && !s.startsWith(' ') && !s.startsWith('@') && !s.startsWith('\x00')), { minLength: 1, maxLength: 5 }),
    contextLines: fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.startsWith('+') && !s.startsWith('-') && !s.startsWith(' ') && !s.startsWith('@') && !s.startsWith('\x00')), { minLength: 0, maxLength: 3 }),
  })
  .map(({ filePath, addedLines, removedLines, contextLines }) => {
    const oldCount = removedLines.length + contextLines.length;
    const newCount = addedLines.length + contextLines.length;
    const lines: string[] = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      `@@ -1,${oldCount} +1,${newCount} @@`,
    ];
    // Interleave: context, removed, added, context
    for (const ctx of contextLines) {
      lines.push(` ${ctx}`);
    }
    for (const rem of removedLines) {
      lines.push(`-${rem}`);
    }
    for (const add of addedLines) {
      lines.push(`+${add}`);
    }
    return { diff: lines.join('\n'), filePath, addedLines, removedLines, contextLines };
  });

// ---------------------------------------------------------------------------
// Arbitrary: DiffRenderOptions
// ---------------------------------------------------------------------------

const diffRenderOptionsArbitrary = fc.record({
  split: fc.boolean(),
  lineNumbers: fc.boolean(),
  collapseThreshold: fc.integer({ min: 1, max: 20 }),
  terminalWidth: fc.integer({ min: 80, max: 200 }),
});

// ---------------------------------------------------------------------------
// Property 1: Content preservation in diff rendering
// ---------------------------------------------------------------------------

describe('renderDiff property tests', () => {
  it(
    // Feature: aria-code-v023, Property 1: content preservation in diff rendering
    'Property 1: content preservation — all added/removed line content appears in output',
    () => {
      fc.assert(
        fc.property(unifiedDiffArbitrary, diffRenderOptionsArbitrary, ({ diff, addedLines, removedLines }, options) => {
          const output = stripAnsi(renderDiff(diff, options));

          // Every added line content (without leading +) must appear in output
          for (const line of addedLines) {
            expect(output).toContain(line);
          }

          // Every removed line content (without leading -) must appear in output
          for (const line of removedLines) {
            expect(output).toContain(line);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Property 2: Line numbers on all content lines
  // ---------------------------------------------------------------------------

  it(
    // Feature: aria-code-v023, Property 2: line numbers appear on all content lines
    'Property 2: line numbers — every non-header output line is prefixed with a digit when lineNumbers: true',
    () => {
      fc.assert(
        fc.property(unifiedDiffArbitrary, ({ diff, filePath }) => {
          const options: DiffRenderOptions = {
            split: false,
            lineNumbers: true,
            collapseThreshold: 100,
            terminalWidth: 200,
          };
          const output = renderDiff(diff, options);
          const lines = output.split('\n');

          for (const line of lines) {
            const stripped = stripAnsi(line);

            // Skip empty lines
            if (stripped.trim() === '') continue;
            // Skip hunk headers (@@ ... @@)
            if (stripped.startsWith('@@')) continue;
            // Skip file header lines (contain the file path)
            if (stripped.includes(filePath)) continue;
            // Skip collapse markers
            if (stripped.startsWith('...')) continue;

            // All remaining content lines must start with a digit (line number)
            expect(stripped).toMatch(/^\d/);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Property 3: Collapse threshold respected
  // ---------------------------------------------------------------------------

  it(
    // Feature: aria-code-v023, Property 3: collapse threshold is respected
    'Property 3: collapse threshold — output contains summary marker and omits verbatim context lines',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 3 }).chain((T) =>
            fc.integer({ min: T + 1, max: T + 10 }).chain((N) =>
              fc
                .array(
                  fc.string({ minLength: 1, maxLength: 20 }).filter(
                    (s) =>
                      !s.startsWith('+') &&
                      !s.startsWith('-') &&
                      !s.startsWith(' ') &&
                      !s.startsWith('@') &&
                      !s.startsWith('\x00') &&
                      !s.includes('unchanged lines'),
                  ),
                  { minLength: N, maxLength: N },
                )
                .map((ctxLines) => ({ T, N, ctxLines })),
            ),
          ),
          ({ T, N, ctxLines }) => {
            // Build a diff with exactly N context lines between two changed lines
            const filePath = 'src/test.ts';
            const lines = [
              `--- a/${filePath}`,
              `+++ b/${filePath}`,
              `@@ -1,${N + 2} +1,${N + 2} @@`,
              `-removed line`,
              ...ctxLines.map((l) => ` ${l}`),
              `+added line`,
            ];
            const diff = lines.join('\n');

            const options: DiffRenderOptions = {
              split: false,
              lineNumbers: false,
              collapseThreshold: T,
              terminalWidth: 200,
            };

            const output = stripAnsi(renderDiff(diff, options));

            // Output must contain the collapse summary marker
            expect(output).toContain(`... ${N} unchanged lines ...`);

            // Output must NOT contain all N context lines verbatim
            // (at least one context line should be missing from the output)
            const presentCount = ctxLines.filter((l) => output.includes(l)).length;
            expect(presentCount).toBeLessThan(N);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Property 4: File header contains path and mutation summary
  // ---------------------------------------------------------------------------

  it(
    // Feature: aria-code-v023, Property 4: file header contains path and mutation summary
    'Property 4: file header — output contains file path and +M -N mutation summary',
    () => {
      fc.assert(
        fc.property(
          fc
            .record({
              filePath: fc.stringMatching(/^[a-zA-Z0-9_\-\/\.]+$/).filter((s) => s.length >= 1 && s.length <= 20),
              addedLines: fc.array(
                fc.string({ minLength: 1, maxLength: 20 }).filter(
                  (s) =>
                    !s.startsWith('+') &&
                    !s.startsWith('-') &&
                    !s.startsWith(' ') &&
                    !s.startsWith('@') &&
                    !s.startsWith('\x00'),
                ),
                { minLength: 1, maxLength: 5 },
              ),
              removedLines: fc.array(
                fc.string({ minLength: 1, maxLength: 20 }).filter(
                  (s) =>
                    !s.startsWith('+') &&
                    !s.startsWith('-') &&
                    !s.startsWith(' ') &&
                    !s.startsWith('@') &&
                    !s.startsWith('\x00'),
                ),
                { minLength: 1, maxLength: 5 },
              ),
            })
            .map(({ filePath, addedLines, removedLines }) => {
              const oldCount = removedLines.length;
              const newCount = addedLines.length;
              const diffLines = [
                `--- a/${filePath}`,
                `+++ b/${filePath}`,
                `@@ -1,${oldCount} +1,${newCount} @@`,
                ...removedLines.map((l) => `-${l}`),
                ...addedLines.map((l) => `+${l}`),
              ];
              return { diff: diffLines.join('\n'), filePath, addedCount: addedLines.length, removedCount: removedLines.length };
            }),
          ({ diff, filePath, addedCount, removedCount }) => {
            const options: DiffRenderOptions = {
              split: false,
              lineNumbers: false,
              collapseThreshold: 100,
              terminalWidth: 200,
            };

            const output = stripAnsi(renderDiff(diff, options));

            // Output must contain the file path
            expect(output).toContain(filePath);

            // Output must contain a +M -N mutation summary pattern
            expect(output).toMatch(/\+\d+ -\d+/);

            // The specific counts must appear
            expect(output).toContain(`+${addedCount}`);
            expect(output).toContain(`-${removedCount}`);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
