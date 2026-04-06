/**
 * Command implementations for Aria Code CLI
 *
 * Each exported function corresponds to a CLI command and orchestrates:
 * - Configuration loading
 * - Project detection
 * - Session management
 * - Agent loop execution
 * - Terminal output
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { getConfig } from "./config.js";
import { detectProjectType } from "./repo.js";
import { createProvider, ProviderError } from "./provider.js";
import type { Provider } from "./provider.js";
import {
  initializeDatabase,
  createSession,
  updateSessionStatus,
  getSession,
  logMessage,
  listSessions,
} from "./storage.js";
import {
  readFileTool,
  listDirectoryTool,
  searchCodeTool,
  readPackageJsonTool,
  readPrismaSchemaTool,
  proposeDiffTool,
  applyDiffTool,
} from "./tools.js";
import { agentLoop, UserCancelledError } from "./agent.js";
import prompts from "prompts";
import {
  initUI,
  info,
  print,
  error as uiError,
  bold,
  yellow,
  green,
  dim,
  cyan,
  red,
  renderTable,
  generateAndRenderDiff,
  confirm,
  ConfirmCancelledError,
} from "./ui.js";
import { loadConfig, validateConfig, type ConfigSource } from "./config.js";
import type { Config } from "./config.js";
import type { ExecutionContext } from "./context.js";
import type { Tool } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Provider resolution with interactive setup
// ---------------------------------------------------------------------------

/**
 * Map of provider names to their required environment variable.
 * Ollama doesn't need an API key.
 */
const PROVIDER_ENV_KEYS: Record<string, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ollama: null,
};

/**
 * Default models per provider.
 */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  ollama: "llama3",
  openrouter: "anthropic/claude-sonnet-4-6",
};

/**
 * Check if the given provider has its API key available.
 */
function isProviderReady(providerName: string): boolean {
  const envKey = PROVIDER_ENV_KEYS[providerName];
  if (envKey === null) return true; // Ollama — no key needed
  return Boolean(envKey && process.env[envKey]);
}

/**
 * Interactively select a provider and configure its API key.
 *
 * Called when the configured provider's API key is missing.
 * Saves the key to the shell environment for the current process
 * and updates ~/.aria/config.toml with the chosen provider/model.
 *
 * Returns the created Provider instance and updates config in-place.
 */
async function resolveProvider(config: Config): Promise<Provider> {
  // 1. Try the configured provider first
  if (isProviderReady(config.provider.default)) {
    return createProvider(config.provider.default);
  }

  // 2. Check if any other provider is already configured via env
  for (const [name, envKey] of Object.entries(PROVIDER_ENV_KEYS)) {
    if (name === config.provider.default) continue;
    if (envKey === null || process.env[envKey]) {
      info(dim(`${config.provider.default} not configured, falling back to ${name}`));
      config.provider.default = name as typeof config.provider.default;
      config.provider.model = DEFAULT_MODELS[name] ?? config.provider.model;
      return createProvider(name);
    }
  }

  // 3. No provider ready — interactive setup
  info("");
  info(bold("No API key found. Let's set up a provider."));
  info("");

  const providerChoices = [
    { title: "Anthropic (Claude)", value: "anthropic", description: "Requires ANTHROPIC_API_KEY" },
    { title: "OpenAI (GPT)", value: "openai", description: "Requires OPENAI_API_KEY" },
    { title: "OpenRouter", value: "openrouter", description: "Requires OPENROUTER_API_KEY" },
    { title: "Ollama (local)", value: "ollama", description: "No API key needed, runs locally" },
  ];

  const { provider: selectedProvider } = await prompts({
    type: "select",
    name: "provider",
    message: "Choose a provider",
    choices: providerChoices,
  }, {
    onCancel: () => {
      throw new ConfirmCancelledError();
    },
  });

  if (!selectedProvider) {
    throw new ConfirmCancelledError();
  }

  const envKey = PROVIDER_ENV_KEYS[selectedProvider];

  // Ollama — no key needed, just check URL
  if (envKey === null) {
    const { baseUrl } = await prompts({
      type: "text",
      name: "baseUrl",
      message: "Ollama base URL",
      initial: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    }, {
      onCancel: () => { throw new ConfirmCancelledError(); },
    });

    if (baseUrl && baseUrl !== "http://localhost:11434") {
      process.env.OLLAMA_BASE_URL = baseUrl;
    }

    config.provider.default = "ollama";
    config.provider.model = DEFAULT_MODELS.ollama;
    saveProviderChoice(config);
    return createProvider("ollama");
  }

  // API key providers — prompt for key
  const { apiKey } = await prompts({
    type: "password",
    name: "apiKey",
    message: `Enter your ${envKey}`,
  }, {
    onCancel: () => { throw new ConfirmCancelledError(); },
  });

  if (!apiKey) {
    throw new ProviderError(`${envKey} is required for ${selectedProvider}`, selectedProvider);
  }

  // Set in current process environment
  process.env[envKey] = apiKey;

  // Update config
  config.provider.default = selectedProvider as typeof config.provider.default;
  config.provider.model = DEFAULT_MODELS[selectedProvider] ?? config.provider.model;

  // Save choice to ~/.aria/config.toml
  saveProviderChoice(config);

  // Offer to save the key to shell profile
  const { saveKey } = await prompts({
    type: "confirm",
    name: "saveKey",
    message: `Save ${envKey} to ~/.zshrc for future sessions?`,
    initial: true,
  }, {
    onCancel: () => { /* non-fatal, just skip */ },
  });

  if (saveKey) {
    const shellRc = path.join(os.homedir(), ".zshrc");
    const exportLine = `\nexport ${envKey}="${apiKey}"\n`;
    try {
      const existing = existsSync(shellRc) ? readFileSync(shellRc, "utf-8") : "";
      if (!existing.includes(envKey)) {
        writeFileSync(shellRc, existing + exportLine, "utf-8");
        info(green(`✓ Added ${envKey} to ~/.zshrc`));
        info(dim("  Run `source ~/.zshrc` or open a new terminal to apply."));
      } else {
        info(dim(`${envKey} already exists in ~/.zshrc, skipping.`));
      }
    } catch {
      info(yellow(`Could not write to ~/.zshrc. Set ${envKey} manually.`));
    }
  }

  return createProvider(selectedProvider);
}

/**
 * Save the provider/model choice to ~/.aria/config.toml
 */
function saveProviderChoice(config: Config): void {
  try {
    const configPath = path.join(os.homedir(), ".aria", "config.toml");
    if (existsSync(configPath)) {
      let content = readFileSync(configPath, "utf-8");
      // Update provider default and model lines
      content = content.replace(
        /^default\s*=\s*".*"/m,
        `default = "${config.provider.default}"`,
      );
      content = content.replace(
        /^model\s*=\s*".*"/m,
        `model = "${config.provider.model}"`,
      );
      writeFileSync(configPath, content, { encoding: "utf-8", mode: 0o600 });
      info(dim(`Updated ~/.aria/config.toml with provider: ${config.provider.default}`));
    }
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Read-only tool set for ask / plan commands
// ---------------------------------------------------------------------------

/**
 * The five read-only tools exposed to the ask command.
 * Requirements: 9.4
 */
const READ_ONLY_TOOLS: Tool[] = [
  readFileTool,
  listDirectoryTool,
  searchCodeTool,
  readPackageJsonTool,
  readPrismaSchemaTool,
];

// ---------------------------------------------------------------------------
// System prompt builder (shared across all commands)
// ---------------------------------------------------------------------------

/**
 * Default fallback templates when prompt files are missing.
 */
const FALLBACK_TEMPLATES: Record<string, string> = {
  ask: [
    "You are Aria Code, a coding assistant for {{projectType}} projects.",
    "",
    "Project: {{projectRoot}}",
    "Framework: {{frameworkInfo}}",
    "Has Prisma: {{hasPrisma}}",
    "",
    "You are in read-only mode. Do NOT propose or apply any file changes.",
    "Answer the user's question using the available read-only tools.",
  ].join("\n"),
  plan: [
    "You are Aria Code, a planning assistant for {{projectType}} projects.",
    "",
    "Project: {{projectRoot}}",
    "Framework: {{frameworkInfo}}",
    "Has Prisma: {{hasPrisma}}",
    "",
    "You are in read-only mode. Do NOT propose or apply any file changes.",
    "Generate a structured implementation plan for the user's goal.",
    "Include: ordered steps, affected files, risks, and implementation notes.",
  ].join("\n"),
  patch: [
    "You are Aria Code, a coding agent for {{projectType}} projects.",
    "",
    "Project: {{projectRoot}}",
    "Framework: {{frameworkInfo}}",
    "Has Prisma: {{hasPrisma}}",
    "",
    "Analyze the repository, then use propose_diff to generate changes.",
    "After proposing, use apply_diff to apply the changes if confirmed.",
    "Be precise and minimal — only change what is necessary.",
  ].join("\n"),
  review: [
    "You are Aria Code, a code review assistant for {{projectType}} projects.",
    "",
    "Project: {{projectRoot}}",
    "Framework: {{frameworkInfo}}",
    "Has Prisma: {{hasPrisma}}",
    "",
    "You are in read-only mode. Analyze the provided diff and return a structured review.",
    "",
    "Return your review using this format:",
    "",
    "# Code Review",
    "",
    "## Summary",
    "(brief overview of what the diff does)",
    "",
    "## Issues",
    "- [HIGH] (critical bugs, security vulnerabilities, data loss risks)",
    "- [MEDIUM] (logic errors, missing error handling, performance concerns)",
    "- [LOW] (style inconsistencies, minor improvements)",
    "",
    "## Suggestions",
    "- (non-blocking improvements or alternatives to consider)",
  ].join("\n"),
  explore: [
    "You are Aria Code, a repository exploration assistant.",
    "",
    "Project: {{projectRoot}}",
    "",
    "Scan the repository structure, detect frameworks, identify entry points,",
    "and summarize the architecture.",
    "",
    "Use the available read-only tools:",
    "- list_directory: Scan directory structure (respect .gitignore)",
    "- read_file: Read key configuration and source files",
    "- search_code: Search for patterns, exports, and entry points",
    "- read_package_json: Detect dependencies and scripts",
    "- read_prisma_schema: Read Prisma schema (when available)",
    "",
    "Return your findings in a structured markdown format covering:",
    "Project Type, Key Files, Entry Points, Structure, and Notable Patterns.",
  ].join("\n"),
};

/**
 * Build a system prompt from a template file with project context interpolation.
 *
 * Loads the template from src/prompts/{templateName}.md, falls back to a
 * built-in default if the file is missing, then replaces standard variables.
 *
 * @param templateName - Name of the template (ask, plan, patch, review, explore)
 * @param ctx - Execution context
 * @param extraVars - Additional template variables to replace (e.g. {{userGoal}})
 */
function buildSystemPrompt(
  templateName: string,
  ctx: ExecutionContext,
  extraVars: Record<string, string> = {},
): string {
  const templatePath = path.join(__dirname, "prompts", `${templateName}.md`);
  let template: string;
  try {
    template = readFileSync(templatePath, "utf-8");
  } catch {
    template = FALLBACK_TEMPLATES[templateName] ?? "";
  }

  const project = detectProjectType(ctx.projectRoot);

  const frameworkInfo = project.framework
    ? `${project.framework.name}${project.framework.version ? ` ${project.framework.version}` : ""}${project.framework.router ? ` (${project.framework.router} router)` : ""}`
    : "none";

  let result = template
    .replace(/\{\{projectType\}\}/g, project.type)
    .replace(/\{\{projectRoot\}\}/g, ctx.projectRoot)
    .replace(/\{\{frameworkInfo\}\}/g, frameworkInfo)
    .replace(/\{\{hasPrisma\}\}/g, project.hasPrisma ? "yes" : "no");

  for (const [key, value] of Object.entries(extraVars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  return result;
}

// ---------------------------------------------------------------------------
// ask command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the ask command.
 */
export interface AskOptions {
  /** The question to ask (required) */
  question: string;
  /** Resume an existing session by ID */
  session?: string;
  /** Override max tokens for this invocation */
  maxTokens?: number;
  /** Suppress non-essential output */
  quiet?: boolean;
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * Execute the ask command.
 *
 * Flow:
 * 1. Load configuration and detect project type          (Req 9.1)
 * 2. Create or resume session with mode: "plan"          (Req 9.2, 9.9)
 * 3. Build system prompt from ask.md template            (Req 9.3)
 * 4. Expose only read-only tools                         (Req 9.4)
 * 5. Execute agent loop                                  (Req 9.5, 9.6)
 * 6. Render response to terminal                         (Req 9.7)
 * 7. Persist session to database                         (Req 9.8)
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9
 */
export async function runAsk(options: AskOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // 1. Load configuration (Req 9.1)
  const config = getConfig(projectRoot, {
    quiet: options.quiet,
    maxTokens: options.maxTokens,
  });

  // Initialize UI with config settings
  initUI(config.ui.color, config.ui.quiet);

  // Detect project type early to fail fast if package.json is missing (Req 9.1)
  detectProjectType(projectRoot);

  // 2. Initialize database and create/resume session (Req 9.2, 9.8, 9.9)
  const db = initializeDatabase();

  let sessionId: string;
  let resumedMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  if (options.session) {
    // Resume existing session (Req 9.9)
    const existing = getSession(db, options.session);
    if (!existing) {
      uiError(`Session not found: ${options.session}`);
      process.exit(1);
    }
    sessionId = existing.id;
    info(`Resuming session ${sessionId}`);

    // Load previous messages for context
    const rows = db
      .prepare(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<{ role: "user" | "assistant" | "system"; content: string }>;
    resumedMessages = rows;
  } else {
    // Create new session (Req 9.2)
    sessionId = randomUUID();
    createSession(db, {
      id: sessionId,
      command: "ask",
      projectRoot,
      provider: config.provider.default,
      model: config.provider.model,
    });
  }

  // 3. Resolve provider (interactive setup if needed)
  let provider: Provider;
  try {
    provider = await resolveProvider(config);
  } catch (err) {
    if (err instanceof ConfirmCancelledError) {
      info(yellow("Setup cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }
    uiError(err instanceof Error ? err.message : String(err));
    updateSessionStatus(db, sessionId, "failed", String(err));
    process.exit(4);
  }

  // 4. Build execution context with mode: "plan" (Req 9.2)
  const ctx: ExecutionContext = {
    projectRoot,
    sessionId,
    provider: config.provider.default,
    model: config.provider.model,
    mode: "plan",          // ask is always read-only
    dryRun: false,
    assumeYes: false,
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  // Override maxTokens if provided via flag
  if (options.maxTokens !== undefined) {
    config.provider.maxTokens = options.maxTokens;
  }

  // 5. Build system prompt from ask.md template (Req 9.3)
  const systemPrompt = buildSystemPrompt("ask", ctx);

  // Log system prompt as a system message
  logMessage(db, sessionId, "system", systemPrompt);

  // Prepend system prompt to the message array that agentLoop will use.
  // agentLoop builds its own messages array starting with system + user,
  // so we pass the question as the userRequest and let it handle the rest.
  // For session resumption, we inject prior messages via the question context.
  let userRequest = options.question;

  if (resumedMessages.length > 0) {
    // Summarise prior context so the model has continuity
    const priorContext = resumedMessages
      .filter((m) => m.role !== "system")
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");
    userRequest = `[Resumed session context]\n${priorContext}\n\n[New question]: ${options.question}`;
  }

  // 6. Execute agent loop (Req 9.5, 9.6)
  // agentLoop streams the response to stdout as it arrives (Req 9.7)
  try {
    await agentLoop(
      ctx,
      userRequest,
      READ_ONLY_TOOLS,
      provider,
      config,
      "ask",
      db,
      systemPrompt
    );

    // 7. Mark session as completed (Req 9.8)
    updateSessionStatus(db, sessionId, "completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    uiError(message);
    updateSessionStatus(db, sessionId, "failed", message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// plan command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the plan command.
 */
export interface PlanOptions {
  /** The implementation goal (required) */
  goal: string;
  /** Resume an existing session by ID */
  session?: string;
  /** Save plan as markdown file at specified path */
  output?: string;
  /** Suppress non-essential output */
  quiet?: boolean;
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * Execute the plan command.
 *
 * Flow:
 * 1. Load configuration and detect project type          (Req 10.1)
 * 2. Create or resume session with mode: "plan"          (Req 10.2, 10.8)
 * 3. Build system prompt from plan.md template           (Req 10.3)
 * 4. Expose only read-only tools                         (Req 10.4)
 * 5. Execute agent loop                                  (Req 10.5)
 * 6. Render structured plan to terminal                  (Req 10.6)
 * 7. Save to file if --output flag provided              (Req 10.7)
 * 8. Persist session to database                         (Req 10.8)
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8
 */
export async function runPlan(options: PlanOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // 1. Load configuration (Req 10.1)
  const config = getConfig(projectRoot, {
    quiet: options.quiet,
  });

  // Initialize UI with config settings
  initUI(config.ui.color, config.ui.quiet);

  // Detect project type early to fail fast if package.json is missing (Req 10.1)
  detectProjectType(projectRoot);

  // 2. Initialize database and create/resume session (Req 10.2, 10.8)
  const db = initializeDatabase();

  let sessionId: string;
  let resumedMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];

  if (options.session) {
    // Resume existing session (Req 10.8)
    const existing = getSession(db, options.session);
    if (!existing) {
      uiError(`Session not found: ${options.session}`);
      process.exit(1);
    }
    sessionId = existing.id;
    info(`Resuming session ${sessionId}`);

    // Load previous messages for context
    const rows = db
      .prepare(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<{ role: "user" | "assistant" | "system"; content: string }>;
    resumedMessages = rows;
  } else {
    // Create new session (Req 10.2)
    sessionId = randomUUID();
    createSession(db, {
      id: sessionId,
      command: "plan",
      projectRoot,
      provider: config.provider.default,
      model: config.provider.model,
    });
  }

  // 3. Resolve provider (interactive setup if needed)
  let provider: Provider;
  try {
    provider = await resolveProvider(config);
  } catch (err) {
    if (err instanceof ConfirmCancelledError) {
      info(yellow("Setup cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }
    uiError(err instanceof Error ? err.message : String(err));
    updateSessionStatus(db, sessionId, "failed", String(err));
    process.exit(4);
  }

  // 4. Build execution context with mode: "plan" (Req 10.2)
  const ctx: ExecutionContext = {
    projectRoot,
    sessionId,
    provider: config.provider.default,
    model: config.provider.model,
    mode: "plan",          // plan is always read-only
    dryRun: false,
    assumeYes: false,
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  // 5. Build system prompt from plan.md template (Req 10.3)
  const systemPrompt = buildSystemPrompt("plan", ctx, { userGoal: options.goal });

  // Log system prompt as a system message
  logMessage(db, sessionId, "system", systemPrompt);

  // Build user request, incorporating prior session context if resuming
  let userRequest = options.goal;

  if (resumedMessages.length > 0) {
    // Summarise prior context so the model has continuity
    const priorContext = resumedMessages
      .filter((m) => m.role !== "system")
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");
    userRequest = `[Resumed session context]\n${priorContext}\n\n[New goal]: ${options.goal}`;
  }

  // 6. Execute agent loop — streams response to stdout (Req 10.5, 10.6)
  try {
    const planContent = await agentLoop(
      ctx,
      userRequest,
      READ_ONLY_TOOLS,
      provider,
      config,
      "plan",
      db,
      systemPrompt
    );

    // 7. Save to file if --output flag provided (Req 10.7)
    if (options.output) {
      const outputPath = path.resolve(options.output);
      const outputDir = path.dirname(outputPath);

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      writeFileSync(outputPath, planContent, "utf-8");
      info(`Plan saved to ${options.output}`);
    }

    // 8. Mark session as completed (Req 10.8)
    updateSessionStatus(db, sessionId, "completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    uiError(message);
    updateSessionStatus(db, sessionId, "failed", message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// patch command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the patch command.
 */
export interface PatchOptions {
  /** Description of the changes to make (required) */
  description: string;
  /** Preview changes without applying them */
  dryRun?: boolean;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Resume an existing session by ID */
  session?: string;
  /** Suppress non-essential output */
  quiet?: boolean;
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * Execute the patch command.
 *
 * Flow:
 * 1. Load configuration and detect project type          (Req 11.1)
 * 2. Create session with mode: "build"                   (Req 11.2)
 * 3. Build system prompt from patch.md template          (Req 11.3)
 * 4. Expose read-only + mutation tools                   (Req 11.4)
 * 5. Execute agent loop — agent calls propose_diff       (Req 11.4, 11.5)
 * 6. Render diff preview with syntax highlighting        (Req 11.6)
 * 7. Render mutation summary                             (Req 11.7)
 * 8. If --dry-run, exit with code 0                      (Req 11.8, 17.3, 17.4)
 * 9. If not --yes, prompt for confirmation               (Req 11.9, 17.5)
 * 10. Agent calls apply_diff atomically                  (Req 11.10, 11.11, 11.12)
 * 11. Log mutation to database                           (Req 11.11)
 * 12. Display rollback hints                             (Req 11.12, 17.9)
 * 13. Persist session to database                        (Req 11.13)
 *
 * Requirements: 11.1–11.13, 17.1–17.9
 */
export async function runPatch(options: PatchOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // 1. Load configuration (Req 11.1)
  const config = getConfig(projectRoot, {
    quiet: options.quiet,
  });

  // Apply flag overrides to config
  if (options.dryRun) config.agent.mode = "build"; // keep build mode, dryRun handled via ctx

  // Initialize UI with config settings
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  // Detect project type early to fail fast (Req 11.1)
  detectProjectType(projectRoot);

  // 2. Initialize database and create session (Req 11.13)
  const db = initializeDatabase();

  let sessionId: string;

  if (options.session) {
    const existing = getSession(db, options.session);
    if (!existing) {
      uiError(`Session not found: ${options.session}`);
      process.exit(1);
    }
    sessionId = existing.id;
    info(`Resuming session ${sessionId}`);
  } else {
    sessionId = randomUUID();
    createSession(db, {
      id: sessionId,
      command: "patch",
      projectRoot,
      provider: config.provider.default,
      model: config.provider.model,
    });
  }

  // 3. Resolve provider (interactive setup if needed)
  let provider: Provider;
  try {
    provider = await resolveProvider(config);
  } catch (err) {
    if (err instanceof ConfirmCancelledError) {
      info(yellow("Setup cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }
    uiError(err instanceof Error ? err.message : String(err));
    updateSessionStatus(db, sessionId, "failed", String(err));
    process.exit(4);
  }

  // 4. Build execution context with mode: "build" (Req 11.2, 17.1, 17.2)
  const ctx: ExecutionContext = {
    projectRoot,
    sessionId,
    provider: config.provider.default,
    model: config.provider.model,
    mode: "build",
    dryRun: Boolean(options.dryRun),
    assumeYes: Boolean(options.yes),
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  // 5. Build system prompt from patch.md template (Req 11.3)
  const systemPrompt = buildSystemPrompt("patch", ctx);
  logMessage(db, sessionId, "system", systemPrompt);

  // Expose read-only tools + mutation tools (Req 11.4)
  const patchTools: Tool[] = [
    readFileTool,
    listDirectoryTool,
    searchCodeTool,
    readPackageJsonTool,
    readPrismaSchemaTool,
    proposeDiffTool,
    applyDiffTool,
  ];

  if (options.dryRun) {
    info(bold("Dry-run mode — changes will be previewed but not applied."));
  }

  // 6. Execute agent loop (Req 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10)
  // The agent loop handles:
  //   - propose_diff: generates diff + MutationSummary (Req 11.4, 11.5)
  //   - dry-run enforcement: skips apply_diff (Req 11.8, 17.3, 17.4)
  //   - confirmation prompt before apply_diff (Req 11.9, 17.5, 17.6)
  //   - atomic application via apply_diff (Req 11.10, 11.11, 11.12)
  try {
    await agentLoop(
      ctx,
      options.description,
      patchTools,
      provider,
      config,
      "patch",
      db,
      systemPrompt
    );

    // 12. Display rollback hints after successful application (Req 11.12, 17.9)
    // The agent loop streams the response which includes rollback hints from
    // the apply_diff result. We add a final summary line here.
    if (!options.dryRun) {
      info("");
      info(green("✓ Patch applied successfully."));
      info(dim("Tip: use `git diff HEAD` to review changes, or `git checkout -- .` to revert."));
    } else {
      info("");
      info(yellow("Dry-run complete — no files were modified."));
    }

    // 13. Mark session as completed (Req 11.13)
    updateSessionStatus(db, sessionId, "completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Handle user cancellation (Req 17.6, exit code 130)
    if (err instanceof UserCancelledError || err instanceof ConfirmCancelledError) {
      info("");
      info(yellow("Operation cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }

    uiError(message);
    updateSessionStatus(db, sessionId, "failed", message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// review command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the review command.
 */
export interface ReviewOptions {
  /** Read unstaged changes instead of staged */
  unstaged?: boolean;
  /** Compare current branch to specified base branch */
  branch?: string;
  /** Output format: "text" (default) or "json" */
  format?: "text" | "json";
  /** Suppress non-essential output */
  quiet?: boolean;
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * Structured review returned by the provider.
 */
export interface ReviewResult {
  summary: string;
  issues: Array<{ severity: "HIGH" | "MEDIUM" | "LOW"; description: string }>;
  suggestions: string[];
}

/**
 * Read git diff based on the provided options.
 *
 * - Default: staged changes (`git diff --cached`)
 * - --unstaged: unstaged changes (`git diff`)
 * - --branch <base>: compare to base branch (`git diff <base>...HEAD`)
 *
 * Requirements: 12.3, 12.4, 12.5
 */
function readGitDiff(options: ReviewOptions, projectRoot: string): string {
  try {
    let args: string[];

    if (options.branch) {
      // Compare current branch to specified base (Req 12.5)
      args = ["diff", `${options.branch}...HEAD`];
    } else if (options.unstaged) {
      // Unstaged changes (Req 12.4)
      args = ["diff"];
    } else {
      // Staged changes — default (Req 12.3)
      args = ["diff", "--cached"];
    }

    const output = execFileSync("git", args, {
      encoding: "utf-8",
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });

    return output;
  } catch (err) {
    throw new Error(
      `Failed to read git diff: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Parse the structured review from the provider's markdown response.
 *
 * Extracts summary, issues (with severity), and suggestions from the
 * "# Code Review" markdown format defined in review.md.
 *
 * Requirements: 12.7
 */
function parseReviewResponse(content: string): ReviewResult {
  const result: ReviewResult = {
    summary: "",
    issues: [],
    suggestions: [],
  };

  // Extract Summary section
  const summaryMatch = content.match(/##\s+Summary\s*\n([\s\S]*?)(?=\n##|\s*$)/i);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  // Extract Issues section
  const issuesMatch = content.match(/##\s+Issues\s*\n([\s\S]*?)(?=\n##|\s*$)/i);
  if (issuesMatch) {
    const issuesText = issuesMatch[1];
    const issueLines = issuesText.split("\n").filter((l) => l.trim().startsWith("-"));
    for (const line of issueLines) {
      const severityMatch = line.match(/\[(HIGH|MEDIUM|LOW)\]\s*(.*)/i);
      if (severityMatch) {
        result.issues.push({
          severity: severityMatch[1].toUpperCase() as "HIGH" | "MEDIUM" | "LOW",
          description: severityMatch[2].trim(),
        });
      } else {
        // Issue without explicit severity tag — treat as LOW
        const text = line.replace(/^-\s*/, "").trim();
        if (text) {
          result.issues.push({ severity: "LOW", description: text });
        }
      }
    }
  }

  // Extract Suggestions section
  const suggestionsMatch = content.match(/##\s+Suggestions\s*\n([\s\S]*?)(?=\n##|\s*$)/i);
  if (suggestionsMatch) {
    const suggestionsText = suggestionsMatch[1];
    const suggestionLines = suggestionsText
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter(Boolean);
    result.suggestions = suggestionLines;
  }

  return result;
}

/**
 * Render the structured review to the terminal in readable format.
 *
 * Requirements: 12.8
 */
function renderReview(review: ReviewResult): void {
  info("");
  info(bold("# Code Review"));
  info("");

  info(bold("## Summary"));
  info(review.summary || "(no summary provided)");
  info("");

  info(bold("## Issues"));
  if (review.issues.length === 0) {
    info(green("  No issues found."));
  } else {
    for (const issue of review.issues) {
      const severityLabel =
        issue.severity === "HIGH"
          ? red(`[HIGH]`)
          : issue.severity === "MEDIUM"
          ? yellow(`[MEDIUM]`)
          : cyan(`[LOW]`);
      info(`  - ${severityLabel} ${issue.description}`);
    }
  }
  info("");

  info(bold("## Suggestions"));
  if (review.suggestions.length === 0) {
    info(dim("  No suggestions."));
  } else {
    for (const suggestion of review.suggestions) {
      info(`  - ${suggestion}`);
    }
  }
  info("");
}

/**
 * Execute the review command.
 *
 * Flow:
 * 1. Parse flags and load configuration                  (Req 12.1)
 * 2. Detect project type                                 (Req 12.1)
 * 3. Create session with mode: "plan"                    (Req 12.2)
 * 4. Read git diff (staged / unstaged / branch)          (Req 12.3, 12.4, 12.5)
 * 5. Build system prompt from review.md template         (Req 12.6)
 * 6. Send diff + project context to provider             (Req 12.6)
 * 7. Parse structured review (summary, issues, suggestions) (Req 12.7)
 * 8. Render review to terminal                           (Req 12.8)
 * 9. Output JSON if --format json                        (Req 12.9)
 * 10. Persist session to database                        (Req 12.10)
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10
 */
export async function runReview(options: ReviewOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // 1. Load configuration (Req 12.1)
  const config = getConfig(projectRoot, {
    quiet: options.quiet,
  });

  // Initialize UI with config settings
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  // 2. Detect project type early to fail fast (Req 12.1)
  detectProjectType(projectRoot);

  // 3. Initialize database and create session (Req 12.10)
  const db = initializeDatabase();
  const sessionId = randomUUID();

  createSession(db, {
    id: sessionId,
    command: "review",
    projectRoot,
    provider: config.provider.default,
    model: config.provider.model,
  });

  // Resolve provider (interactive setup if needed)
  let provider: Provider;
  try {
    provider = await resolveProvider(config);
  } catch (err) {
    if (err instanceof ConfirmCancelledError) {
      info(yellow("Setup cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }
    uiError(err instanceof Error ? err.message : String(err));
    updateSessionStatus(db, sessionId, "failed", String(err));
    process.exit(4);
  }

  // Build execution context with mode: "plan" (Req 12.2)
  const ctx: ExecutionContext = {
    projectRoot,
    sessionId,
    provider: config.provider.default,
    model: config.provider.model,
    mode: "plan",   // review is always read-only
    dryRun: false,
    assumeYes: false,
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  // 4. Read git diff (Req 12.3, 12.4, 12.5)
  let diff: string;
  try {
    diff = readGitDiff(options, projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    uiError(message);
    updateSessionStatus(db, sessionId, "failed", message);
    process.exit(1);
  }

  if (!diff.trim()) {
    const diffSource = options.branch
      ? `branch diff against ${options.branch}`
      : options.unstaged
      ? "unstaged changes"
      : "staged changes";
    info(`No ${diffSource} found. Nothing to review.`);
    updateSessionStatus(db, sessionId, "completed");
    return;
  }

  // 5. Build system prompt from review.md template (Req 12.6)
  const systemPrompt = buildSystemPrompt("review", ctx);
  logMessage(db, sessionId, "system", systemPrompt);

  // 6. Build user request: diff + project context (Req 12.6)
  const project = detectProjectType(projectRoot);
  const diffSource = options.branch
    ? `branch diff (current vs ${options.branch})`
    : options.unstaged
    ? "unstaged changes"
    : "staged changes";

  const userRequest = [
    `Please review the following git diff (${diffSource}).`,
    "",
    `Project type: ${project.type}`,
    project.framework ? `Framework: ${project.framework.name}` : null,
    `Has Prisma: ${project.hasPrisma ? "yes" : "no"}`,
    "",
    "```diff",
    diff,
    "```",
  ]
    .filter((l) => l !== null)
    .join("\n");

  // Execute agent loop — streams response to stdout (Req 12.6, 12.7, 12.8)
  try {
    const reviewContent = await agentLoop(
      ctx,
      userRequest,
      READ_ONLY_TOOLS,
      provider,
      config,
      "review",
      db,
      systemPrompt
    );

    // 7. Parse structured review (Req 12.7)
    const review = parseReviewResponse(reviewContent);

    // 8 & 9. Render or output JSON (Req 12.8, 12.9)
    if (options.format === "json") {
      // JSON output to stdout (Req 12.9)
      process.stdout.write(JSON.stringify(review, null, 2) + "\n");
    } else {
      // Render to terminal in readable format (Req 12.8)
      // Note: agentLoop already streamed the raw response; renderReview
      // provides a structured re-render for clarity.
      renderReview(review);
    }

    // 10. Mark session as completed (Req 12.10)
    updateSessionStatus(db, sessionId, "completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Handle user cancellation (exit code 130)
    if (err instanceof UserCancelledError || err instanceof ConfirmCancelledError) {
      info("");
      info(yellow("Operation cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }

    uiError(message);
    updateSessionStatus(db, sessionId, "failed", message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// explore command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the explore command.
 */
export interface ExploreOptions {
  /** Limit directory traversal depth */
  depth?: number;
  /** Save exploration summary to ./.aria/explore.md */
  save?: boolean;
  /** Suppress non-essential output */
  quiet?: boolean;
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * Execute the explore command.
 *
 * Flow:
 * 1. Parse flags and load configuration                  (Req 13.1)
 * 2. Detect project type                                 (Req 13.1)
 * 3. Create session with mode: "plan"                    (Req 13.2)
 * 4. Scan repository structure respecting .gitignore     (Req 13.3)
 * 5. Detect frameworks and key configuration files       (Req 13.4)
 * 6. Identify entry points based on project type         (Req 13.5)
 * 7. Build system prompt from explore.md template        (Req 13.3–13.6)
 * 8. Execute agent loop to summarize structure/patterns  (Req 13.6)
 * 9. Render exploration summary to terminal              (Req 13.7)
 * 10. Save to ./.aria/explore.md if --save flag          (Req 13.8)
 * 11. Persist session to database                        (Req 13.10)
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10
 */
export async function runExplore(options: ExploreOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // 1. Load configuration (Req 13.1)
  const config = getConfig(projectRoot, {
    quiet: options.quiet,
  });

  // Initialize UI with config settings
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  // Detect project type early to fail fast (Req 13.1)
  const project = detectProjectType(projectRoot);

  // 2. Initialize database and create session (Req 13.10)
  const db = initializeDatabase();
  const sessionId = randomUUID();

  createSession(db, {
    id: sessionId,
    command: "explore",
    projectRoot,
    provider: config.provider.default,
    model: config.provider.model,
  });

  // 3. Resolve provider (interactive setup if needed)
  let provider: Provider;
  try {
    provider = await resolveProvider(config);
  } catch (err) {
    if (err instanceof ConfirmCancelledError) {
      info(yellow("Setup cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }
    uiError(err instanceof Error ? err.message : String(err));
    updateSessionStatus(db, sessionId, "failed", String(err));
    process.exit(4);
  }

  // 4. Build execution context with mode: "plan" (Req 13.2)
  const ctx: ExecutionContext = {
    projectRoot,
    sessionId,
    provider: config.provider.default,
    model: config.provider.model,
    mode: "plan",   // explore is always read-only
    dryRun: false,
    assumeYes: false,
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  // 5. Build system prompt from explore.md template (Req 13.3–13.6)
  const systemPrompt = buildSystemPrompt("explore", ctx);
  logMessage(db, sessionId, "system", systemPrompt);

  // 6. Build user request with project context and depth hint (Req 13.9)
  const frameworkInfo = project.framework
    ? `${project.framework.name}${project.framework.version ? ` ${project.framework.version}` : ""}${project.framework.router ? ` (${project.framework.router} router)` : ""}`
    : "none";

  const depthInstruction = options.depth !== undefined
    ? `Limit directory traversal to a maximum depth of ${options.depth}.`
    : "Use a reasonable depth to cover the top-level structure.";

  const userRequest = [
    `Explore this ${project.type} repository and produce a structured summary.`,
    "",
    `Project root: ${projectRoot}`,
    `Project type: ${project.type}`,
    `Framework: ${frameworkInfo}`,
    `Has Prisma: ${project.hasPrisma ? "yes" : "no"}`,
    project.packageManager ? `Package manager: ${project.packageManager}` : null,
    "",
    depthInstruction,
    "",
    "Use list_directory, read_file, search_code, and read_package_json to scan the",
    "repository. Identify entry points, key configuration files, and notable patterns.",
    "Return your findings in the structured markdown format defined in your instructions.",
  ]
    .filter((l) => l !== null)
    .join("\n");

  // 7. Execute agent loop — streams response to stdout (Req 13.6, 13.7)
  try {
    const exploreContent = await agentLoop(
      ctx,
      userRequest,
      READ_ONLY_TOOLS,
      provider,
      config,
      "explore",
      db,
      systemPrompt
    );

    // 8. Save to ./.aria/explore.md if --save flag provided (Req 13.8)
    if (options.save) {
      const ariaDir = path.join(projectRoot, ".aria");
      const savePath = path.join(ariaDir, "explore.md");

      if (!existsSync(ariaDir)) {
        mkdirSync(ariaDir, { recursive: true });
      }

      writeFileSync(savePath, exploreContent, "utf-8");
      info(`Exploration summary saved to .aria/explore.md`);
    }

    // 9. Mark session as completed (Req 13.10)
    updateSessionStatus(db, sessionId, "completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof UserCancelledError || err instanceof ConfirmCancelledError) {
      info("");
      info(yellow("Operation cancelled."));
      updateSessionStatus(db, sessionId, "cancelled");
      process.exit(130);
    }

    uiError(message);
    updateSessionStatus(db, sessionId, "failed", message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// history command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the history command.
 */
export interface HistoryOptions {
  /** Limit number of sessions listed */
  limit?: number;
  /** Show full log for a specific session ID */
  session?: string;
  /** Render tool execution tree */
  tree?: boolean;
  /** Suppress non-essential output */
  quiet?: boolean;
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * Format a SQLite timestamp string into a human-readable relative time.
 * e.g. "2 hours ago", "3 days ago", "just now"
 *
 * Requirements: 14.7
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp.endsWith("Z") ? timestamp : timestamp + "Z");
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60);
    return `${m} minute${m !== 1 ? "s" : ""} ago`;
  }
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600);
    return `${h} hour${h !== 1 ? "s" : ""} ago`;
  }
  if (diffSec < 86400 * 30) {
    const d = Math.floor(diffSec / 86400);
    return `${d} day${d !== 1 ? "s" : ""} ago`;
  }
  // Fall back to locale date string for older entries
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Colorize a session status string.
 */
function colorizeStatus(status: string): string {
  switch (status) {
    case "completed":
      return green(status);
    case "failed":
      return red(status);
    case "cancelled":
      return yellow(status);
    case "running":
      return cyan(status);
    default:
      return status;
  }
}

/**
 * Render a tool execution tree for a session.
 * Shows tool calls in chronological order with input/output summaries.
 *
 * Requirements: 14.6
 */
function renderToolTree(
  db: import("better-sqlite3").Database,
  sessionId: string
): void {
  const executions = db
    .prepare(
      `SELECT tool_name, input, output, error, created_at
       FROM tool_executions
       WHERE session_id = ?
       ORDER BY created_at ASC`
    )
    .all(sessionId) as Array<{
      tool_name: string;
      input: string;
      output: string | null;
      error: string | null;
      created_at: string;
    }>;

  if (executions.length === 0) {
    info(dim("  (no tool executions recorded)"));
    return;
  }

  for (let i = 0; i < executions.length; i++) {
    const exec = executions[i];
    const isLast = i === executions.length - 1;
    const prefix = isLast ? "└─" : "├─";
    const childPrefix = isLast ? "   " : "│  ";

    const statusIcon = exec.error ? red("✗") : green("✓");
    info(`  ${prefix} ${statusIcon} ${bold(exec.tool_name)} ${dim(formatTimestamp(exec.created_at))}`);

    // Show a brief summary of the input
    try {
      const inputObj = JSON.parse(exec.input) as Record<string, unknown>;
      const inputSummary = Object.entries(inputObj)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
        .join(", ");
      if (inputSummary) {
        info(`  ${childPrefix}  ${dim("in:")} ${dim(inputSummary)}`);
      }
    } catch {
      // ignore parse errors
    }

    if (exec.error) {
      info(`  ${childPrefix}  ${red("err:")} ${exec.error.slice(0, 80)}`);
    } else if (exec.output) {
      try {
        const outputStr = JSON.stringify(JSON.parse(exec.output)).slice(0, 80);
        info(`  ${childPrefix}  ${dim("out:")} ${dim(outputStr)}`);
      } catch {
        info(`  ${childPrefix}  ${dim("out:")} ${dim(exec.output.slice(0, 80))}`);
      }
    }
  }
}

/**
 * Execute the history command.
 *
 * Flow:
 * 1. If no --session flag: list recent sessions in a table  (Req 14.2, 14.3, 14.4)
 * 2. If --session flag: display full session log            (Req 14.5)
 * 3. If --tree flag: render tool execution tree             (Req 14.6)
 * 4. Format timestamps in human-readable format             (Req 14.7)
 * 5. Support pagination for large result sets               (Req 14.8)
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8
 */
export async function runHistory(options: HistoryOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // Load configuration and initialize UI
  const config = getConfig(projectRoot, { quiet: options.quiet });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  // Initialize database
  const db = initializeDatabase();

  // ---------------------------------------------------------------------------
  // Case 1: --session flag — show full session log (Req 14.5)
  // ---------------------------------------------------------------------------
  if (options.session) {
    const session = getSession(db, options.session);
    if (!session) {
      uiError(`Session not found: ${options.session}`);
      process.exit(1);
    }

    // Session header
    info("");
    info(bold(`Session: ${session.id}`));
    info(`  Command:   ${cyan(session.command)}`);
    info(`  Status:    ${colorizeStatus(session.status)}`);
    info(`  Started:   ${formatTimestamp(session.createdAt)}`);
    if (session.completedAt) {
      info(`  Completed: ${formatTimestamp(session.completedAt)}`);
    }
    if (session.error) {
      info(`  Error:     ${red(session.error)}`);
    }
    info(`  Project:   ${dim(session.projectRoot)}`);
    info(`  Provider:  ${session.provider} / ${session.model}`);
    info("");

    // Messages log
    const messages = db
      .prepare(
        `SELECT role, content, created_at
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(options.session) as Array<{
        role: string;
        content: string;
        created_at: string;
      }>;

    if (messages.length > 0) {
      info(bold("Messages:"));
      for (const msg of messages) {
        const roleLabel =
          msg.role === "user"
            ? cyan("[user]")
            : msg.role === "assistant"
            ? green("[assistant]")
            : dim("[system]");
        const timestamp = dim(formatTimestamp(msg.created_at));
        info(`  ${roleLabel} ${timestamp}`);
        // Truncate very long messages for readability
        const preview =
          msg.content.length > 300
            ? msg.content.slice(0, 300) + dim("…")
            : msg.content;
        // Indent content lines
        for (const line of preview.split("\n").slice(0, 10)) {
          info(`    ${line}`);
        }
        info("");
      }
    }

    // Tool executions
    const toolCount = (
      db
        .prepare(
          `SELECT COUNT(*) as count FROM tool_executions WHERE session_id = ?`
        )
        .get(options.session) as { count: number }
    ).count;

    if (toolCount > 0) {
      info(bold(`Tool Executions (${toolCount}):`));

      if (options.tree) {
        // Render as tree (Req 14.6)
        renderToolTree(db, options.session);
      } else {
        // Render as flat list
        const executions = db
          .prepare(
            `SELECT tool_name, input, output, error, created_at
             FROM tool_executions
             WHERE session_id = ?
             ORDER BY created_at ASC`
          )
          .all(options.session) as Array<{
            tool_name: string;
            input: string;
            output: string | null;
            error: string | null;
            created_at: string;
          }>;

        for (const exec of executions) {
          const statusIcon = exec.error ? red("✗") : green("✓");
          info(`  ${statusIcon} ${bold(exec.tool_name)} ${dim(formatTimestamp(exec.created_at))}`);
        }
      }
      info("");
    }

    return;
  }

  // ---------------------------------------------------------------------------
  // Case 2: No --session flag — list recent sessions (Req 14.2, 14.3, 14.4)
  // ---------------------------------------------------------------------------
  const PAGE_SIZE = 20;
  const limit = options.limit ?? PAGE_SIZE;

  // Fetch sessions with pagination support (Req 14.8)
  const sessions = listSessions(db, { limit });

  if (sessions.length === 0) {
    info("No sessions found. Run a command to create your first session.");
    return;
  }

  // Build table rows (Req 14.3)
  const rows: string[][] = sessions.map((s) => [
    dim(s.id.slice(0, 8)),          // abbreviated ID
    cyan(s.command),
    formatTimestamp(s.createdAt),   // human-readable timestamp (Req 14.7)
    colorizeStatus(s.status),
  ]);

  // Render table with cli-table3 (Req 14.3, 20.4)
  const table = renderTable(
    {
      head: ["ID", "Command", "When", "Status"],
      colWidths: [12, 12, 20, 12],
    },
    rows
  );

  info(table);

  // Show pagination hint if there may be more results (Req 14.8)
  if (sessions.length === limit && !options.limit) {
    info(dim(`\nShowing ${limit} most recent sessions. Use --limit <n> to see more.`));
  }
}

// ---------------------------------------------------------------------------
// config command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the config command.
 */
export interface ConfigOptions {
  /** Subcommand: get, set, path, init */
  subcommand?: "get" | "set" | "path" | "init";
  /** Configuration key (for get/set) */
  key?: string;
  /** Configuration value (for set) */
  value?: string;
  /** Preview changes without writing */
  dryRun?: boolean;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Suppress non-essential output */
  quiet?: boolean;
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * Serialize a Config object to TOML format.
 * Produces a minimal TOML representation suitable for ~/.aria/config.toml.
 */
function serializeConfigToToml(config: Config): string {
  const lines: string[] = [];

  lines.push("[provider]");
  lines.push(`default = "${config.provider.default}"`);
  lines.push(`model = "${config.provider.model}"`);
  lines.push(`max_tokens = ${config.provider.maxTokens}`);
  lines.push("");

  lines.push("[agent]");
  lines.push(`max_iterations = ${config.agent.maxIterations}`);
  lines.push(`mode = "${config.agent.mode}"`);
  lines.push(`timeout_seconds = ${config.agent.timeoutSeconds}`);
  lines.push("");

  lines.push("[safety]");
  lines.push(`require_confirm_for_shell = ${config.safety.requireConfirmForShell}`);
  const cmds = config.safety.allowedShellCommands.map((c) => `"${c}"`).join(", ");
  lines.push(`allowed_shell_commands = [${cmds}]`);
  lines.push(`max_file_size_kb = ${config.safety.maxFileSizeKb}`);
  lines.push(`max_files_per_patch = ${config.safety.maxFilesPerPatch}`);
  lines.push("");

  lines.push("[ui]");
  lines.push(`color = "${config.ui.color}"`);
  lines.push(`quiet = ${config.ui.quiet}`);
  lines.push("");

  lines.push("[history]");
  lines.push(`retain_days = ${config.history.retainDays}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Get a nested value from a Config object using dot-notation key.
 * e.g. "provider.model" → config.provider.model
 */
function getConfigValue(config: Config, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a nested value in a plain object using dot-notation key.
 * Returns a new object with the value set.
 */
function setNestedValue(
  obj: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> {
  const parts = key.split(".");
  const result = { ...obj };
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    current[part] = { ...(current[part] as Record<string, unknown> ?? {}) };
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return result;
}

/**
 * Parse a string value into the appropriate type for a config key.
 * Handles booleans, numbers, and strings.
 */
function parseConfigValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return num;
  return value;
}

/**
 * Display the effective configuration with precedence sources.
 * Requirements: 15.2
 */
function displayEffectiveConfig(
  projectRoot: string,
  config: Config
): void {
  const userConfigPath = path.join(os.homedir(), ".aria", "config.toml");
  const projectConfigPath = path.join(projectRoot, ".aria.toml");

  info(bold("Effective Configuration"));
  info("");
  info(dim(`Sources (highest to lowest precedence):`));
  info(dim(`  1. CLI flags`));
  info(dim(`  2. Environment variables`));
  info(dim(`  3. Project config: ${projectConfigPath}${existsSync(projectConfigPath) ? green(" (found)") : yellow(" (not found)")}`));
  info(dim(`  4. User config:    ${userConfigPath}${existsSync(userConfigPath) ? green(" (found)") : yellow(" (not found)")}`));
  info(dim(`  5. Defaults`));
  info("");

  info(bold("[provider]"));
  info(`  default      = ${cyan(config.provider.default)}`);
  info(`  model        = ${cyan(config.provider.model)}`);
  info(`  max_tokens   = ${cyan(String(config.provider.maxTokens))}`);
  info("");

  info(bold("[agent]"));
  info(`  max_iterations  = ${cyan(String(config.agent.maxIterations))}`);
  info(`  mode            = ${cyan(config.agent.mode)}`);
  info(`  timeout_seconds = ${cyan(String(config.agent.timeoutSeconds))}`);
  info("");

  info(bold("[safety]"));
  info(`  require_confirm_for_shell = ${cyan(String(config.safety.requireConfirmForShell))}`);
  info(`  allowed_shell_commands    = ${cyan(JSON.stringify(config.safety.allowedShellCommands))}`);
  info(`  max_file_size_kb          = ${cyan(String(config.safety.maxFileSizeKb))}`);
  info(`  max_files_per_patch       = ${cyan(String(config.safety.maxFilesPerPatch))}`);
  info("");

  info(bold("[ui]"));
  info(`  color = ${cyan(config.ui.color)}`);
  info(`  quiet = ${cyan(String(config.ui.quiet))}`);
  info("");

  info(bold("[history]"));
  info(`  retain_days = ${cyan(String(config.history.retainDays))}`);
}

/**
 * Execute the config command.
 *
 * Subcommands:
 * - (none): Display effective configuration with precedence sources  (Req 15.2)
 * - get <key>: Display value for specified key                       (Req 15.3)
 * - set <key> <value>: Write key-value to ~/.aria/config.toml        (Req 15.4–15.6, 15.10)
 * - path: Display configuration file resolution paths               (Req 15.7)
 * - init: Create ./.aria.toml with default values                   (Req 15.8, 15.9)
 *
 * Requirements: 15.1–15.10
 */
export async function runConfig(options: ConfigOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // Load configuration and initialize UI
  const config = getConfig(projectRoot, { quiet: options.quiet });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  const userConfigPath = path.join(os.homedir(), ".aria", "config.toml");
  const projectConfigPath = path.join(projectRoot, ".aria.toml");

  // ---------------------------------------------------------------------------
  // No subcommand: display effective configuration (Req 15.2)
  // ---------------------------------------------------------------------------
  if (!options.subcommand) {
    displayEffectiveConfig(projectRoot, config);
    return;
  }

  // ---------------------------------------------------------------------------
  // config path: display config file resolution paths (Req 15.7)
  // ---------------------------------------------------------------------------
  if (options.subcommand === "path") {
    info(bold("Configuration file paths:"));
    info("");
    info(`  User config:    ${userConfigPath}`);
    info(`    ${existsSync(userConfigPath) ? green("✓ exists") : yellow("✗ not found")}`);
    info("");
    info(`  Project config: ${projectConfigPath}`);
    info(`    ${existsSync(projectConfigPath) ? green("✓ exists") : yellow("✗ not found")}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // config get <key>: display value for key (Req 15.3)
  // ---------------------------------------------------------------------------
  if (options.subcommand === "get") {
    const key = options.key!;
    const value = getConfigValue(config, key);
    if (value === undefined) {
      uiError(`Unknown configuration key: ${key}`);
      process.exit(1);
    }
    print(JSON.stringify(value));
    return;
  }

  // ---------------------------------------------------------------------------
  // config set <key> <value>: write to user config (Req 15.4–15.6, 15.10)
  // ---------------------------------------------------------------------------
  if (options.subcommand === "set") {
    const key = options.key!;
    const rawValue = options.value!;

    // Parse the value to the appropriate type
    const parsedValue = parseConfigValue(rawValue);

    // Validate by applying to current config and re-validating (Req 15.10)
    const currentMerged = loadConfig(projectRoot);
    const updatedMerged = setNestedValue(
      currentMerged as Record<string, unknown>,
      key,
      parsedValue
    );

    let validatedConfig: Config;
    try {
      validatedConfig = validateConfig(updatedMerged as ConfigSource);
    } catch (err) {
      uiError(
        `Invalid value for ${key}: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(3);
    }

    // Serialize the full validated config for the diff preview
    const oldContent = existsSync(userConfigPath)
      ? readFileSync(userConfigPath, "utf-8")
      : "";
    const newContent = serializeConfigToToml(validatedConfig);

    // Preview the diff (Req 15.5, 15.6)
    const diffOutput = generateAndRenderDiff(userConfigPath, oldContent, newContent);
    info(bold("Preview:"));
    info(diffOutput);

    // If --dry-run, exit without writing (Req 15.6)
    if (options.dryRun) {
      info(yellow("Dry-run mode — no changes written."));
      return;
    }

    // If not --yes, prompt for confirmation (Req 15.5)
    if (!options.yes) {
      let confirmed: boolean;
      try {
        confirmed = await confirm(`Write to ${userConfigPath}?`);
      } catch (err) {
        if (err instanceof ConfirmCancelledError) {
          info(yellow("Operation cancelled."));
          process.exit(130);
        }
        throw err;
      }
      if (!confirmed) {
        info(yellow("Operation cancelled."));
        process.exit(130);
      }
    }

    // Write to ~/.aria/config.toml (Req 15.4)
    const ariaDir = path.join(os.homedir(), ".aria");
    if (!existsSync(ariaDir)) {
      mkdirSync(ariaDir, { recursive: true });
    }
    writeFileSync(userConfigPath, newContent, { encoding: "utf-8", mode: 0o600 });
    info(green(`✓ Written to ${userConfigPath}`));
    return;
  }

  // ---------------------------------------------------------------------------
  // config init: create ./.aria.toml with defaults (Req 15.8, 15.9)
  // ---------------------------------------------------------------------------
  if (options.subcommand === "init") {
    // Generate default config content
    const defaultConfig = validateConfig({});
    const defaultContent = serializeConfigToToml(defaultConfig);

    // Preview content
    const oldContent = existsSync(projectConfigPath)
      ? readFileSync(projectConfigPath, "utf-8")
      : "";
    const diffOutput = generateAndRenderDiff(projectConfigPath, oldContent, defaultContent);
    info(bold("Preview (.aria.toml):"));
    info(diffOutput);

    // If --dry-run, exit without writing (Req 17.4)
    if (options.dryRun) {
      info(yellow("Dry-run mode — no file created."));
      return;
    }

    // If not --yes, prompt for confirmation (Req 15.9)
    if (!options.yes) {
      let confirmed: boolean;
      try {
        confirmed = await confirm(`Create ${projectConfigPath}?`);
      } catch (err) {
        if (err instanceof ConfirmCancelledError) {
          info(yellow("Operation cancelled."));
          process.exit(130);
        }
        throw err;
      }
      if (!confirmed) {
        info(yellow("Operation cancelled."));
        process.exit(130);
      }
    }

    // Write ./.aria.toml (Req 15.8)
    writeFileSync(projectConfigPath, defaultContent, "utf-8");
    info(green(`✓ Created ${projectConfigPath}`));
    return;
  }
}

// ---------------------------------------------------------------------------
// doctor command
// ---------------------------------------------------------------------------

/**
 * Options parsed from CLI flags for the doctor command.
 */
export interface DoctorOptions {
  /** Output format: "text" (default) or "json" */
  format?: "text" | "json";
  /** Project root (defaults to process.cwd()) */
  projectRoot?: string;
}

/**
 * A single diagnostic check result.
 */
export interface DiagnosticCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

/**
 * Execute the doctor command.
 *
 * Runs a series of environment diagnostic checks and reports results.
 * Exits with code 1 if any critical check fails.
 *
 * Requirements: 16.1–16.13
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // Initialize UI (best-effort — config may be broken, that's what we're diagnosing)
  let config: import("./config.js").Config | null = null;
  try {
    config = getConfig(projectRoot, {});
    initUI(config.ui.color, false);
  } catch {
    initUI("auto", false);
  }

  const checks: DiagnosticCheck[] = [];

  // -------------------------------------------------------------------------
  // 1. Node.js version >= 20 (Req 16.2) — CRITICAL
  // -------------------------------------------------------------------------
  {
    const nodeVersion = process.version; // e.g. "v20.11.0"
    const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
    if (major >= 20) {
      checks.push({ name: "nodejs", status: "pass", message: nodeVersion });
    } else {
      checks.push({
        name: "nodejs",
        status: "fail",
        message: `${nodeVersion} (requires >= v20)`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. git availability (Req 16.3) — WARN only
  // -------------------------------------------------------------------------
  {
    try {
      const out = execFileSync("git", ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      checks.push({ name: "git", status: "pass", message: out });
    } catch {
      checks.push({ name: "git", status: "warn", message: "not found in PATH" });
    }
  }

  // -------------------------------------------------------------------------
  // 3. ripgrep (rg) availability (Req 16.4) — WARN only
  // -------------------------------------------------------------------------
  {
    try {
      const out = execFileSync("rg", ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).split("\n")[0].trim();
      checks.push({ name: "ripgrep", status: "pass", message: out });
    } catch {
      checks.push({ name: "ripgrep", status: "warn", message: "not found in PATH (search_code tool will be unavailable)" });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Config file syntax and schema validation (Req 16.5) — CRITICAL
  // -------------------------------------------------------------------------
  {
    const userConfigPath = path.join(os.homedir(), ".aria", "config.toml");
    const projectConfigPath = path.join(projectRoot, ".aria.toml");

    if (!existsSync(userConfigPath) && !existsSync(projectConfigPath)) {
      checks.push({ name: "config", status: "pass", message: "no config files found (using defaults)" });
    } else {
      try {
        getConfig(projectRoot, {});
        const found = [
          existsSync(userConfigPath) ? "~/.aria/config.toml" : null,
          existsSync(projectConfigPath) ? ".aria.toml" : null,
        ].filter(Boolean).join(", ");
        checks.push({ name: "config", status: "pass", message: `valid (${found})` });
      } catch (err) {
        checks.push({
          name: "config",
          status: "fail",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. History DB accessibility and schema version (Req 16.6) — CRITICAL
  // -------------------------------------------------------------------------
  {
    try {
      const db = initializeDatabase();
      const { getCurrentSchemaVersion } = await import("./storage.js"); // lazy: only needed here
      const version = getCurrentSchemaVersion(db);
      checks.push({ name: "history_db", status: "pass", message: `accessible (schema v${version})` });
    } catch (err) {
      checks.push({
        name: "history_db",
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 6. Provider readiness — API key presence (Req 16.7) — CRITICAL
  // -------------------------------------------------------------------------
  {
    const provider = config?.provider.default ?? "anthropic";
    const keyMap: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      ollama: "", // no key needed
    };
    const envKey = keyMap[provider];
    if (!envKey) {
      // Ollama — no API key required
      checks.push({ name: "provider", status: "pass", message: `${provider} (no API key required)` });
    } else if (process.env[envKey]) {
      checks.push({ name: "provider", status: "pass", message: `${provider} (${envKey} present)` });
    } else {
      checks.push({
        name: "provider",
        status: "fail",
        message: `${provider} (${envKey} not set)`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 7. Project type detection (Req 16.8)
  // -------------------------------------------------------------------------
  {
    try {
      const project = detectProjectType(projectRoot);
      const frameworkLabel = project.framework
        ? ` (${project.framework.name}${project.framework.router ? ` ${project.framework.router} router` : ""})`
        : "";
      checks.push({ name: "project", status: "pass", message: `${project.type}${frameworkLabel}` });
    } catch (err) {
      checks.push({
        name: "project",
        status: "fail",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 8. Prisma schema existence if Prisma detected (Req 16.9)
  // -------------------------------------------------------------------------
  {
    try {
      const project = detectProjectType(projectRoot);
      if (project.hasPrisma) {
        if (project.prismaSchemaPath && existsSync(project.prismaSchemaPath)) {
          checks.push({ name: "prisma", status: "pass", message: `detected at ${project.prismaSchemaPath}` });
        } else {
          checks.push({ name: "prisma", status: "warn", message: "dependency detected but prisma/schema.prisma not found" });
        }
      }
      // If no Prisma, skip this check entirely
    } catch {
      // project detection already reported above
    }
  }

  // -------------------------------------------------------------------------
  // 9. Ollama reachability if Ollama provider selected (Req 16.10) — WARN
  // -------------------------------------------------------------------------
  {
    const provider = config?.provider.default ?? "anthropic";
    if (provider === "ollama") {
      const ollamaHost = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(ollamaHost, { signal: controller.signal });
        clearTimeout(timeoutId);
        checks.push({ name: "ollama", status: "pass", message: `reachable at ${ollamaHost} (HTTP ${res.status})` });
      } catch {
        checks.push({ name: "ollama", status: "warn", message: `not reachable at ${ollamaHost}` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Output results
  // -------------------------------------------------------------------------
  const criticalNames = new Set(["nodejs", "config", "history_db", "provider"]);
  const hasCriticalFailure = checks.some(
    (c) => c.status === "fail" && criticalNames.has(c.name)
  );

  if (options.format === "json") {
    // JSON output (Req 16.12)
    const allPassed = !checks.some((c) => c.status === "fail");
    process.stdout.write(
      JSON.stringify({ checks, allPassed }, null, 2) + "\n"
    );
  } else {
    // Text output (Req 16.11)
    info("");
    info(bold("Aria environment diagnostics"));
    info("");

    for (const check of checks) {
      if (check.status === "pass") {
        info(`${green("✓")} ${bold(check.name)}: ${check.message}`);
      } else if (check.status === "warn") {
        info(`${yellow("!")} ${bold(check.name)}: ${check.message}`);
      } else {
        info(`${red("✗")} ${bold(check.name)}: ${check.message}`);
      }
    }

    info("");

    if (hasCriticalFailure) {
      info(red("One or more critical checks failed. Please fix the issues above."));
    } else {
      info(green("All critical checks passed."));
    }
  }

  // Exit with code 1 if any critical check fails (Req 16.13)
  if (hasCriticalFailure) {
    process.exit(1);
  }
}
