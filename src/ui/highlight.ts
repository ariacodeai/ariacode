/**
 * In-house syntax highlighter for terminal output.
 *
 * Applies ANSI color codes via picocolors to TypeScript, JavaScript, Prisma,
 * JSON, and Markdown code snippets. Zero external dependencies beyond picocolors.
 *
 */

import pc from 'picocolors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SupportedLanguage = 'typescript' | 'javascript' | 'prisma' | 'json' | 'markdown';

export interface HighlightOptions {
  /** Language identifier; if unknown/unsupported, returns input unchanged */
  language: string;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'interface', 'type',
  'return', 'if', 'else', 'for', 'while', 'async', 'await', 'export',
  'import', 'from', 'default', 'extends', 'implements', 'new', 'this',
  'typeof', 'instanceof', 'in', 'of', 'do', 'switch', 'case', 'break',
  'continue', 'throw', 'try', 'catch', 'finally', 'void', 'null',
  'undefined', 'true', 'false', 'static', 'readonly', 'private',
  'protected', 'public', 'abstract', 'enum', 'namespace', 'declare',
  'as', 'is', 'keyof', 'never', 'any', 'unknown', 'object', 'string',
  'number', 'boolean', 'symbol', 'bigint', 'delete', 'yield', 'super',
  'with', 'debugger',
]);

/**
 * Highlight TypeScript or JavaScript code.
 */
function highlightTS(code: string): string {
  const placeholders: string[] = [];

  // Step 1: extract comments and strings into placeholders
  // Template literals (backtick) may span lines and contain ${...} — match them separately.
  let result = code.replace(
    /(\/\/.*$|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.|\$\{[^}]*\})*`|(['"])(?:[^'"\\n]|\\.)*\2)/gm,
    (match) => {
      const idx = placeholders.length;
      if (match.startsWith('//') || match.startsWith('/*')) {
        placeholders.push(pc.gray(match));
      } else {
        placeholders.push(pc.green(match));
      }
      return `\x00TOKEN_${idx}\x00`;
    },
  );

  // Step 2: numbers
  result = result.replace(/\b\d+(\.\d+)?\b/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(pc.yellow(match));
    return `\x00TOKEN_${idx}\x00`;
  });

  // Step 3: keywords
  result = result.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g, (match) => {
    if (TS_KEYWORDS.has(match)) {
      const idx = placeholders.length;
      placeholders.push(pc.cyan(match));
      return `\x00TOKEN_${idx}\x00`;
    }
    return match;
  });

  // Step 4: restore placeholders
  return result.replace(/\x00TOKEN_(\d+)\x00/g, (_, i) => placeholders[Number(i)]);
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

const PRISMA_KEYWORDS = new Set([
  'model', 'enum', 'datasource', 'generator', 'provider', 'url',
  'output', 'previewFeatures', 'relationMode',
]);

const PRISMA_FIELD_TYPES = new Set([
  'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json',
  'Bytes', 'Decimal', 'BigInt',
]);

/**
 * Highlight Prisma schema code.
 */
function highlightPrisma(code: string): string {
  const placeholders: string[] = [];

  // Step 1: line comments and strings
  let result = code.replace(
    /(\/\/.*$|(['"])(?:(?!\2)[^\\]|\\.)*\2)/gm,
    (match) => {
      const idx = placeholders.length;
      if (match.startsWith('//')) {
        placeholders.push(pc.gray(match));
      } else {
        placeholders.push(pc.green(match));
      }
      return `\x00TOKEN_${idx}\x00`;
    },
  );

  // Step 2: directives (@id, @@unique, etc.)
  result = result.replace(/@@?[a-zA-Z]+/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(pc.magenta(match));
    return `\x00TOKEN_${idx}\x00`;
  });

  // Step 3: field types (capitalized identifiers in the type set)
  result = result.replace(/\b([A-Z][a-zA-Z0-9]*)\b/g, (match) => {
    if (PRISMA_FIELD_TYPES.has(match)) {
      const idx = placeholders.length;
      placeholders.push(pc.blue(match));
      return `\x00TOKEN_${idx}\x00`;
    }
    return match;
  });

  // Step 4: keywords
  result = result.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (match) => {
    if (PRISMA_KEYWORDS.has(match)) {
      const idx = placeholders.length;
      placeholders.push(pc.cyan(match));
      return `\x00TOKEN_${idx}\x00`;
    }
    return match;
  });

  // Step 5: restore
  return result.replace(/\x00TOKEN_(\d+)\x00/g, (_, i) => placeholders[Number(i)]);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Highlight JSON code.
 */
function highlightJSON(code: string): string {
  const placeholders: string[] = [];

  // Step 1: string keys (before colon) and string values
  // Keys: "key":
  let result = code.replace(/"([^"\\]|\\.)*"\s*:/g, (match) => {
    const idx = placeholders.length;
    // color just the key string, keep the colon plain
    const colonIdx = match.lastIndexOf(':');
    const key = match.slice(0, colonIdx);
    const colon = match.slice(colonIdx);
    placeholders.push(pc.cyan(key) + colon);
    return `\x00TOKEN_${idx}\x00`;
  });

  // Values: remaining strings
  result = result.replace(/"([^"\\]|\\.)*"/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(pc.green(match));
    return `\x00TOKEN_${idx}\x00`;
  });

  // Step 2: numbers
  result = result.replace(/\b\d+(\.\d+)?\b/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(pc.yellow(match));
    return `\x00TOKEN_${idx}\x00`;
  });

  // Step 3: booleans and null
  result = result.replace(/\b(true|false|null)\b/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(pc.cyan(match));
    return `\x00TOKEN_${idx}\x00`;
  });

  // Step 4: restore
  return result.replace(/\x00TOKEN_(\d+)\x00/g, (_, i) => placeholders[Number(i)]);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Highlight Markdown code (line-by-line for headings, inline for others).
 */
function highlightMarkdown(code: string): string {
  const lines = code.split('\n');
  const processed = lines.map((line) => {
    // Fenced code block lines (``` or ~~~)
    if (/^```/.test(line) || /^~~~/.test(line)) {
      return pc.green(line);
    }

    // Headings: lines starting with #
    if (/^#{1,6}\s/.test(line)) {
      return pc.bold(pc.blue(line));
    }

    // Process inline patterns
    // Inline code: `code`
    line = line.replace(/`([^`]+)`/g, (match) => pc.green(match));

    // Bold: **text**
    line = line.replace(/\*\*([^*]+)\*\*/g, (match) => pc.bold(match));

    return line;
  });

  return processed.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Maximum input size for highlighting (100 KB). Larger inputs returned as-is. */
const MAX_HIGHLIGHT_SIZE = 100_000;

/**
 * Apply minimal syntax highlighting using ANSI color codes via picocolors.
 * Returns the input code unchanged if the language is unsupported or if any
 * error occurs — never throws.
 *
 */
export function highlight(code: string, options: HighlightOptions): string {
  if (code.length > MAX_HIGHLIGHT_SIZE) return code;
  try {
    const lang = options.language as SupportedLanguage;
    switch (lang) {
      case 'typescript':
      case 'javascript':
        return highlightTS(code);
      case 'prisma':
        return highlightPrisma(code);
      case 'json':
        return highlightJSON(code);
      case 'markdown':
        return highlightMarkdown(code);
      default:
        return code;
    }
  } catch {
    return code;
  }
}

/**
 * Infer a SupportedLanguage from a file path/extension.
 * Returns null if the extension is not in the supported set.
 *
 */
export function inferLanguageFromPath(filePath: string): SupportedLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.prisma':
      return 'prisma';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    default:
      return null;
  }
}
