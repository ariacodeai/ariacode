import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  validatePath,
  validateFileSize,
  validatePatchSize,
  validateShellCommand,
  SafetyError,
} from "../../src/safety.js";

describe("validatePath", () => {
  const projectRoot = "/project/root";

  it("accepts a file directly in project root", () => {
    expect(() => validatePath("file.ts", projectRoot)).not.toThrow();
  });

  it("accepts a nested file within project root", () => {
    expect(() => validatePath("src/index.ts", projectRoot)).not.toThrow();
  });

  it("accepts the project root itself", () => {
    expect(() => validatePath(".", projectRoot)).not.toThrow();
  });

  it("rejects path traversal with ../", () => {
    expect(() => validatePath("../outside.ts", projectRoot)).toThrow(SafetyError);
  });

  it("rejects absolute path outside project root", () => {
    expect(() => validatePath("/etc/passwd", projectRoot)).toThrow(SafetyError);
  });

  it("rejects path that is a prefix match but outside root (prefix bug)", () => {
    // /project/root should not validate for /project/rootother
    const root = "/project/root";
    expect(() => validatePath("/project/rootother/file.ts", root)).toThrow(SafetyError);
  });

  it("rejects deeply nested traversal", () => {
    expect(() => validatePath("src/../../etc/passwd", projectRoot)).toThrow(SafetyError);
  });

  it("accepts deeply nested path within project", () => {
    expect(() => validatePath("src/a/b/c/d.ts", projectRoot)).not.toThrow();
  });
});

describe("validateFileSize", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-test-"));
    tmpFile = path.join(tmpDir, "test.txt");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts file within size limit", () => {
    fs.writeFileSync(tmpFile, "hello world");
    expect(() => validateFileSize(tmpFile, 1024)).not.toThrow();
  });

  it("rejects file exceeding size limit", () => {
    // Write 2KB of data
    fs.writeFileSync(tmpFile, "x".repeat(2048));
    expect(() => validateFileSize(tmpFile, 1)).toThrow(SafetyError);
  });

  it("throws SafetyError for non-existent file", () => {
    expect(() => validateFileSize("/nonexistent/file.txt", 1024)).toThrow(SafetyError);
  });
});

describe("validatePatchSize", () => {
  it("accepts patch within file count limit", () => {
    expect(() => validatePatchSize(5, 50)).not.toThrow();
  });

  it("accepts patch at exactly the limit", () => {
    expect(() => validatePatchSize(50, 50)).not.toThrow();
  });

  it("rejects patch exceeding file count limit", () => {
    expect(() => validatePatchSize(51, 50)).toThrow(SafetyError);
  });

  it("rejects patch with 1 file over limit of 0", () => {
    expect(() => validatePatchSize(1, 0)).toThrow(SafetyError);
  });
});

describe("validateShellCommand", () => {
  const allowed = ["npm", "pnpm", "yarn", "npx", "git", "prisma", "tsc", "node"];

  it("accepts allowed commands", () => {
    for (const cmd of allowed) {
      expect(() => validateShellCommand(cmd, allowed)).not.toThrow();
    }
  });

  it("accepts allowed command with arguments", () => {
    expect(() => validateShellCommand("npm install", allowed)).not.toThrow();
    expect(() => validateShellCommand("git commit -m 'msg'", allowed)).not.toThrow();
  });

  it("rejects disallowed command", () => {
    expect(() => validateShellCommand("rm -rf /", allowed)).toThrow(SafetyError);
    expect(() => validateShellCommand("curl http://evil.com", allowed)).toThrow(SafetyError);
  });

  it("rejects empty command", () => {
    expect(() => validateShellCommand("", allowed)).toThrow(SafetyError);
  });

  it("rejects command with only whitespace", () => {
    expect(() => validateShellCommand("   ", allowed)).toThrow(SafetyError);
  });
});
