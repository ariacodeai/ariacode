import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseConfigFile,
  validateConfig,
  loadConfig,
  getConfig,
  ConfigError,
} from "../../src/config.js";

describe("parseConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid TOML file", () => {
    const tomlPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(tomlPath, `[provider]\ndefault = "openai"\n`);
    const result = parseConfigFile(tomlPath);
    expect(result).toMatchObject({ provider: { default: "openai" } });
  });

  it("throws ConfigError for non-existent file", () => {
    expect(() => parseConfigFile("/nonexistent/config.toml")).toThrow(ConfigError);
  });

  it("throws ConfigError for invalid TOML syntax", () => {
    const tomlPath = path.join(tmpDir, "bad.toml");
    fs.writeFileSync(tomlPath, "this is not valid toml ===");
    expect(() => parseConfigFile(tomlPath)).toThrow(ConfigError);
  });

  it("parses empty TOML file", () => {
    const tomlPath = path.join(tmpDir, "empty.toml");
    fs.writeFileSync(tomlPath, "");
    const result = parseConfigFile(tomlPath);
    expect(result).toEqual({});
  });
});

describe("validateConfig", () => {
  it("returns defaults for empty config", () => {
    const config = validateConfig({});
    expect(config.provider.default).toBe("anthropic");
    expect(config.provider.model).toBe("claude-sonnet-4-6");
    expect(config.provider.maxTokens).toBe(4096);
    expect(config.agent.maxIterations).toBe(25);
    expect(config.agent.timeoutSeconds).toBe(120);
    expect(config.safety.maxFileSizeKb).toBe(1024);
    expect(config.safety.maxFilesPerPatch).toBe(50);
    expect(config.ui.color).toBe("auto");
    expect(config.ui.quiet).toBe(false);
    expect(config.history.retainDays).toBe(90);
  });

  it("accepts valid provider config", () => {
    const config = validateConfig({
      provider: { default: "openai", model: "gpt-4", maxTokens: 2048 },
    });
    expect(config.provider.default).toBe("openai");
    expect(config.provider.model).toBe("gpt-4");
    expect(config.provider.maxTokens).toBe(2048);
  });

  it("throws ConfigError for invalid provider", () => {
    expect(() =>
      validateConfig({ provider: { default: "invalid-provider" as any } })
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for negative maxTokens", () => {
    expect(() =>
      validateConfig({ provider: { maxTokens: -1 } })
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for invalid color mode", () => {
    expect(() =>
      validateConfig({ ui: { color: "rainbow" as any } })
    ).toThrow(ConfigError);
  });

  it("accepts all valid providers", () => {
    for (const provider of ["anthropic", "openai", "ollama", "openrouter"] as const) {
      const config = validateConfig({ provider: { default: provider } });
      expect(config.provider.default).toBe(provider);
    }
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-load-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty config when no files exist", () => {
    const config = loadConfig(tmpDir);
    expect(config).toBeDefined();
  });

  it("loads project config from .aria.toml", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".aria.toml"),
      `[provider]\ndefault = "ollama"\n`
    );
    const config = loadConfig(tmpDir);
    expect(config.provider?.default).toBe("ollama");
  });

  it("CLI flags override project config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".aria.toml"),
      `[provider]\nmaxTokens = 1000\n`
    );
    const config = loadConfig(tmpDir, { maxTokens: 2000 });
    expect(config.provider?.maxTokens).toBe(2000);
  });

  it("quiet flag is applied", () => {
    const config = loadConfig(tmpDir, { quiet: true });
    expect(config.ui?.quiet).toBe(true);
  });
});

describe("getConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-getconfig-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a fully validated config with defaults", () => {
    const config = getConfig(tmpDir);
    expect(config.provider).toBeDefined();
    expect(config.agent).toBeDefined();
    expect(config.safety).toBeDefined();
    expect(config.ui).toBeDefined();
    expect(config.history).toBeDefined();
  });

  it("throws ConfigError for invalid project config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".aria.toml"),
      `[provider]\ndefault = "bad-provider"\n`
    );
    expect(() => getConfig(tmpDir)).toThrow(ConfigError);
  });
});

describe("v0.2.2 provider/model flag overrides", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-v022-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--provider flag overrides default provider", () => {
    const config = getConfig(tmpDir, { provider: "openrouter" });
    expect(config.provider.default).toBe("openrouter");
  });

  it("--model flag overrides model", () => {
    const config = getConfig(tmpDir, { model: "deepseek/deepseek-chat" });
    expect(config.provider.model).toBe("deepseek/deepseek-chat");
  });

  it("per-provider openrouter.model is preserved in config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".aria.toml"),
      `[provider]\ndefault = "openrouter"\n\n[provider.openrouter]\nmodel = "qwen/qwen-2.5-72b-instruct"\n`
    );
    const config = getConfig(tmpDir);
    expect(config.provider.openrouter?.model).toBe("qwen/qwen-2.5-72b-instruct");
  });

  it("per-provider openrouter.baseUrl is preserved in config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".aria.toml"),
      `[provider]\ndefault = "openrouter"\n\n[provider.openrouter]\nbaseUrl = "https://custom.openrouter.ai/api/v1"\n`
    );
    const config = getConfig(tmpDir);
    expect(config.provider.openrouter?.baseUrl).toBe("https://custom.openrouter.ai/api/v1");
  });

  it("per-provider anthropic.model is preserved in config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".aria.toml"),
      `[provider]\ndefault = "anthropic"\n\n[provider.anthropic]\nmodel = "claude-opus-4-5"\n`
    );
    const config = getConfig(tmpDir);
    expect(config.provider.anthropic?.model).toBe("claude-opus-4-5");
  });

  it("invalid provider flag throws ConfigError", () => {
    expect(() => getConfig(tmpDir, { provider: "unknown-provider" })).toThrow(ConfigError);
  });
});
