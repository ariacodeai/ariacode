import { describe, it, expect, beforeEach } from "vitest";
import {
  initUI,
  resolveColorEnabled,
  isColorEnabled,
  isQuietMode,
  bold,
  dim,
  green,
  red,
  yellow,
  cyan,
  renderDiff,
  generateAndRenderDiff,
  renderTable,
  formatPath,
  formatPaths,
} from "../../src/ui.js";

describe("resolveColorEnabled", () => {
  it("returns true for 'always'", () => {
    expect(resolveColorEnabled("always")).toBe(true);
  });

  it("returns false for 'never'", () => {
    expect(resolveColorEnabled("never")).toBe(false);
  });

  it("returns boolean for 'auto' (depends on TTY)", () => {
    const result = resolveColorEnabled("auto");
    expect(typeof result).toBe("boolean");
  });
});

describe("initUI and state", () => {
  it("sets color enabled to false for 'never'", () => {
    initUI("never", false);
    expect(isColorEnabled()).toBe(false);
  });

  it("sets color enabled to true for 'always'", () => {
    initUI("always", false);
    expect(isColorEnabled()).toBe(true);
  });

  it("sets quiet mode", () => {
    initUI("never", true);
    expect(isQuietMode()).toBe(true);
  });

  it("clears quiet mode", () => {
    initUI("never", false);
    expect(isQuietMode()).toBe(false);
  });
});

describe("color helpers with colors disabled", () => {
  beforeEach(() => {
    initUI("never", false);
  });

  it("bold returns plain text when colors disabled", () => {
    expect(bold("hello")).toBe("hello");
  });

  it("dim returns plain text when colors disabled", () => {
    expect(dim("hello")).toBe("hello");
  });

  it("green returns plain text when colors disabled", () => {
    expect(green("hello")).toBe("hello");
  });

  it("red returns plain text when colors disabled", () => {
    expect(red("hello")).toBe("hello");
  });

  it("yellow returns plain text when colors disabled", () => {
    expect(yellow("hello")).toBe("hello");
  });

  it("cyan returns plain text when colors disabled", () => {
    expect(cyan("hello")).toBe("hello");
  });
});

describe("renderDiff", () => {
  beforeEach(() => {
    initUI("never", false);
  });

  it("returns the diff text unchanged when colors disabled", () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
    const result = renderDiff(diff);
    expect(result).toBe(diff);
  });

  it("handles empty diff", () => {
    expect(renderDiff("")).toBe("");
  });
});

describe("generateAndRenderDiff", () => {
  beforeEach(() => {
    initUI("never", false);
  });

  it("generates a diff between two strings", () => {
    const result = generateAndRenderDiff("file.ts", "old content\n", "new content\n");
    expect(result).toContain("-old content");
    expect(result).toContain("+new content");
  });

  it("generates empty diff for identical content", () => {
    const result = generateAndRenderDiff("file.ts", "same\n", "same\n");
    // No actual change lines (lines starting with + or - that aren't the file headers)
    const lines = result.split("\n");
    const changelines = lines.filter(
      (l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")
    );
    expect(changelines.length).toBe(0);
  });
});

describe("renderTable", () => {
  beforeEach(() => {
    initUI("never", false);
  });

  it("renders a table with headers and rows", () => {
    const result = renderTable(
      { head: ["ID", "Command", "Status"] },
      [["abc-123", "ask", "completed"]]
    );
    expect(result).toContain("ID");
    expect(result).toContain("Command");
    expect(result).toContain("Status");
    expect(result).toContain("abc-123");
    expect(result).toContain("ask");
    expect(result).toContain("completed");
  });

  it("renders empty table", () => {
    const result = renderTable({ head: ["Col1", "Col2"] }, []);
    expect(result).toContain("Col1");
    expect(result).toContain("Col2");
  });
});

describe("formatPath", () => {
  it("returns relative path within project root", () => {
    const result = formatPath("/project/src/index.ts", "/project");
    expect(result).toBe("src/index.ts");
  });

  it("returns '.' for project root itself", () => {
    const result = formatPath("/project", "/project");
    expect(result).toBe(".");
  });

  it("returns original path for paths outside project root", () => {
    const result = formatPath("/etc/passwd", "/project");
    expect(result).toBe("/etc/passwd");
  });
});

describe("formatPaths", () => {
  it("formats multiple paths", () => {
    const result = formatPaths(
      ["/project/src/a.ts", "/project/src/b.ts"],
      "/project"
    );
    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("handles empty array", () => {
    expect(formatPaths([], "/project")).toEqual([]);
  });
});
