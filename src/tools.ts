import { z } from "zod";
import type { ExecutionContext, MutationSummary, RiskLevel } from "./context.js";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { validatePath, validateFileSize, validatePatchSize } from "./safety.js";
import type { Config } from "./config.js";
import { createPatch } from "diff";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import ignore from "ignore";
import { writeFileAtomic } from "./fs-helpers.js";

/**
 * Max number of proposed diffs stored in memory
 * Prevents unbounded memory growth
 */
const MAX_PROPOSED_DIFFS = 100;

/**
 * TTL for proposed diffs in milliseconds (30 minutes)
 */
const PROPOSED_DIFF_TTL_MS = 30 * 60 * 1000;

/**
 * Tool result interface
 * All tools must return this structure
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Tool interface
 * Defines the contract for all tools (read-only and mutation)
 */
export interface Tool {
  name: string;
  description: string;
  isMutation: boolean;
  inputSchema: z.ZodSchema;

  execute(input: unknown, ctx: ExecutionContext, config: Config): Promise<ToolResult>;
}

/**
 * In-memory storage for proposed diffs
 * Maps diffId to diff data with creation timestamp
 * Evicts entries beyond MAX_PROPOSED_DIFFS or older than PROPOSED_DIFF_TTL_MS
 */
const proposedDiffs = new Map<string, {
  files: Array<{
    path: string;
    oldContent: string;
    newContent: string;
  }>;
  summary: MutationSummary;
  createdAt: number;
}>();

/**
 * Evict expired or excess diffs from the cache
 */
function evictStaleDiffs(): void {
  const now = Date.now();

  // Remove expired entries
  for (const [id, entry] of proposedDiffs) {
    if (now - entry.createdAt > PROPOSED_DIFF_TTL_MS) {
      proposedDiffs.delete(id);
    }
  }

  // If still over limit, remove oldest entries
  if (proposedDiffs.size > MAX_PROPOSED_DIFFS) {
    const sorted = [...proposedDiffs.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    );
    const toRemove = sorted.slice(0, sorted.length - MAX_PROPOSED_DIFFS);
    for (const [id] of toRemove) {
      proposedDiffs.delete(id);
    }
  }
}


/**
 * read_file tool
 * Reads file content by path with safety validation
 * Requirements: 8.1, 8.7, 8.8
 */
export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file at the specified path",
  isMutation: false,
  inputSchema: z.object({
    path: z.string().describe("Path to the file to read (relative to project root)"),
  }),

  async execute(input: unknown, ctx: ExecutionContext, config: Config): Promise<ToolResult> {
    try {
      const { path: filePath } = this.inputSchema.parse(input) as { path: string };

      // Validate path is within project root
      validatePath(filePath, ctx.projectRoot);

      // Resolve to absolute path
      const absolutePath = nodePath.resolve(ctx.projectRoot, filePath);

      // Check file size limit
      validateFileSize(absolutePath, config.safety.maxFileSizeKb);

      // Read file content
      const content = fs.readFileSync(absolutePath, "utf-8");

      return {
        success: true,
        data: {
          path: filePath,
          content,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * Load .gitignore patterns from project root
 */
function loadGitignorePatterns(projectRoot: string): ReturnType<typeof ignore> {
  const ig = ignore();

  // Always exclude these patterns
  ig.add([
    "node_modules",
    ".git",
    ".env",
    ".env.*",
  ]);

  // Load .gitignore if it exists
  const gitignorePath = nodePath.join(projectRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }

  return ig;
}

/**
 * Max entries returned by recursive directory listing to prevent OOM on monorepos.
 */
const MAX_DIRECTORY_ENTRIES = 10_000;

/**
 * Shared counter for recursive directory listing.
 * Passed by reference via a wrapper object so recursive calls share the same limit.
 */
interface EntryCounter {
  count: number;
}

/**
 * Recursively list directory contents
 */
function listDirectoryRecursive(
  dirPath: string,
  projectRoot: string,
  ig: ReturnType<typeof ignore>,
  currentDepth: number,
  maxDepth: number,
  counter: EntryCounter = { count: 0 },
): string[] {
  if (currentDepth > maxDepth || counter.count >= MAX_DIRECTORY_ENTRIES) {
    return [];
  }

  const entries: string[] = [];

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (counter.count >= MAX_DIRECTORY_ENTRIES) break;

      const fullPath = nodePath.join(dirPath, item.name);
      const relativePath = nodePath.relative(projectRoot, fullPath);

      // Check if ignored
      if (ig.ignores(relativePath)) {
        continue;
      }

      if (item.isDirectory()) {
        entries.push(relativePath + "/");
        counter.count++;
        // Recurse into subdirectory — shares the same counter
        const subEntries = listDirectoryRecursive(
          fullPath,
          projectRoot,
          ig,
          currentDepth + 1,
          maxDepth,
          counter,
        );
        entries.push(...subEntries);
      } else if (item.isFile()) {
        entries.push(relativePath);
        counter.count++;
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }

  return entries;
}

/**
 * list_directory tool
 * Lists directory contents with optional recursion
 * Requirements: 8.2, 8.6, 23.2, 23.3
 */
export const listDirectoryTool: Tool = {
  name: "list_directory",
  description: "List the contents of a directory with optional recursion",
  isMutation: false,
  inputSchema: z.object({
    path: z.string().default(".").describe("Path to the directory (relative to project root)"),
    recursive: z.boolean().default(false).describe("Whether to list recursively"),
    maxDepth: z.number().int().positive().default(3).describe("Maximum depth for recursive listing"),
  }),

  async execute(input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const { path: dirPath, recursive, maxDepth } = this.inputSchema.parse(input) as { path: string; recursive: boolean; maxDepth: number };

      // Validate path is within project root
      validatePath(dirPath, ctx.projectRoot);

      // Resolve to absolute path
      const absolutePath = nodePath.resolve(ctx.projectRoot, dirPath);

      // Check if directory exists
      if (!fs.existsSync(absolutePath)) {
        return {
          success: false,
          error: `Directory not found: ${dirPath}`,
        };
      }

      if (!fs.statSync(absolutePath).isDirectory()) {
        return {
          success: false,
          error: `Path is not a directory: ${dirPath}`,
        };
      }

      // Load gitignore patterns
      const ig = loadGitignorePatterns(ctx.projectRoot);

      let entries: string[];

      if (recursive) {
        entries = listDirectoryRecursive(absolutePath, ctx.projectRoot, ig, 0, maxDepth);
      } else {
        // Non-recursive listing
        const items = fs.readdirSync(absolutePath, { withFileTypes: true });
        entries = [];

        for (const item of items) {
          const fullPath = nodePath.join(absolutePath, item.name);
          const relativePath = nodePath.relative(ctx.projectRoot, fullPath);

          // Check if ignored
          if (ig.ignores(relativePath)) {
            continue;
          }

          if (item.isDirectory()) {
            entries.push(relativePath + "/");
          } else if (item.isFile()) {
            entries.push(relativePath);
          }
        }
      }

      return {
        success: true,
        data: {
          path: dirPath,
          entries: entries.sort(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * search_code tool
 * Searches code using ripgrep with gitignore support
 * Requirements: 8.3, 22.3
 */
export const searchCodeTool: Tool = {
  name: "search_code",
  description: "Search for code patterns using ripgrep",
  isMutation: false,
  inputSchema: z.object({
    query: z.string().describe("Search query (regex pattern)"),
    path: z.string().default(".").describe("Path to search within (relative to project root)"),
    maxResults: z.number().int().positive().default(50).describe("Maximum number of results to return"),
  }),

  async execute(input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const { query, path: searchPath, maxResults } = this.inputSchema.parse(input) as { query: string; path: string; maxResults: number };

      // Validate path is within project root
      validatePath(searchPath, ctx.projectRoot);

      // Resolve to absolute path
      const absolutePath = nodePath.resolve(ctx.projectRoot, searchPath);

      // Check if path exists
      if (!fs.existsSync(absolutePath)) {
        return {
          success: false,
          error: `Path not found: ${searchPath}`,
        };
      }

      // Use ripgrep for search via execFileSync (no shell — prevents command injection)
      const rgArgs = [
        "--json",
        `--max-count=${maxResults}`,
        "--ignore-case",
        query,
        absolutePath,
      ];

      let output: string;
      try {
        output = execFileSync("rg", rgArgs, {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          cwd: ctx.projectRoot,
        });
      } catch (error: any) {
        // ripgrep exits with code 1 when no matches found
        if (error.status === 1) {
          return {
            success: true,
            data: {
              query,
              path: searchPath,
              results: [],
            },
          };
        }

        // Check if ripgrep is not installed
        if (error.code === 'ENOENT' || error.message.includes("command not found") || error.message.includes("not recognized")) {
          return {
            success: false,
            error: "ripgrep (rg) is not installed. Please install it to use code search.",
          };
        }

        throw error;
      }

      // Parse JSON output
      const lines = output.trim().split("\n");
      const results: Array<{
        file: string;
        line: number;
        column: number;
        text: string;
      }> = [];

      for (const line of lines) {
        if (!line) continue;

        try {
          const parsed = JSON.parse(line);

          if (parsed.type === "match") {
            const relativePath = nodePath.relative(ctx.projectRoot, parsed.data.path.text);
            results.push({
              file: relativePath,
              line: parsed.data.line_number,
              column: parsed.data.submatches[0]?.start || 0,
              text: parsed.data.lines.text.trim(),
            });

            if (results.length >= maxResults) {
              break;
            }
          }
        } catch (parseError) {
          // Skip invalid JSON lines
          continue;
        }
      }

      return {
        success: true,
        data: {
          query,
          path: searchPath,
          results: results.slice(0, maxResults),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * read_package_json tool
 * Reads and parses package.json from project root
 * Requirements: 8.4
 */
export const readPackageJsonTool: Tool = {
  name: "read_package_json",
  description: "Read and parse the package.json file from the project root",
  isMutation: false,
  inputSchema: z.object({}),

  async execute(_input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const packageJsonPath = nodePath.join(ctx.projectRoot, "package.json");

      // Check if package.json exists
      if (!fs.existsSync(packageJsonPath)) {
        return {
          success: false,
          error: "package.json not found in project root",
        };
      }

      // Read and parse package.json
      const content = fs.readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(content);

      return {
        success: true,
        data: packageJson,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * read_prisma_schema tool
 * Reads prisma/schema.prisma if Prisma is detected
 * Requirements: 8.5
 */
export const readPrismaSchemaTool: Tool = {
  name: "read_prisma_schema",
  description: "Read the Prisma schema file if Prisma is detected in the project",
  isMutation: false,
  inputSchema: z.object({}),

  async execute(_input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      // Check for Prisma schema at standard location
      const prismaSchemaPath = nodePath.join(ctx.projectRoot, "prisma", "schema.prisma");

      if (!fs.existsSync(prismaSchemaPath)) {
        return {
          success: false,
          error: "Prisma schema not found. Prisma may not be configured in this project.",
        };
      }

      // Read schema content
      const content = fs.readFileSync(prismaSchemaPath, "utf-8");

      return {
        success: true,
        data: {
          path: "prisma/schema.prisma",
          content,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * Calculate risk level based on file changes
 */
function calculateRiskLevel(files: Array<{ path: string; oldContent: string; newContent: string }>): RiskLevel {
  let riskScore = 0;

  for (const file of files) {
    // High risk patterns
    if (file.path.includes("package.json")) riskScore += 3;
    if (file.path.includes("prisma/schema.prisma")) riskScore += 3;
    if (file.path.includes(".env")) riskScore += 5;
    if (file.path.includes("config")) riskScore += 2;
    if (file.path.includes("database") || file.path.includes("db")) riskScore += 2;

    // Check for deletions
    const oldLines = file.oldContent.split("\n").length;
    const newLines = file.newContent.split("\n").length;
    const deletionRatio = oldLines > 0 ? (oldLines - newLines) / oldLines : 0;

    if (deletionRatio > 0.5) riskScore += 2; // More than 50% deleted
    if (deletionRatio > 0.8) riskScore += 3; // More than 80% deleted
  }

  if (riskScore >= 5) return "high";
  if (riskScore >= 2) return "medium";
  return "low";
}

/**
 * Determine if changes are reversible
 * All file modifications are reversible when old content is preserved for rollback.
 * New file creations are reversible via deletion.
 */
function isReversible(files: Array<{ path: string; oldContent: string; newContent: string }>): boolean {
  // All changes tracked by propose_diff are reversible because we store oldContent
  // for rollback. New files (oldContent === "") can be deleted, and modifications
  // can be restored from the stored oldContent.
  return files.every(
    (file) => file.oldContent !== undefined && file.newContent !== undefined
  );
}

/**
 * Shell-escape a file path for use in rollback hint commands
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Generate rollback hints for the changes
 */
function generateRollbackHints(files: Array<{ path: string; oldContent: string; newContent: string }>): string[] {
  const hints: string[] = [];

  // Git-based rollback
  hints.push("git checkout -- " + files.map(f => shellEscape(f.path)).join(" "));

  // Individual file rollbacks
  for (const file of files) {
    if (file.oldContent === "") {
      // New file - can be deleted
      hints.push(`rm ${shellEscape(file.path)}`);
    } else if (file.newContent === "") {
      // Deleted file - restore from git
      hints.push(`git checkout -- ${shellEscape(file.path)}`);
    }
  }

  return hints;
}

/**
 * propose_diff tool
 * Generates a unified diff without applying changes
 * Requirements: 11.4, 11.5
 */
export const proposeDiffTool: Tool = {
  name: "propose_diff",
  description: "Generate a unified diff for proposed file changes without applying them",
  isMutation: false, // This tool only proposes, doesn't mutate
  inputSchema: z.object({
    files: z.array(
      z.object({
        path: z.string().describe("Path to the file (relative to project root)"),
        oldContent: z.string().describe("Current content of the file (empty string for new files)"),
        newContent: z.string().describe("Proposed new content of the file"),
      })
    ).min(1).describe("Array of files to change"),
  }),

  async execute(input: unknown, ctx: ExecutionContext, config: Config): Promise<ToolResult> {
    try {
      const { files } = this.inputSchema.parse(input) as {
        files: Array<{ path: string; oldContent: string; newContent: string }>;
      };

      // Validate all paths
      for (const file of files) {
        validatePath(file.path, ctx.projectRoot);
      }

      // Check patch size limit
      validatePatchSize(files.length, config.safety.maxFilesPerPatch);

      // Generate unified diffs for each file
      const diffs: Array<{ path: string; diff: string }> = [];

      for (const file of files) {
        const diff = createPatch(
          file.path,
          file.oldContent,
          file.newContent,
          "current",
          "proposed"
        );

        diffs.push({
          path: file.path,
          diff,
        });
      }

      // Calculate risk level
      const riskLevel = calculateRiskLevel(files);

      // Determine reversibility
      const reversible = isReversible(files);

      // Generate rollback hints
      const rollbackHints = generateRollbackHints(files);

      // Generate unique diff ID
      const diffId = randomUUID();

      // Build mutation summary
      const summary: MutationSummary = {
        action: "apply_diff",
        affectedFiles: files.map((f: { path: string }) => f.path),
        commandsToRun: [],
        migrations: [],
        riskLevel,
        reversible,
        rollbackHints,
        diffId,
      };

      // Evict stale diffs before storing new one
      evictStaleDiffs();

      // Store the diff for later application
      proposedDiffs.set(diffId, { files, summary, createdAt: Date.now() });

      return {
        success: true,
        data: {
          diffId,
          diffs,
          summary,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * apply_diff tool
 * Applies a previously proposed diff atomically
 * Requirements: 11.10, 11.11, 11.12, 11.13
 */
export const applyDiffTool: Tool = {
  name: "apply_diff",
  description: "Apply a previously proposed diff to the filesystem",
  isMutation: true,
  inputSchema: z.object({
    diffId: z.string().uuid().describe("ID of the previously proposed diff"),
  }),

  async execute(input: unknown, ctx: ExecutionContext, config: Config): Promise<ToolResult> {
    try {
      const { diffId } = this.inputSchema.parse(input) as { diffId: string };

      // Retrieve stored diff
      const stored = proposedDiffs.get(diffId);
      if (!stored) {
        return {
          success: false,
          error: `Diff not found: ${diffId}. Please use propose_diff first.`,
        };
      }

      const { files, summary } = stored;

      // Validate all paths again (safety check)
      for (const file of files) {
        validatePath(file.path, ctx.projectRoot);
      }

      // Check patch size limit again
      validatePatchSize(files.length, config.safety.maxFilesPerPatch);

      // Apply changes atomically (all or nothing)
      const backups: Array<{ path: string; content: string | null }> = [];

      try {
        // First, create backups of existing files
        for (const file of files) {
          const absolutePath = nodePath.resolve(ctx.projectRoot, file.path);

          if (fs.existsSync(absolutePath)) {
            const currentContent = fs.readFileSync(absolutePath, "utf-8");
            backups.push({ path: absolutePath, content: currentContent });
          } else {
            backups.push({ path: absolutePath, content: null });
          }
        }

        // Apply all changes
        for (const file of files) {
          const absolutePath = nodePath.resolve(ctx.projectRoot, file.path);

          if (file.newContent === "") {
            // Delete file
            if (fs.existsSync(absolutePath)) {
              fs.unlinkSync(absolutePath);
            }
          } else {
            // Create or update file
            // Ensure directory exists
            const dir = nodePath.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }

            writeFileAtomic(absolutePath, file.newContent);
          }
        }

        // Success - remove the diff from storage
        proposedDiffs.delete(diffId);

        return {
          success: true,
          data: {
            diffId,
            affectedFiles: summary.affectedFiles,
            rollbackHints: summary.rollbackHints,
          },
        };
      } catch (error) {
        // Best-effort rollback on failure — use writeFileAtomic for consistency
        for (const backup of backups) {
          try {
            if (backup.content === null) {
              // File didn't exist before, delete it
              if (fs.existsSync(backup.path)) {
                fs.unlinkSync(backup.path);
              }
            } else {
              // Restore original content
              writeFileAtomic(backup.path, backup.content);
            }
          } catch (rollbackError) {
            // Log rollback error but continue
            console.error(`Failed to rollback ${backup.path}:`, rollbackError);
          }
        }

        throw new Error(`Failed to apply diff: ${error}. Changes have been rolled back.`);
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// DB tools (v0.2.0) — all read-only except propose_schema_change
// ---------------------------------------------------------------------------

import { parsePrismaSchema } from './db/schema.js';
import { findPrismaClientUsage } from './db/client-usage.js';
import { buildSchemaChangeProposal, validateSchemaContent } from './db/migrate.js';

/**
 * read_prisma_schema_parsed tool
 * Returns structured PrismaSchemaInfo for the project's schema.prisma.
 */
export const readPrismaSchemaParserTool: Tool = {
  name: 'read_prisma_schema_parsed',
  description: 'Parse schema.prisma and return structured model/field/relation/enum/index data',
  isMutation: false,
  inputSchema: z.object({}),

  async execute(_input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const info = parsePrismaSchema(ctx.projectRoot);
      if (!info) {
        return { success: false, error: 'No schema.prisma found in project' };
      }
      return { success: true, data: info };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * find_prisma_usage tool
 * Searches for Prisma Client calls in TS/JS files.
 */
export const findPrismaUsageTool: Tool = {
  name: 'find_prisma_usage',
  description: 'Find Prisma Client calls (e.g. prisma.user.findMany) in project source files',
  isMutation: false,
  inputSchema: z.object({
    model: z.string().optional().describe('Filter by model name (e.g. "user")'),
    operation: z.string().optional().describe('Filter by operation (e.g. "findMany")'),
  }),

  async execute(input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const { model, operation } = this.inputSchema.parse(input) as { model?: string; operation?: string };
      let usages = await findPrismaClientUsage(ctx.projectRoot, model);
      if (operation) {
        usages = usages.filter((u) => u.operation === operation);
      }
      return { success: true, data: { usages } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * find_model_references tool
 * Finds all references to a model name in TS/JS files (not just Prisma Client calls).
 */
export const findModelReferencesTool: Tool = {
  name: 'find_model_references',
  description: 'Find all references to a Prisma model name in TypeScript/JavaScript files',
  isMutation: false,
  inputSchema: z.object({
    modelName: z.string().describe('The Prisma model name to search for (e.g. "User")'),
  }),

  async execute(input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const { modelName } = this.inputSchema.parse(input) as { modelName: string };

      // Escape regex special characters to prevent injection via modelName
      const escapedName = modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const rgArgs = [
        '--json',
        '--max-count=100',
        '--type=ts',
        '--type=js',
        '-e',
        `\\b${escapedName}\\b`,
        ctx.projectRoot,
      ];

      let output: string;
      try {
        output = execFileSync('rg', rgArgs, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          cwd: ctx.projectRoot,
        });
      } catch (err: any) {
        if (err.status === 1) return { success: true, data: { references: [] } };
        if (err.code === 'ENOENT') return { success: true, data: { references: [] } };
        throw err;
      }

      const references: Array<{ file: string; line: number; context: string }> = [];
      for (const line of output.trim().split('\n')) {
        if (!line) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.type !== 'match') continue;
        references.push({
          file: nodePath.relative(ctx.projectRoot, parsed.data.path.text),
          line: parsed.data.line_number,
          context: parsed.data.lines.text.trim(),
        });
      }

      return { success: true, data: { references } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * In-memory store for proposed schema changes (mirrors proposedDiffs pattern).
 */
const proposedSchemaChanges = new Map<string, {
  schemaPath: string;
  newContent: string;
  summary: MutationSummary;
  createdAt: number;
}>();

/** Max proposed schema changes in memory */
const MAX_PROPOSED_SCHEMA_CHANGES = 20;
/** TTL for proposed schema changes (30 minutes) */
const PROPOSED_SCHEMA_CHANGE_TTL_MS = 30 * 60 * 1000;

/**
 * Evict expired or excess schema change proposals from the cache.
 */
function evictStaleSchemaChanges(): void {
  const now = Date.now();
  for (const [id, entry] of proposedSchemaChanges) {
    if (now - entry.createdAt > PROPOSED_SCHEMA_CHANGE_TTL_MS) {
      proposedSchemaChanges.delete(id);
    }
  }
  if (proposedSchemaChanges.size > MAX_PROPOSED_SCHEMA_CHANGES) {
    const sorted = [...proposedSchemaChanges.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    const toRemove = sorted.slice(0, sorted.length - MAX_PROPOSED_SCHEMA_CHANGES);
    for (const [id] of toRemove) {
      proposedSchemaChanges.delete(id);
    }
  }
}

/**
 * propose_schema_change tool
 * Validates new schema content, generates a diff, stores for later apply.
 * This is a mutation tool — same contract as propose_diff.
 */
export const proposeSchemaChangeTool: Tool = {
  name: 'propose_schema_change',
  description: 'Propose a change to schema.prisma — validates content, generates diff, stores for confirmation',
  isMutation: false, // propose only, apply is separate
  inputSchema: z.object({
    oldContent: z.string().describe('Current content of schema.prisma'),
    newContent: z.string().describe('Proposed new content of schema.prisma'),
    description: z.string().describe('Human-readable description of the change'),
  }),

  async execute(input: unknown, _ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const { oldContent, newContent } = this.inputSchema.parse(input) as {
        oldContent: string;
        newContent: string;
        description: string;
      };

      // Validate new content parses as valid Prisma schema
      const validationError = validateSchemaContent(newContent);
      if (validationError) {
        return { success: false, error: `Invalid Prisma schema: ${validationError}` };
      }

      const schemaPath = 'prisma/schema.prisma';
      const proposal = buildSchemaChangeProposal(schemaPath, oldContent, newContent);

      // Evict stale entries before storing new one
      evictStaleSchemaChanges();

      // Store for apply_schema_change
      proposedSchemaChanges.set(proposal.diffId, {
        schemaPath: proposal.schemaPath,
        newContent: proposal.newContent,
        summary: proposal.summary,
        createdAt: Date.now(),
      });

      return {
        success: true,
        data: {
          diffId: proposal.diffId,
          diff: proposal.diff,
          summary: proposal.summary,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * apply_schema_change tool
 * Applies a previously proposed schema change to the filesystem.
 */
export const applySchemaChangeTool: Tool = {
  name: 'apply_schema_change',
  description: 'Apply a previously proposed schema.prisma change to the filesystem',
  isMutation: true,
  inputSchema: z.object({
    diffId: z.string().uuid().describe('ID returned by propose_schema_change'),
  }),

  async execute(input: unknown, ctx: ExecutionContext, _config: Config): Promise<ToolResult> {
    try {
      const { diffId } = this.inputSchema.parse(input) as { diffId: string };
      const stored = proposedSchemaChanges.get(diffId);
      if (!stored) {
        return { success: false, error: `Schema change not found: ${diffId}. Use propose_schema_change first.` };
      }

      // Validate path is within project root (safety check)
      validatePath(stored.schemaPath, ctx.projectRoot);

      const absolutePath = nodePath.resolve(ctx.projectRoot, stored.schemaPath);
      const dir = nodePath.dirname(absolutePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      writeFileAtomic(absolutePath, stored.newContent);
      proposedSchemaChanges.delete(diffId);

      return {
        success: true,
        data: {
          diffId,
          affectedFiles: stored.summary.affectedFiles,
          rollbackHints: stored.summary.rollbackHints,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * Tool registry
 * All available tools for the agent
 */
export const allTools: Tool[] = [
  readFileTool,
  listDirectoryTool,
  searchCodeTool,
  readPackageJsonTool,
  readPrismaSchemaTool,
  proposeDiffTool,
  applyDiffTool,
  readPrismaSchemaParserTool,
  findPrismaUsageTool,
  findModelReferencesTool,
  proposeSchemaChangeTool,
  applySchemaChangeTool,
];
