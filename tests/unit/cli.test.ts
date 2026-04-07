import { describe, it, expect, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// Mock process.exit so validateArgs tests don't actually exit
vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
  throw new Error(`process.exit(${code})`);
}) as any;

import { parseCLI, validateArgs } from "../../src/parser.js";

describe("parseCLI", () => {
  it("parses ask command with question", () => {
    const args = parseCLI(["ask", "What is this project?"]);
    expect(args.command).toBe("ask");
    expect(args.question).toBe("What is this project?");
  });

  it("parses plan command with goal", () => {
    const args = parseCLI(["plan", "Add authentication"]);
    expect(args.command).toBe("plan");
    expect(args.goal).toBe("Add authentication");
  });

  it("parses patch command with description", () => {
    const args = parseCLI(["patch", "Fix the bug"]);
    expect(args.command).toBe("patch");
    expect(args.description).toBe("Fix the bug");
  });

  it("parses --dry-run flag", () => {
    const args = parseCLI(["patch", "Fix bug", "--dry-run"]);
    expect(args.dryRun).toBe(true);
  });

  it("parses --yes flag", () => {
    const args = parseCLI(["patch", "Fix bug", "--yes"]);
    expect(args.assumeYes).toBe(true);
  });

  it("parses -y as --yes", () => {
    const args = parseCLI(["patch", "Fix bug", "-y"]);
    expect(args.assumeYes).toBe(true);
  });

  it("parses --quiet flag", () => {
    const args = parseCLI(["ask", "question", "--quiet"]);
    expect(args.quiet).toBe(true);
  });

  it("parses --session flag", () => {
    const args = parseCLI(["ask", "question", "--session", "abc-123"]);
    expect(args.session).toBe("abc-123");
  });

  it("parses --session= syntax", () => {
    const args = parseCLI(["ask", "question", "--session=abc-123"]);
    expect(args.session).toBe("abc-123");
  });

  it("parses --format flag", () => {
    const args = parseCLI(["review", "--format", "json"]);
    expect(args.format).toBe("json");
  });

  it("parses --max-tokens flag", () => {
    const args = parseCLI(["ask", "question", "--max-tokens", "2048"]);
    expect(args.maxTokens).toBe(2048);
  });

  it("parses --output flag for plan", () => {
    const args = parseCLI(["plan", "goal", "--output", "plan.md"]);
    expect(args.output).toBe("plan.md");
  });

  it("parses --unstaged flag for review", () => {
    const args = parseCLI(["review", "--unstaged"]);
    expect(args.unstaged).toBe(true);
  });

  it("parses --branch flag for review", () => {
    const args = parseCLI(["review", "--branch", "main"]);
    expect(args.branch).toBe("main");
  });

  it("parses --depth flag for explore", () => {
    const args = parseCLI(["explore", "--depth", "3"]);
    expect(args.depth).toBe(3);
  });

  it("parses --save flag for explore", () => {
    const args = parseCLI(["explore", "--save"]);
    expect(args.save).toBe(true);
  });

  it("parses --limit flag for history", () => {
    const args = parseCLI(["history", "--limit", "10"]);
    expect(args.limit).toBe(10);
  });

  it("parses --tree flag for history", () => {
    const args = parseCLI(["history", "--tree"]);
    expect(args.tree).toBe(true);
  });

  it("parses config get subcommand", () => {
    const args = parseCLI(["config", "get", "provider.default"]);
    expect(args.command).toBe("config");
    expect(args.configSubcommand).toBe("get");
    expect(args.configKey).toBe("provider.default");
  });

  it("parses config set subcommand", () => {
    const args = parseCLI(["config", "set", "provider.default", "openai"]);
    expect(args.command).toBe("config");
    expect(args.configSubcommand).toBe("set");
    expect(args.configKey).toBe("provider.default");
    expect(args.configValue).toBe("openai");
  });

  it("parses config path subcommand", () => {
    const args = parseCLI(["config", "path"]);
    expect(args.configSubcommand).toBe("path");
  });

  it("parses config init subcommand", () => {
    const args = parseCLI(["config", "init"]);
    expect(args.configSubcommand).toBe("init");
  });

  it("defaults to text format", () => {
    const args = parseCLI(["review"]);
    expect(args.format).toBe("text");
  });

  it("defaults dryRun to false", () => {
    const args = parseCLI(["patch", "fix"]);
    expect(args.dryRun).toBe(false);
  });

  it("defaults assumeYes to false", () => {
    const args = parseCLI(["patch", "fix"]);
    expect(args.assumeYes).toBe(false);
  });

  it("returns null command for empty args", () => {
    const args = parseCLI([]);
    expect(args.command).toBeNull();
  });
});

describe("validateArgs", () => {
  it("throws (exits) when ask has no question", () => {
    const args = parseCLI(["ask"]);
    expect(() => validateArgs(args)).toThrow();
  });

  it("throws (exits) when plan has no goal", () => {
    const args = parseCLI(["plan"]);
    expect(() => validateArgs(args)).toThrow();
  });

  it("throws (exits) when patch has no description", () => {
    const args = parseCLI(["patch"]);
    expect(() => validateArgs(args)).toThrow();
  });

  it("throws (exits) for invalid --format value", () => {
    const args = parseCLI(["review", "--format", "xml"]);
    expect(() => validateArgs(args)).toThrow();
  });

  it("does not throw for valid ask command", () => {
    const args = parseCLI(["ask", "What is this?"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for valid plan command", () => {
    const args = parseCLI(["plan", "Add auth"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for valid patch command", () => {
    const args = parseCLI(["patch", "Fix bug"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for review command (no required args)", () => {
    const args = parseCLI(["review"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for explore command (no required args)", () => {
    const args = parseCLI(["explore"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for history command (no required args)", () => {
    const args = parseCLI(["history"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for doctor command (no required args)", () => {
    const args = parseCLI(["doctor"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for upgrade command (no required args)", () => {
    const args = parseCLI(["upgrade", "deps"]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  it("does not throw for upgrade prisma command", () => {
    const args = parseCLI(["upgrade", "prisma"]);
    expect(() => validateArgs(args)).not.toThrow();
  });
});

describe("parseCLI — upgrade subcommand", () => {
  it("parses upgrade deps", () => {
    const args = parseCLI(["upgrade", "deps"]);
    expect(args.command).toBe("upgrade");
    expect(args.upgradeSubcommand).toBe("deps");
  });

  it("parses upgrade prisma", () => {
    const args = parseCLI(["upgrade", "prisma"]);
    expect(args.command).toBe("upgrade");
    expect(args.upgradeSubcommand).toBe("prisma");
  });

  it("parses --risk flag for upgrade deps", () => {
    const args = parseCLI(["upgrade", "deps", "--risk", "major"]);
    expect(args.upgradeRisk).toBe("major");
  });

  it("parses --risk= syntax", () => {
    const args = parseCLI(["upgrade", "deps", "--risk=all"]);
    expect(args.upgradeRisk).toBe("all");
  });

  it("parses --dev flag for upgrade deps", () => {
    const args = parseCLI(["upgrade", "deps", "--dev"]);
    expect(args.upgradeDev).toBe(true);
  });

  it("parses --dry-run with upgrade deps", () => {
    const args = parseCLI(["upgrade", "deps", "--dry-run"]);
    expect(args.dryRun).toBe(true);
  });

  it("parses --yes with upgrade prisma", () => {
    const args = parseCLI(["upgrade", "prisma", "--yes"]);
    expect(args.assumeYes).toBe(true);
  });
});
