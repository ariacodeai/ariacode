/**
 * Enhanced diff renderer for terminal output.
 *
 * Parses unified diffs and renders them with syntax highlighting, line numbers,
 * collapsed unchanged sections, and optional side-by-side layout.
 *
 */

import pc from 'picocolors';
import { highlight, inferLanguageFromPath } from './highlight.js';
import { stripAnsi } from '../ui.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiffRenderOptions {
  /** Render side-by-side when terminal is wide enough (>120 cols) */
  split: boolean;
  /** Prefix each content line with its source line number */
  lineNumbers: boolean;
  /**
   * Number of consecutive unchanged context lines that triggers collapsing.
   * A run longer than this threshold is replaced with "... N unchanged lines ..."
   */
  collapseThreshold: number;
  /** Override language for syntax highlighting. Inferred from diff header when absent. */
  language?: string;
  /** Terminal width in columns; used for split-view decision. Defaults to process.stdout.columns ?? 80 */
  terminalWidth?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract language from a diff header line like `--- a/src/foo.ts`.
 * Returns undefined if the path cannot be extracted or language is unsupported.
 */
function inferLanguage(diffHeader: string): string | undefined {
  // Match "--- a/path/to/file.ext" or "--- path/to/file.ext"
  const match = diffHeader.match(/^---\s+(?:a\/)?(.+?)(?:\s|$)/);
  if (!match) return undefined;
  const filePath = match[1];
  const lang = inferLanguageFromPath(filePath);
  return lang ?? undefined;
}

/**
 * Wrap highlight(), returning input unchanged on any failure.
 */
function highlightSafe(code: string, language: string): string {
  try {
    return highlight(code, { language });
  } catch {
    return code;
  }
}

/**
 * Collapse runs of unchanged context lines that appear BETWEEN two changed lines
 * (not at the start or end). Runs exceeding `threshold` are replaced with a summary.
 */
function collapseUnchanged(lines: string[], threshold: number): string[] {
  if (threshold <= 0) return lines;

  // Find the index of the first and last changed line
  let firstChanged = -1;
  let lastChanged = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Changed lines start with + or - (but not +++ or ---)
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      if (firstChanged === -1) firstChanged = i;
      lastChanged = i;
    }
  }

  // No changed lines — nothing to collapse
  if (firstChanged === -1) return lines;

  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const isChanged =
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'));

    if (!isChanged) {
      // Collect the run of unchanged lines
      const runStart = i;
      while (
        i < lines.length &&
        !(
          (lines[i].startsWith('+') && !lines[i].startsWith('+++')) ||
          (lines[i].startsWith('-') && !lines[i].startsWith('---'))
        )
      ) {
        i++;
      }
      const runEnd = i; // exclusive
      const runLength = runEnd - runStart;
      const runLines = lines.slice(runStart, runEnd);

      // Only collapse if this run is strictly between two changed lines
      const isMiddle = runStart > firstChanged && runEnd <= lastChanged + 1;

      if (isMiddle && runLength > threshold) {
        result.push(`... ${runLength} unchanged lines ...`);
      } else {
        result.push(...runLines);
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result;
}

/**
 * Render two columns side-by-side given a terminal width.
 * Left column gets original lines, right column gets modified lines.
 */
function renderSideBySide(leftLines: string[], rightLines: string[], width: number): string {
  const colWidth = Math.floor(width / 2) - 1;
  const maxRows = Math.max(leftLines.length, rightLines.length);
  const rows: string[] = [];

  for (let i = 0; i < maxRows; i++) {
    const left = leftLines[i] ?? '';
    const right = rightLines[i] ?? '';

    // Truncate or pad to column width (strip ANSI for length calculation)
    const leftPadded = padToWidth(left, colWidth);
    const rightPadded = padToWidth(right, colWidth);

    rows.push(`${leftPadded} ${rightPadded}`);
  }

  return rows.join('\n');
}

/**
 * Pad a string (which may contain ANSI codes) to a visible width.
 * Truncates if the visible content exceeds the target width.
 * Note: truncation strips ANSI codes for simplicity — long lines lose color in split view.
 */
function padToWidth(str: string, width: number): string {
  const visible = stripAnsi(str);
  if (visible.length >= width) {
    // Truncate visible content — rebuild with ANSI stripped for simplicity
    return visible.slice(0, width);
  }
  return str + ' '.repeat(width - visible.length);
}

// ---------------------------------------------------------------------------
// Diff parsing types
// ---------------------------------------------------------------------------

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context: string;
}

interface ParsedHunk {
  header: HunkHeader;
  lines: string[];
}

interface ParsedFile {
  oldPath: string;
  newPath: string;
  hunks: ParsedHunk[];
}

// ---------------------------------------------------------------------------
// Diff parser
// ---------------------------------------------------------------------------

function parseHunkHeader(line: string): HunkHeader | null {
  const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    context: match[5] ?? '',
  };
}

function parseUnifiedDiff(diffText: string): ParsedFile[] {
  const lines = diffText.split('\n');
  const files: ParsedFile[] = [];
  let currentFile: ParsedFile | null = null;
  let currentHunk: ParsedHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      // Start of a new file diff
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentFile) {
        files.push(currentFile);
      }
      const oldPath = line.slice(4).trim().replace(/^a\//, '');
      // Peek at next line for +++
      const nextLine = lines[i + 1] ?? '';
      const newPath = nextLine.startsWith('+++ ')
        ? nextLine.slice(4).trim().replace(/^b\//, '')
        : oldPath;
      currentFile = { oldPath, newPath, hunks: [] };
      if (nextLine.startsWith('+++ ')) {
        i++; // skip the +++ line
      }
    } else if (line.startsWith('@@ ')) {
      if (currentFile) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
        }
        const header = parseHunkHeader(line);
        if (header) {
          currentHunk = { header, lines: [] };
        }
      }
    } else if (currentHunk !== null) {
      // Content line: +, -, or space (context)
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
        currentHunk.lines.push(line);
      }
    }
  }

  // Flush remaining
  if (currentFile) {
    if (currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    files.push(currentFile);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Count added and removed lines in a list of parsed files.
 */
function countMutations(hunks: ParsedHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/**
 * Render a single hunk in unified format with optional line numbers and highlighting.
 */
function renderHunkUnified(
  hunk: ParsedHunk,
  language: string | undefined,
  lineNumbers: boolean,
): string[] {
  const { lines, header } = hunk;

  // Apply collapse to the raw lines
  // (collapse operates on the raw diff lines before colorization)
  // We'll apply collapse after colorization to preserve the line content

  // Calculate line number width for padding
  const maxOldLine = header.oldStart + header.oldCount;
  const maxNewLine = header.newStart + header.newCount;
  const maxLine = Math.max(maxOldLine, maxNewLine);
  const lineNumWidth = String(maxLine).length;

  let oldLineNum = header.oldStart;
  let newLineNum = header.newStart;

  const rendered: string[] = [];

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      const highlighted = language ? highlightSafe(content, language) : content;
      const colorized = pc.green('+') + highlighted;
      if (lineNumbers) {
        const lineNum = String(newLineNum).padStart(lineNumWidth, ' ');
        rendered.push(`${lineNum} ${colorized}`);
      } else {
        rendered.push(colorized);
      }
      newLineNum++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const content = line.slice(1);
      const highlighted = language ? highlightSafe(content, language) : content;
      const colorized = pc.red('-') + highlighted;
      if (lineNumbers) {
        const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
        rendered.push(`${lineNum} ${colorized}`);
      } else {
        rendered.push(colorized);
      }
      oldLineNum++;
    } else if (line.startsWith('... ') && line.endsWith(' unchanged lines ...')) {
      // Collapse marker — pass through as-is (styled by caller)
      rendered.push(line);
      // Parse the count to advance line numbers
      const countMatch = line.match(/^\.\.\. (\d+) unchanged lines \.\.\./);
      if (countMatch) {
        const n = parseInt(countMatch[1], 10);
        oldLineNum += n;
        newLineNum += n;
      }
    } else {
      // Context line (starts with space or is empty)
      const content = line.startsWith(' ') ? line.slice(1) : line;
      if (lineNumbers) {
        const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
        rendered.push(`${lineNum}  ${content}`);
      } else {
        rendered.push(` ${content}`);
      }
      oldLineNum++;
      newLineNum++;
    }
  }

  return rendered;
}

/**
 * Render a hunk header line.
 */
function renderHunkHeaderLine(header: HunkHeader): string {
  const base = `@@ -${header.oldStart},${header.oldCount} +${header.newStart},${header.newCount} @@`;
  return pc.cyan(header.context ? `${base}${header.context}` : base);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Maximum diff input size (2 MB). Larger diffs are returned as-is to prevent OOM/CPU spikes. */
const MAX_DIFF_SIZE = 2 * 1024 * 1024;

/**
 * Render a unified diff string with syntax highlighting, line numbers,
 * collapsed unchanged sections, and optional side-by-side layout.
 *
 */
export function renderDiff(diffText: string, options: DiffRenderOptions): string {
  // Guard: skip rendering for oversized diffs (binary files, monorepo bulk diffs)
  if (diffText.length > MAX_DIFF_SIZE) return diffText;

  const width = options.terminalWidth ?? process.stdout.columns ?? 80;
  const useSideBySide = options.split && width > 120;

  const files = parseUnifiedDiff(diffText);
  if (files.length === 0) return diffText;

  const outputParts: string[] = [];

  for (const file of files) {
    // Determine language
    const language =
      options.language ??
      inferLanguage(`--- a/${file.oldPath}`) ??
      inferLanguage(`--- a/${file.newPath}`);

    // File header: filepath  +M -N lines
    const { added, removed } = countMutations(file.hunks);
    const filePath = file.newPath !== '/dev/null' ? file.newPath : file.oldPath;
    const fileHeader = `${filePath}  ${pc.green(`+${added}`)} ${pc.red(`-${removed}`)} lines`;
    outputParts.push(fileHeader);

    for (const hunk of file.hunks) {
      // Hunk header
      outputParts.push(renderHunkHeaderLine(hunk.header));

      if (useSideBySide) {
        // Build left (original) and right (modified) lines
        const leftLines: string[] = [];
        const rightLines: string[] = [];

        let oldLineNum = hunk.header.oldStart;
        let newLineNum = hunk.header.newStart;
        const maxOldLine = hunk.header.oldStart + hunk.header.oldCount;
        const maxNewLine = hunk.header.newStart + hunk.header.newCount;
        const maxLine = Math.max(maxOldLine, maxNewLine);
        const lineNumWidth = String(maxLine).length;

        for (const line of hunk.lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            const content = line.slice(1);
            const highlighted = language ? highlightSafe(content, language) : content;
            const colorized = pc.green('+') + highlighted;
            const lineNum = options.lineNumbers
              ? `${String(newLineNum).padStart(lineNumWidth, ' ')} `
              : '';
            leftLines.push('');
            rightLines.push(`${lineNum}${colorized}`);
            newLineNum++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            const content = line.slice(1);
            const highlighted = language ? highlightSafe(content, language) : content;
            const colorized = pc.red('-') + highlighted;
            const lineNum = options.lineNumbers
              ? `${String(oldLineNum).padStart(lineNumWidth, ' ')} `
              : '';
            leftLines.push(`${lineNum}${colorized}`);
            rightLines.push('');
            oldLineNum++;
          } else {
            // Context line
            const content = line.startsWith(' ') ? line.slice(1) : line;
            const leftLineNum = options.lineNumbers
              ? `${String(oldLineNum).padStart(lineNumWidth, ' ')} `
              : '';
            leftLines.push(`${leftLineNum} ${content}`);
            rightLines.push(`${leftLineNum} ${content}`);
            oldLineNum++;
            newLineNum++;
          }
        }

        outputParts.push(renderSideBySide(leftLines, rightLines, width));
      } else {
        // Unified rendering: collapse first, then render
        const collapsedLines = collapseUnchanged(hunk.lines, options.collapseThreshold);
        const collapsedHunk: ParsedHunk = { header: hunk.header, lines: collapsedLines };
        const renderedLines = renderHunkUnified(collapsedHunk, language, options.lineNumbers);

        for (const rLine of renderedLines) {
          if (rLine.startsWith('... ') && rLine.endsWith(' unchanged lines ...')) {
            outputParts.push(pc.dim(rLine));
          } else {
            outputParts.push(rLine);
          }
        }
      }
    }
  }

  return outputParts.join('\n');
}
