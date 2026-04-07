import { z } from "zod";
import { ExecutionModeSchema } from "./context.js";
import { parse as parseToml } from "smol-toml";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Provider configuration
 * Supports Anthropic, OpenAI, Ollama, and OpenRouter
 */
export const ProviderConfigSchema = z.object({
  default: z
    .enum(["anthropic", "openai", "ollama", "openrouter"])
    .default("anthropic"),
  model: z.string().default("claude-sonnet-4-6"),
  maxTokens: z.number().int().positive().default(4096),
  // Per-provider model overrides (v0.2.2)
  anthropic: z.object({
    model: z.string().optional(),
  }).optional(),
  openrouter: z.object({
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
  }).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Agent configuration
 * Controls agent loop behavior and execution mode
 */
export const AgentConfigSchema = z.object({
  maxIterations: z.number().int().positive().default(25),
  mode: ExecutionModeSchema.default("build"),
  timeoutSeconds: z.number().int().positive().default(120),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Safety configuration
 * Enforces boundaries and resource limits
 */
export const SafetyConfigSchema = z.object({
  requireConfirmForShell: z.boolean().default(true),
  allowedShellCommands: z
    .array(z.string())
    .default(["npm", "pnpm", "yarn", "npx", "git", "prisma", "tsc", "node"]),
  maxFileSizeKb: z.number().int().positive().default(1024),
  maxFilesPerPatch: z.number().int().positive().default(50),
});

export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

/**
 * UI configuration
 * Controls terminal output formatting
 */
export const UIConfigSchema = z.object({
  color: z.enum(["auto", "always", "never"]).default("auto"),
  quiet: z.boolean().default(false),
});

export type UIConfig = z.infer<typeof UIConfigSchema>;

/**
 * History configuration
 * Controls session retention policy
 */
export const HistoryConfigSchema = z.object({
  retainDays: z.number().int().positive().default(90),
});

export type HistoryConfig = z.infer<typeof HistoryConfigSchema>;

/**
 * Complete configuration schema
 * Combines all configuration sections
 */
export const ConfigSchema = z.object({
  provider: ProviderConfigSchema,
  agent: AgentConfigSchema,
  safety: SafetyConfigSchema,
  ui: UIConfigSchema,
  history: HistoryConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Configuration error with context
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly source?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Parse a TOML configuration file
 * @param filePath - Path to the TOML file
 * @returns Parsed configuration object
 * @throws ConfigError if file cannot be read or parsed
 */
export function parseConfigFile(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseToml(content);
  } catch (error) {
    if (error instanceof Error) {
      // Check if it's a file not found error
      if ("code" in error && error.code === "ENOENT") {
        throw new ConfigError(
          `Configuration file not found: ${filePath}`,
          filePath,
          error
        );
      }

      // Check if it's a TOML parse error
      if (error.message.includes("TOML") || error.message.includes("parse")) {
        throw new ConfigError(
          `Invalid TOML syntax in ${filePath}: ${error.message}`,
          filePath,
          error
        );
      }

      // Generic error
      throw new ConfigError(
        `Failed to read configuration file ${filePath}: ${error.message}`,
        filePath,
        error
      );
    }

    throw new ConfigError(
      `Unknown error reading configuration file ${filePath}`,
      filePath,
      error
    );
  }
}

/**
 * Configuration source for precedence tracking
 */
export interface ConfigSource {
  provider?: Partial<ProviderConfig>;
  agent?: Partial<AgentConfig>;
  safety?: Partial<SafetyConfig>;
  ui?: Partial<UIConfig>;
  history?: Partial<HistoryConfig>;
}

/**
 * CLI flags that can override configuration
 */
export interface CLIFlags {
  dryRun?: boolean;
  assumeYes?: boolean;
  quiet?: boolean;
  maxTokens?: number;
  mode?: "plan" | "build";
  color?: "auto" | "always" | "never";
  // v0.2.2: provider/model overrides
  provider?: string;
  model?: string;
}

/**
 * Load configuration from a TOML file if it exists
 * @param filePath - Path to the TOML file
 * @returns Parsed configuration or empty object if file doesn't exist
 */
function loadConfigFile(filePath: string): ConfigSource {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const parsed = parseConfigFile(filePath);
    return parsed as ConfigSource;
  } catch (error) {
    if (error instanceof ConfigError && error.cause) {
      const cause = error.cause as { code?: string };
      if (cause.code === "ENOENT") {
        return {};
      }
    }
    throw error;
  }
}

/**
 * Load configuration from environment variables
 * @returns Configuration from environment variables
 */
function loadEnvironmentConfig(): ConfigSource {
  const config: ConfigSource = {};

  // Provider configuration
  const validProviders = ["anthropic", "openai", "ollama", "openrouter"] as const;
  if (process.env.ARIA_PROVIDER) {
    const p = process.env.ARIA_PROVIDER;
    if (validProviders.includes(p as (typeof validProviders)[number])) {
      config.provider = { default: p as (typeof validProviders)[number] };
    }
  }
  if (process.env.ARIA_MODEL) {
    config.provider = { ...config.provider, model: process.env.ARIA_MODEL };
  }
  if (process.env.ARIA_MAX_TOKENS) {
    const maxTokens = parseInt(process.env.ARIA_MAX_TOKENS, 10);
    if (!isNaN(maxTokens)) {
      config.provider = { ...config.provider, maxTokens };
    }
  }
  // OpenRouter base URL override
  if (process.env.OPENROUTER_BASE_URL) {
    try {
      new URL(process.env.OPENROUTER_BASE_URL); // validate URL format
      config.provider = {
        ...config.provider,
        openrouter: { ...config.provider?.openrouter, baseUrl: process.env.OPENROUTER_BASE_URL },
      };
    } catch {
      throw new ConfigError(
        `Invalid OPENROUTER_BASE_URL: "${process.env.OPENROUTER_BASE_URL}" is not a valid URL`,
      );
    }
  }

  // Agent configuration
  if (process.env.ARIA_MAX_ITERATIONS) {
    const maxIterations = parseInt(process.env.ARIA_MAX_ITERATIONS, 10);
    if (!isNaN(maxIterations)) {
      config.agent = { maxIterations };
    }
  }
  if (process.env.ARIA_TIMEOUT_SECONDS) {
    const timeoutSeconds = parseInt(process.env.ARIA_TIMEOUT_SECONDS, 10);
    if (!isNaN(timeoutSeconds)) {
      config.agent = { ...config.agent, timeoutSeconds };
    }
  }

  // UI configuration
  const validColorModes = ["auto", "always", "never"] as const;
  if (process.env.ARIA_COLOR) {
    const c = process.env.ARIA_COLOR;
    if (validColorModes.includes(c as (typeof validColorModes)[number])) {
      config.ui = { color: c as (typeof validColorModes)[number] };
    }
  }
  if (process.env.ARIA_QUIET) {
    config.ui = { ...config.ui, quiet: process.env.ARIA_QUIET === "true" };
  }

  // History configuration
  if (process.env.ARIA_RETAIN_DAYS) {
    const retainDays = parseInt(process.env.ARIA_RETAIN_DAYS, 10);
    if (!isNaN(retainDays)) {
      config.history = { retainDays };
    }
  }

  return config;
}

/**
 * Convert CLI flags to configuration overrides
 * @param flags - CLI flags
 * @returns Configuration from CLI flags
 */
function flagsToConfig(flags: CLIFlags): ConfigSource {
  const config: ConfigSource = {};

  if (flags.maxTokens !== undefined) {
    config.provider = { maxTokens: flags.maxTokens };
  }

  if (flags.provider !== undefined) {
    const validProviders = ["anthropic", "openai", "ollama", "openrouter"] as const;
    if (validProviders.includes(flags.provider as (typeof validProviders)[number])) {
      config.provider = { ...config.provider, default: flags.provider as (typeof validProviders)[number] };
    } else {
      throw new ConfigError(
        `Unknown provider "${flags.provider}". Valid providers: ${validProviders.join(", ")}`,
      );
    }
  }

  if (flags.model !== undefined) {
    config.provider = {
      ...config.provider,
      model: flags.model,
      // CLI --model overrides per-provider model settings from config files
      anthropic: { model: undefined },
      openrouter: { ...config.provider?.openrouter, model: undefined },
    };
  }

  if (flags.mode !== undefined) {
    config.agent = { mode: flags.mode };
  }

  if (flags.quiet !== undefined) {
    config.ui = { quiet: flags.quiet };
  }

  if (flags.color !== undefined) {
    config.ui = { ...config.ui, color: flags.color };
  }

  return config;
}

/**
 * Deep merge two configuration sources
 * Later source takes precedence for defined values
 */
function mergeConfigSources(base: ConfigSource, override: ConfigSource): ConfigSource {
  return {
    provider: { ...base.provider, ...override.provider },
    agent: { ...base.agent, ...override.agent },
    safety: { ...base.safety, ...override.safety },
    ui: { ...base.ui, ...override.ui },
    history: { ...base.history, ...override.history },
  };
}

/**
 * Load and merge configuration from all sources with correct precedence
 * Precedence order (highest to lowest):
 * 1. CLI flags
 * 2. Environment variables
 * 3. Project config (./.aria.toml)
 * 4. User config (~/.aria/config.toml)
 * 5. Defaults (from zod schemas)
 *
 * @param projectRoot - Project root directory for loading ./.aria.toml
 * @param flags - CLI flags
 * @returns Merged configuration from all sources
 */
export function loadConfig(
  projectRoot: string,
  flags: CLIFlags = {}
): ConfigSource {
  // Load from all sources
  const userConfigPath = path.join(os.homedir(), ".aria", "config.toml");
  const projectConfigPath = path.join(projectRoot, ".aria.toml");

  const userConfig = loadConfigFile(userConfigPath);
  const projectConfig = loadConfigFile(projectConfigPath);
  const envConfig = loadEnvironmentConfig();
  const flagConfig = flagsToConfig(flags);

  // Merge with correct precedence (later overrides earlier)
  let merged: ConfigSource = {};
  merged = mergeConfigSources(merged, userConfig);
  merged = mergeConfigSources(merged, projectConfig);
  merged = mergeConfigSources(merged, envConfig);
  merged = mergeConfigSources(merged, flagConfig);

  return merged;
}

/**
 * Validate and normalize configuration
 * @param config - Raw configuration from all sources
 * @returns Validated and normalized configuration
 * @throws ConfigError if validation fails
 */
export function validateConfig(config: ConfigSource): Config {
  try {
    // Ensure all top-level sections are present as objects so Zod can apply
    // nested defaults. Zod v4 does not apply defaults when the parent key is
    // undefined — we must provide at least an empty object for each section.
    const normalized = {
      provider: config.provider ?? {},
      agent: config.agent ?? {},
      safety: config.safety ?? {},
      ui: config.ui ?? {},
      history: config.history ?? {},
    };
    const validated = ConfigSchema.parse(normalized);
    return validated;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");

      throw new ConfigError(
        `Configuration validation failed:\n${issues}`,
        undefined,
        error
      );
    }

    throw new ConfigError(
      "Unknown configuration validation error",
      undefined,
      error
    );
  }
}

/**
 * Load, merge, and validate configuration from all sources
 * This is the main entry point for configuration loading
 *
 * @param projectRoot - Project root directory
 * @param flags - CLI flags
 * @returns Validated configuration
 * @throws ConfigError if loading or validation fails
 */
export function getConfig(projectRoot: string, flags: CLIFlags = {}): Config {
  const merged = loadConfig(projectRoot, flags);
  return validateConfig(merged);
}
