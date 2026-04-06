import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { stringify as stringifyToml } from "smol-toml";
import { initializeDatabase, closeDatabase } from "./storage.js";
import { validateConfig } from "./config.js";

/**
 * Resolve the ~/.aria directory path
 */
export function getAriaHomeDir(): string {
  return path.join(os.homedir(), ".aria");
}

/**
 * Build the default config as a plain object suitable for TOML serialization.
 * We derive defaults by validating an empty config source.
 */
function buildDefaultConfigObject(): Record<string, unknown> {
  const defaults = validateConfig({});
  return {
    provider: {
      default: defaults.provider.default,
      model: defaults.provider.model,
      max_tokens: defaults.provider.maxTokens,
    },
    agent: {
      max_iterations: defaults.agent.maxIterations,
      mode: defaults.agent.mode,
      timeout_seconds: defaults.agent.timeoutSeconds,
    },
    safety: {
      require_confirm_for_shell: defaults.safety.requireConfirmForShell,
      allowed_shell_commands: defaults.safety.allowedShellCommands,
      max_file_size_kb: defaults.safety.maxFileSizeKb,
      max_files_per_patch: defaults.safety.maxFilesPerPatch,
    },
    ui: {
      color: defaults.ui.color,
      quiet: defaults.ui.quiet,
    },
    history: {
      retain_days: defaults.history.retainDays,
    },
  };
}

/**
 * Initialize the ~/.aria home directory on first run.
 *
 * Steps:
 * 1. Create ~/.aria directory if it does not exist (Requirements 1.4)
 * 2. Initialize history.db with versioned schema (Requirement 1.5)
 * 3. Set history.db file permissions to 0o600 (Requirement 23.7)
 * 4. Create default ~/.aria/config.toml if it does not exist
 */
export function initializeAriaHome(): void {
  const ariaDir = getAriaHomeDir();

  // 1. Create ~/.aria directory if it doesn't exist
  if (!fs.existsSync(ariaDir)) {
    fs.mkdirSync(ariaDir, { recursive: true, mode: 0o700 });
  }

  // 2. Initialize history.db with versioned schema (also sets chmod 600 internally)
  initializeDatabase();

  // 3. Ensure history.db permissions are 0o600 (belt-and-suspenders)
  const dbPath = path.join(ariaDir, "history.db");
  if (fs.existsSync(dbPath)) {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // Non-fatal: warn but continue (e.g. on some CI environments)
    }
  }

  // 4. Create default ~/.aria/config.toml if it doesn't exist
  const configPath = path.join(ariaDir, "config.toml");
  if (!fs.existsSync(configPath)) {
    const defaultConfig = buildDefaultConfigObject();
    const tomlContent = stringifyToml(defaultConfig);
    fs.writeFileSync(configPath, tomlContent, { encoding: "utf-8", mode: 0o600 });
  }

  // Close the db connection opened during initialization so callers get a
  // fresh connection when they actually need it.
  closeDatabase();
}
