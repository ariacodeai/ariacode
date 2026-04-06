/**
 * CLI argument parsing and validation — extracted for testability.
 * This module has no side effects and does not call process.exit directly.
 */

import pc from "picocolors";

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
  format: "text" | "json";
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

${pc.bold("GLOBAL OPTIONS:")}
  --dry-run             Preview changes without applying them
  --yes                 Skip confirmation prompts
  --session <id>        Resume or reference a session
  --quiet               Suppress non-essential output
  --format <text|json>  Output format (default: text)
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

${pc.bold("OPTIONS:")}
  --limit <n>           Limit number of results
  --session <id>        Show full log for a specific session
  --tree                Render tool execution tree
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
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an argv array into a typed ParsedArgs object.
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 2.8
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
      args.format = tokens[i] as "text" | "json";
    } else if (token.startsWith("--format=")) {
      args.format = token.slice("--format=".length) as "text" | "json";
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
  }

  return args;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate parsed arguments.
 * Calls process.exit(2) on invalid arguments.
 * Requirements: 2.5, 2.6
 */
export function validateArgs(args: ParsedArgs): void {
  const fail = (message: string, command?: string): never => {
    console.error(pc.red(`Error: ${message}`));
    const usage = command ? COMMAND_USAGE[command] : GLOBAL_USAGE;
    if (usage) console.error(usage);
    process.exit(2);
  };

  if (args.format !== "text" && args.format !== "json") {
    fail(`--format must be "text" or "json", got "${args.format}"`);
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
