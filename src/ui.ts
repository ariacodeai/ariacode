/**
 * Terminal UI utilities for Aria Code CLI
 *
 * Provides color output, diff rendering, table rendering, confirmation prompts,
 * progress indicators, and path formatting.
 *
 * Requirements: 20.1–20.9, 11.6
 */

import pc from "picocolors";
import Table from "cli-table3";
import prompts from "prompts";
import { createPatch } from "diff";
import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// 13.1 Color output and quiet mode (Requirements: 20.1, 20.2, 20.3, 20.9)
// ---------------------------------------------------------------------------

/**
 * Color configuration mode
 */
export type ColorMode = "auto" | "always" | "never";

/**
 * UI state — initialized once per command invocation
 */
let _colorEnabled = true;
let _quietMode = false;

/**
 * Determine whether colors should be enabled based on the color mode and
 * terminal capabilities.
 *
 * - "always": colors on regardless of TTY
 * - "never": colors off regardless of TTY
 * - "auto": colors on only when stdout is a TTY (Req 20.9)
 *
 * Requirements: 20.2, 20.9
 */
export function resolveColorEnabled(mode: ColorMode): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  // "auto": detect TTY
  return Boolean(process.stdout.isTTY);
}

/**
 * Initialize the UI module with color mode and quiet flag.
 * Must be called once at startup before any output functions are used.
 *
 * Requirements: 20.1, 20.2, 20.3, 20.9
 */
export function initUI(colorMode: ColorMode, quiet: boolean): void {
  _colorEnabled = resolveColorEnabled(colorMode);
  _quietMode = quiet;

  // picocolors respects the FORCE_COLOR / NO_COLOR env vars automatically,
  // but we also need to honour our own config. We achieve this by wrapping
  // all color calls through our own helpers below rather than calling pc.*
  // directly in the rest of the codebase.
}

/**
 * Returns true when color output is currently enabled.
 */
export function isColorEnabled(): boolean {
  return _colorEnabled;
}

/**
 * Returns true when quiet mode is active.
 */
export function isQuietMode(): boolean {
  return _quietMode;
}

// ---------------------------------------------------------------------------
// Color helpers — thin wrappers that respect _colorEnabled
// ---------------------------------------------------------------------------

/** Apply bold styling when colors are enabled */
export function bold(text: string): string {
  return _colorEnabled ? pc.bold(text) : text;
}

/** Apply dim styling when colors are enabled */
export function dim(text: string): string {
  return _colorEnabled ? pc.dim(text) : text;
}

/** Apply green color when colors are enabled */
export function green(text: string): string {
  return _colorEnabled ? pc.green(text) : text;
}

/** Apply red color when colors are enabled */
export function red(text: string): string {
  return _colorEnabled ? pc.red(text) : text;
}

/** Apply yellow color when colors are enabled */
export function yellow(text: string): string {
  return _colorEnabled ? pc.yellow(text) : text;
}

/** Apply cyan color when colors are enabled */
export function cyan(text: string): string {
  return _colorEnabled ? pc.cyan(text) : text;
}

/** Apply blue color when colors are enabled */
export function blue(text: string): string {
  return _colorEnabled ? pc.blue(text) : text;
}

/** Apply magenta color when colors are enabled */
export function magenta(text: string): string {
  return _colorEnabled ? pc.magenta(text) : text;
}

/** Apply gray color when colors are enabled */
export function gray(text: string): string {
  return _colorEnabled ? pc.gray(text) : text;
}

// ---------------------------------------------------------------------------
// Output helpers — respect quiet mode (Requirement 20.3)
// ---------------------------------------------------------------------------

/**
 * Print a line to stdout.
 * Always printed regardless of quiet mode (essential output).
 */
export function print(message: string): void {
  process.stdout.write(message + "\n");
}

/**
 * Print a line to stdout only when quiet mode is NOT active.
 * Use for non-essential informational output.
 *
 * Requirement: 20.3
 */
export function info(message: string): void {
  if (!_quietMode) {
    process.stdout.write(message + "\n");
  }
}

/**
 * Print a success message (green checkmark prefix).
 * Suppressed in quiet mode.
 */
export function success(message: string): void {
  if (!_quietMode) {
    process.stdout.write(green("✓ ") + message + "\n");
  }
}

/**
 * Print a warning message (yellow exclamation prefix).
 * Suppressed in quiet mode.
 */
export function warn(message: string): void {
  if (!_quietMode) {
    process.stderr.write(yellow("! ") + message + "\n");
  }
}

/**
 * Print an error message to stderr.
 * Always printed regardless of quiet mode (essential output).
 */
export function error(message: string): void {
  process.stderr.write(red("Error: ") + message + "\n");
}

// ---------------------------------------------------------------------------
// 13.2 Diff rendering (Requirements: 11.6, 20.6)
// ---------------------------------------------------------------------------

/**
 * Colorize a single line of a unified diff.
 *
 * - Lines starting with "+" are green (additions)
 * - Lines starting with "-" are red (deletions)
 * - Lines starting with "@@" are cyan (hunk headers)
 * - Lines starting with "---" / "+++" are bold (file headers)
 * - Context lines are left unstyled
 *
 * Requirement: 20.6
 */
function colorizeDiffLine(line: string): string {
  if (!_colorEnabled) return line;

  if (line.startsWith("+++") || line.startsWith("---")) {
    return bold(line);
  }
  if (line.startsWith("@@")) {
    return cyan(line);
  }
  if (line.startsWith("+")) {
    return green(line);
  }
  if (line.startsWith("-")) {
    return red(line);
  }
  return line;
}

/**
 * Render a unified diff string with syntax highlighting.
 *
 * @param diffText - Unified diff text (e.g. from `createPatch`)
 * @returns Colorized diff string ready for terminal output
 *
 * Requirements: 11.6, 20.6
 */
export function renderDiff(diffText: string): string {
  return diffText
    .split("\n")
    .map(colorizeDiffLine)
    .join("\n");
}

/**
 * Generate and render a unified diff between two strings.
 *
 * @param filePath - File path used as the diff header label
 * @param oldContent - Original file content
 * @param newContent - New file content
 * @returns Colorized unified diff string
 *
 * Requirements: 11.6, 20.6
 */
export function generateAndRenderDiff(
  filePath: string,
  oldContent: string,
  newContent: string
): string {
  const patch = createPatch(filePath, oldContent, newContent, "current", "proposed");
  return renderDiff(patch);
}

/**
 * Print a diff preview for a set of file changes.
 * Suppressed in quiet mode.
 *
 * @param diffs - Array of { path, diff } objects
 *
 * Requirements: 11.6, 20.6
 */
export function printDiffPreview(
  diffs: Array<{ path: string; diff: string }>
): void {
  if (_quietMode) return;

  for (const { path: filePath, diff } of diffs) {
    print(bold(`\nFile: ${filePath}`));
    print(renderDiff(diff));
  }
}

// ---------------------------------------------------------------------------
// 13.3 Table rendering (Requirement: 20.4)
// ---------------------------------------------------------------------------

/**
 * Options for rendering a table.
 */
export interface TableOptions {
  /** Column header labels */
  head: string[];
  /** Optional column widths */
  colWidths?: number[];
}

/**
 * Render tabular data using cli-table3.
 *
 * @param options - Table configuration (headers, column widths)
 * @param rows - Array of row arrays (each row is an array of cell values)
 * @returns Formatted table string ready for terminal output
 *
 * Requirement: 20.4
 */
export function renderTable(
  options: TableOptions,
  rows: string[][]
): string {
  const tableOptions: ConstructorParameters<typeof Table>[0] = {
    head: _colorEnabled
      ? options.head.map((h) => cyan(bold(h)))
      : options.head,
    style: {
      head: [],   // disable cli-table3's own coloring — we handle it above
      border: [],
    },
  };

  if (options.colWidths) {
    tableOptions.colWidths = options.colWidths;
  }

  const table = new Table(tableOptions);

  for (const row of rows) {
    table.push(row);
  }

  return table.toString();
}

/**
 * Print a table to stdout.
 * Suppressed in quiet mode.
 *
 * Requirement: 20.4
 */
export function printTable(options: TableOptions, rows: string[][]): void {
  if (_quietMode) return;
  print(renderTable(options, rows));
}

// ---------------------------------------------------------------------------
// 13.4 Confirmation prompts (Requirement: 20.5)
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a yes/no confirmation using the `prompts` library.
 *
 * Returns `true` if the user confirms, `false` if they decline.
 * Throws `UserCancelledError` if the user cancels (Ctrl+C / SIGINT).
 *
 * Requirement: 20.5
 */
export async function confirm(message: string): Promise<boolean> {
  const response = await prompts(
    {
      type: "confirm",
      name: "value",
      message,
      initial: false,
    },
    {
      onCancel: () => {
        // prompts calls onCancel when the user presses Ctrl+C
        throw new ConfirmCancelledError();
      },
    }
  );

  // If the user pressed Ctrl+C without onCancel being triggered (edge case),
  // response.value will be undefined.
  if (response.value === undefined) {
    throw new ConfirmCancelledError();
  }

  return Boolean(response.value);
}

/**
 * Error thrown when the user cancels a confirmation prompt.
 * Maps to exit code 130 (Requirement 19.7).
 */
export class ConfirmCancelledError extends Error {
  constructor() {
    super("Operation cancelled by user");
    this.name = "ConfirmCancelledError";
  }
}

// ---------------------------------------------------------------------------
// 13.5 Progress indicators (Requirement: 20.7)
// ---------------------------------------------------------------------------

/**
 * A simple spinner / progress indicator for long-running operations.
 *
 * Usage:
 *   const spinner = createSpinner("Analyzing repository...");
 *   spinner.start();
 *   // ... do work ...
 *   spinner.succeed("Analysis complete");
 *
 * Requirement: 20.7
 */
export interface Spinner {
  /** Start the spinner animation */
  start(): void;
  /** Stop the spinner and display a success message */
  succeed(message?: string): void;
  /** Stop the spinner and display a failure message */
  fail(message?: string): void;
  /** Stop the spinner without any message */
  stop(): void;
  /** Update the spinner label */
  update(message: string): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/**
 * Create a terminal spinner for long-running operations.
 * The spinner is suppressed in quiet mode or when colors are disabled
 * (non-interactive environments).
 *
 * Requirement: 20.7
 */
export function createSpinner(initialMessage: string): Spinner {
  let frameIndex = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let currentMessage = initialMessage;
  const isInteractive = _colorEnabled && Boolean(process.stderr.isTTY);

  function clearLine(): void {
    if (isInteractive) {
      process.stderr.write("\r\x1b[K");
    }
  }

  function renderFrame(): void {
    if (!isInteractive) return;
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    process.stderr.write(`\r${cyan(frame)} ${currentMessage}`);
    frameIndex++;
  }

  return {
    start(): void {
      if (_quietMode) return;
      if (isInteractive) {
        intervalId = setInterval(renderFrame, SPINNER_INTERVAL_MS);
        // Prevent the timer from keeping the process alive if the caller
        // throws before calling stop()/succeed()/fail() (leak-safe).
        if (intervalId && typeof intervalId === "object" && "unref" in intervalId) {
          intervalId.unref();
        }
      } else {
        // Non-interactive: just print the message once
        process.stderr.write(`${currentMessage}...\n`);
      }
    },

    update(message: string): void {
      currentMessage = message;
    },

    succeed(message?: string): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      clearLine();
      if (!_quietMode) {
        const label = message ?? currentMessage;
        process.stderr.write(green("✓ ") + label + "\n");
      }
    },

    fail(message?: string): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      clearLine();
      const label = message ?? currentMessage;
      process.stderr.write(red("✗ ") + label + "\n");
    },

    stop(): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      clearLine();
    },
  };
}

// ---------------------------------------------------------------------------
// 13.6 Path formatting (Requirement: 20.8)
// ---------------------------------------------------------------------------

/**
 * Format a file path relative to the project root for readable terminal output.
 *
 * If the path is already relative or cannot be made relative, it is returned
 * as-is. Absolute paths outside the project root are returned unchanged.
 *
 * Requirement: 20.8
 */
export function formatPath(filePath: string, projectRoot: string): string {
  try {
    const relative = nodePath.relative(projectRoot, filePath);
    // If the relative path starts with ".." it's outside the project root —
    // return the original path in that case.
    if (relative.startsWith("..")) {
      return filePath;
    }
    return relative || ".";
  } catch {
    return filePath;
  }
}

/**
 * Format multiple file paths relative to the project root.
 *
 * Requirement: 20.8
 */
export function formatPaths(filePaths: string[], projectRoot: string): string[] {
  return filePaths.map((p) => formatPath(p, projectRoot));
}
