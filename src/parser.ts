/**
 * CLI argument parsing and validation — extracted for testability.
 * This module has no side effects and does not call process.exit directly.
 */

import pc from "picocolors";
import type { SessionStatus } from "./storage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string | null;
  // command-specific positional args
  question?: string; // ask
  goal?: string; // plan
  description?: string; // patch
  // global flags
  dryRun: boolean;
  assumeYes: boolean;
  session?: string;
  quiet: boolean;
  format: "text" | "json" | "ndjson" | "plain";
  // v0.2.2: global provider/model overrides
  provider?: string;
  model?: string;
  // command-specific flags
  maxTokens?: number;
  output?: string;
  unstaged?: boolean;
  branch?: string;
  depth?: number;
  save?: boolean;
  limit?: number;
  tree?: boolean;
  // config subcommand
  configSubcommand?: "get" | "set" | "path" | "init";
  configKey?: string;
  configValue?: string;
  // db subcommand (v0.2.0)
  dbSubcommand?: "schema" | "ask" | "explain" | "migrate";
  dbQuestion?: string;
  dbDescription?: string;
  dbModel?: string;
  dbFile?: string;
  dbJson?: boolean;
  // upgrade subcommand (v0.2.1)
  upgradeSubcommand?: "deps" | "prisma";
  upgradeRisk?: "patch" | "minor" | "major" | "all";
  upgradeDev?: boolean;
  // history flags (v0.2.3)
  historySearch?: string;
  historyCommand?: string;
  historySince?: string;
  historyStatus?: SessionStatus;
  historyExport?: string;
  historySplit?: boolean;
}

// ---------------------------------------------------------------------------
// Usage strings
// ---------------------------------------------------------------------------

export const GLOBAL_USAGE = `
${pc.bold("aria")} - A predictable coding agent for Next.js, Nest.js, Prisma, and Node.js projects.

${pc.bold("USAGE:")}
  aria <command> [options]

${pc.bold("COMMANDS:")}
  ask <question>        Ask a question about the repository
  plan <goal>           Generate an implementation plan
  patch <description>   Generate and apply a code patch
  review                Review staged git changes
  explore               Explore repository structure
  history               View session history
  config                Manage configuration
  doctor                Check environment and project detection
  db                    Prisma database assistant (schema, ask, explain, migrate)
  upgrade               Upgrade dependencies and frameworks (deps, prisma)

${pc.bold("GLOBAL OPTIONS:")}
  --dry-run             Preview changes without applying them
  --yes                 Skip confirmation prompts
  --session <id>        Resume or reference a session
  --quiet               Suppress non-essential output
  --format <fmt>        Output format: text, json, ndjson, plain (default: text)
  --provider <name>     Override provider (anthropic, openai, ollama, openrouter)
  --model <name>        Override model for this invocation
  --help, -h            Show this help message
  --version, -v         Show version number
`;

export const COMMAND_USAGE: Record<string, string> = {
  ask: `
${pc.bold("USAGE:")}
  aria ask <question> [options]

${pc.bold("ARGUMENTS:")}
  <question>            The question to ask about the repository (required)

${pc.bold("OPTIONS:")}
  --session <id>        Resume an existing session
  --max-tokens <n>      Maximum tokens for the response
  --quiet               Suppress non-essential output
`,
  plan: `
${pc.bold("USAGE:")}
  aria plan <goal> [options]

${pc.bold("ARGUMENTS:")}
  <goal>                The implementation goal (required)

${pc.bold("OPTIONS:")}
  --session <id>        Resume an existing session
  --output <path>       Save plan to file at specified path
`,
  patch: `
${pc.bold("USAGE:")}
  aria patch <description> [options]

${pc.bold("ARGUMENTS:")}
  <description>         Description of the patch to apply (required)

${pc.bold("OPTIONS:")}
  --dry-run             Preview changes without applying them
  --yes                 Skip confirmation prompt
  --session <id>        Resume an existing session
`,
  review: `
${pc.bold("USAGE:")}
  aria review [options]

${pc.bold("OPTIONS:")}
  --unstaged            Review unstaged changes instead of staged
  --branch <base>       Compare current branch to specified base branch
  --format <text|json>  Output format (default: text)
`,
  explore: `
${pc.bold("USAGE:")}
  aria explore [options]

${pc.bold("OPTIONS:")}
  --depth <n>           Limit directory traversal depth
  --save                Save exploration summary to ./.aria/explore.md
`,
  history: `
${pc.bold("USAGE:")}
  aria history [options]
  aria history search <query>

${pc.bold("OPTIONS:")}
  --limit <n>           Limit number of results
  --session <id>        Show full log for a specific session
  --tree                Render tool execution tree
  --command <cmd>       Filter by command name
  --since <expr>        Filter by date (e.g. "3 days ago", "2024-01-15")
  --status <status>     Filter by status: running, completed, failed, cancelled
  --export <path>       Export session transcript to markdown file (requires --session)
  --format <fmt>        Output format: text, json, ndjson, plain (default: text)
`,
  config: `
${pc.bold("USAGE:")}
  aria config [subcommand] [options]

${pc.bold("SUBCOMMANDS:")}
  get <key>             Display value for a configuration key
  set <key> <value>     Write a key-value pair to user config
  path                  Display configuration file paths
  init                  Create ./.aria.toml with default values

${pc.bold("OPTIONS:")}
  --dry-run             Preview changes without writing
  --yes                 Skip confirmation prompt
`,
  doctor: `
${pc.bold("USAGE:")}
  aria doctor [options]

${pc.bold("OPTIONS:")}
  --format <text|json>  Output format (default: text)
`,
  db: `
${pc.bold("USAGE:")}
  aria db <subcommand> [options]

${pc.bold("SUBCOMMANDS:")}
  schema                Parse and render schema.prisma (no LLM)
  ask <question>        Q&A over Prisma schema, generates Prisma Client code
  explain <description> Analyze Prisma Client usage and explain performance
  migrate <description> Propose changes to schema.prisma (never runs migrations)

${pc.bold("OPTIONS:")}
  --prisma-model <name> Filter to a specific Prisma model
  --file <path>         Focus on a specific file (db explain)
  --json                Output as JSON (db schema)
  --dry-run             Preview without applying (db migrate)
  --yes                 Skip confirmation (db migrate)
`,
  upgrade: `
${pc.bold("USAGE:")}
  aria upgrade <subcommand> [options]

${pc.bold("SUBCOMMANDS:")}
  deps                  Analyze and upgrade outdated dependencies
  prisma                Prisma-specific upgrade with migration guidance

${pc.bold("OPTIONS (deps):")}
  --risk <level>        Filter by risk: patch, minor, major, all (default: minor)
  --dev                 Include devDependencies in upgrade
  --dry-run             Preview without modifying package.json
  --yes                 Skip confirmation prompt

${pc.bold("OPTIONS (prisma):")}
  --dry-run             Preview without modifying package.json
  --yes                 Skip confirmation prompt
`,
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an argv array into a typed ParsedArgs object.
 */
export function parseCLI(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const args: ParsedArgs = {
    command: null,
    dryRun: false,
    assumeYes: false,
    quiet: false,
    format: "text",
  };

  const tokens = [...argv];
  const positionals: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--yes" || token === "-y") {
      args.assumeYes = true;
    } else if (token === "--quiet" || token === "-q") {
      args.quiet = true;
    } else if (token === "--session") {
      i++;
      args.session = tokens[i];
    } else if (token.startsWith("--session=")) {
      args.session = token.slice("--session=".length);
    } else if (token === "--format") {
      i++;
      args.format = tokens[i] as "text" | "json" | "ndjson" | "plain";
    } else if (token.startsWith("--format=")) {
      args.format = token.slice("--format=".length) as "text" | "json" | "ndjson" | "plain";
    } else if (token === "--max-tokens") {
      i++;
      args.maxTokens = parseInt(tokens[i], 10);
    } else if (token.startsWith("--max-tokens=")) {
      args.maxTokens = parseInt(token.slice("--max-tokens=".length), 10);
    } else if (token === "--output") {
      i++;
      args.output = tokens[i];
    } else if (token.startsWith("--output=")) {
      args.output = token.slice("--output=".length);
    } else if (token === "--unstaged") {
      args.unstaged = true;
    } else if (token === "--branch") {
      i++;
      args.branch = tokens[i];
    } else if (token.startsWith("--branch=")) {
      args.branch = token.slice("--branch=".length);
    } else if (token === "--depth") {
      i++;
      args.depth = parseInt(tokens[i], 10);
    } else if (token.startsWith("--depth=")) {
      args.depth = parseInt(token.slice("--depth=".length), 10);
    } else if (token === "--save") {
      args.save = true;
    } else if (token === "--limit") {
      i++;
      args.limit = parseInt(tokens[i], 10);
    } else if (token.startsWith("--limit=")) {
      args.limit = parseInt(token.slice("--limit=".length), 10);
    } else if (token === "--tree") {
      args.tree = true;
    } else if (token === "--json") {
      args.dbJson = true;
    } else if (token === "--model") {
      i++;
      args.model = tokens[i];
    } else if (token.startsWith("--model=")) {
      args.model = token.slice("--model=".length);
    } else if (token === "--prisma-model") {
      i++;
      args.dbModel = tokens[i];
    } else if (token.startsWith("--prisma-model=")) {
      args.dbModel = token.slice("--prisma-model=".length);
    } else if (token === "--file") {
      i++;
      args.dbFile = tokens[i];
    } else if (token.startsWith("--file=")) {
      args.dbFile = token.slice("--file=".length);
    } else if (token === "--risk") {
      i++;
      args.upgradeRisk = tokens[i] as "patch" | "minor" | "major" | "all";
    } else if (token.startsWith("--risk=")) {
      args.upgradeRisk = token.slice("--risk=".length) as "patch" | "minor" | "major" | "all";
    } else if (token === "--dev") {
      args.upgradeDev = true;
    } else if (token === "--command") {
      i++;
      args.historyCommand = tokens[i];
    } else if (token.startsWith("--command=")) {
      args.historyCommand = token.slice("--command=".length);
    } else if (token === "--since") {
      i++;
      args.historySince = tokens[i];
    } else if (token.startsWith("--since=")) {
      args.historySince = token.slice("--since=".length);
    } else if (token === "--status") {
      i++;
      args.historyStatus = tokens[i] as SessionStatus;
    } else if (token.startsWith("--status=")) {
      args.historyStatus = token.slice("--status=".length) as SessionStatus;
    } else if (token === "--export") {
      i++;
      args.historyExport = tokens[i];
    } else if (token.startsWith("--export=")) {
      args.historyExport = token.slice("--export=".length);
    } else if (token === "--split") {
      args.historySplit = true;
    } else if (token === "--provider") {
      i++;
      args.provider = tokens[i];
    } else if (token.startsWith("--provider=")) {
      args.provider = token.slice("--provider=".length);
    } else if (token === "--help" || token === "-h") {
      positionals.unshift("--help");
    } else if (token === "--version" || token === "-v") {
      positionals.unshift("--version");
    } else if (token.startsWith("-")) {
      positionals.push(token);
    } else {
      positionals.push(token);
    }

    i++;
  }

  if (positionals.length > 0) {
    args.command = positionals[0];
  }

  switch (args.command) {
    case "ask":
      if (positionals[1]) args.question = positionals[1];
      break;
    case "plan":
      if (positionals[1]) args.goal = positionals[1];
      break;
    case "patch":
      if (positionals[1]) args.description = positionals[1];
      break;
    case "config": {
      const sub = positionals[1];
      if (sub === "get" || sub === "set" || sub === "path" || sub === "init") {
        args.configSubcommand = sub;
        if (sub === "get" && positionals[2]) {
          args.configKey = positionals[2];
        } else if (sub === "set") {
          if (positionals[2]) args.configKey = positionals[2];
          if (positionals[3]) args.configValue = positionals[3];
        }
      }
      break;
    }
    case "db": {
      const sub = positionals[1];
      if (sub === "schema" || sub === "ask" || sub === "explain" || sub === "migrate") {
        args.dbSubcommand = sub;
        if (sub === "ask" && positionals[2]) {
          args.dbQuestion = positionals[2];
        } else if ((sub === "explain" || sub === "migrate") && positionals[2]) {
          args.dbDescription = positionals[2];
        }
      }
      break;
    }
    case "upgrade": {
      const sub = positionals[1];
      if (sub === "deps" || sub === "prisma") {
        args.upgradeSubcommand = sub;
      }
      break;
    }
    case "history": {
      if (positionals[1] === "search" && positionals[2]) {
        args.historySearch = positionals[2];
      }
      break;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate parsed arguments.
 * Calls process.exit(2) on invalid arguments.
 */
export function validateArgs(args: ParsedArgs): void {
  const fail = (message: string, command?: string): never => {
    console.error(pc.red(`Error: ${message}`));
    const usage = command ? COMMAND_USAGE[command] : GLOBAL_USAGE;
    if (usage) console.error(usage);
    process.exit(2);
  };

  const VALID_FORMATS = ['text', 'json', 'ndjson', 'plain'] as const;
  if (!VALID_FORMATS.includes(args.format as (typeof VALID_FORMATS)[number])) {
    fail(`--format must be one of: text, json, ndjson, plain. Got "${args.format}"`);
  }

  const VALID_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
  if (args.historyStatus && !VALID_STATUSES.includes(args.historyStatus as (typeof VALID_STATUSES)[number])) {
    fail(`--status must be one of: running, completed, failed, cancelled. Got "${args.historyStatus}"`);
  }

  if (
    args.maxTokens !== undefined &&
    (isNaN(args.maxTokens) || args.maxTokens <= 0)
  ) {
    fail("--max-tokens must be a positive integer", "ask");
  }

  if (args.depth !== undefined && (isNaN(args.depth) || args.depth <= 0)) {
    fail("--depth must be a positive integer", "explore");
  }

  if (args.limit !== undefined && (isNaN(args.limit) || args.limit <= 0)) {
    fail("--limit must be a positive integer", "history");
  }

  switch (args.command) {
    case "ask":
      if (!args.question) {
        fail("ask requires a <question> argument", "ask");
      }
      break;
    case "plan":
      if (!args.goal) {
        fail("plan requires a <goal> argument", "plan");
      }
      break;
    case "patch":
      if (!args.description) {
        fail("patch requires a <description> argument", "patch");
      }
      break;
    case "config":
      if (args.configSubcommand === "get" && !args.configKey) {
        fail("config get requires a <key> argument", "config");
      }
      if (
        args.configSubcommand === "set" &&
        (!args.configKey || args.configValue === undefined)
      ) {
        fail("config set requires <key> and <value> arguments", "config");
      }
      break;
    case "review":
    case "explore":
    case "history":
    case "doctor":
    case "db":
    case "upgrade":
    case null:
    case "--help":
    case "--version":
      break;
    default:
      if (args.command && !args.command.startsWith("-")) {
        fail(
          `Unknown command: "${args.command}". Run "aria --help" for available commands.`
        );
      }
      break;
  }
}
