import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectProjectType } from "../../src/repo.js";

function createProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aria-repo-test-"));
}

function writePackageJson(dir: string, content: object): void {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(content));
}

describe("detectProjectType", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createProjectDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when no package.json exists", () => {
    expect(() => detectProjectType(tmpDir)).toThrow("No package.json found");
  });

  it("detects Node.js project (fallback)", () => {
    writePackageJson(tmpDir, { name: "my-app", dependencies: {} });
    const info = detectProjectType(tmpDir);
    expect(info.type).toBe("nodejs");
    expect(info.hasPrisma).toBe(false);
  });

  it("detects Next.js project from dependency", () => {
    writePackageJson(tmpDir, {
      name: "my-next-app",
      dependencies: { next: "14.0.0", react: "18.0.0" },
    });
    const info = detectProjectType(tmpDir);
    expect(info.type).toBe("nextjs");
    expect(info.framework?.name).toBe("Next.js");
    expect(info.framework?.version).toBe("14.0.0");
  });

  it("detects Next.js project from next.config.js", () => {
    writePackageJson(tmpDir, { name: "my-next-app", dependencies: {} });
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), "module.exports = {}");
    const info = detectProjectType(tmpDir);
    expect(info.type).toBe("nextjs");
  });

  it("detects Next.js app router", () => {
    writePackageJson(tmpDir, {
      name: "my-next-app",
      dependencies: { next: "14.0.0" },
    });
    const appDir = path.join(tmpDir, "app");
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, "layout.tsx"), "export default function Layout() {}");
    const info = detectProjectType(tmpDir);
    expect(info.type).toBe("nextjs");
    expect(info.framework?.router).toBe("app");
  });

  it("detects Next.js pages router", () => {
    writePackageJson(tmpDir, {
      name: "my-next-app",
      dependencies: { next: "14.0.0" },
    });
    const pagesDir = path.join(tmpDir, "pages");
    fs.mkdirSync(pagesDir);
    fs.writeFileSync(path.join(pagesDir, "_app.tsx"), "export default function App() {}");
    const info = detectProjectType(tmpDir);
    expect(info.type).toBe("nextjs");
    expect(info.framework?.router).toBe("pages");
  });

  it("detects Nest.js project from dependency", () => {
    writePackageJson(tmpDir, {
      name: "my-nest-app",
      dependencies: { "@nestjs/core": "10.0.0" },
    });
    const info = detectProjectType(tmpDir);
    expect(info.type).toBe("nestjs");
    expect(info.framework?.name).toBe("Nest.js");
  });

  it("detects Nest.js project from nest-cli.json", () => {
    writePackageJson(tmpDir, { name: "my-nest-app", dependencies: {} });
    fs.writeFileSync(path.join(tmpDir, "nest-cli.json"), "{}");
    const info = detectProjectType(tmpDir);
    expect(info.type).toBe("nestjs");
  });

  it("detects Prisma from dependency", () => {
    writePackageJson(tmpDir, {
      name: "my-app",
      dependencies: { prisma: "5.0.0" },
    });
    const info = detectProjectType(tmpDir);
    expect(info.hasPrisma).toBe(true);
  });

  it("detects Prisma from @prisma/client dependency", () => {
    writePackageJson(tmpDir, {
      name: "my-app",
      dependencies: { "@prisma/client": "5.0.0" },
    });
    const info = detectProjectType(tmpDir);
    expect(info.hasPrisma).toBe(true);
  });

  it("detects Prisma from schema file", () => {
    writePackageJson(tmpDir, { name: "my-app", dependencies: {} });
    const prismaDir = path.join(tmpDir, "prisma");
    fs.mkdirSync(prismaDir);
    fs.writeFileSync(path.join(prismaDir, "schema.prisma"), "datasource db {}");
    const info = detectProjectType(tmpDir);
    expect(info.hasPrisma).toBe(true);
    expect(info.prismaSchemaPath).toBe(path.join(prismaDir, "schema.prisma"));
  });

  it("detects npm from package-lock.json", () => {
    writePackageJson(tmpDir, { name: "my-app", dependencies: {} });
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
    const info = detectProjectType(tmpDir);
    expect(info.packageManager).toBe("npm");
  });

  it("detects pnpm from pnpm-lock.yaml", () => {
    writePackageJson(tmpDir, { name: "my-app", dependencies: {} });
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    const info = detectProjectType(tmpDir);
    expect(info.packageManager).toBe("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    writePackageJson(tmpDir, { name: "my-app", dependencies: {} });
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    const info = detectProjectType(tmpDir);
    expect(info.packageManager).toBe("yarn");
  });

  it("returns correct packageJsonPath", () => {
    writePackageJson(tmpDir, { name: "my-app", dependencies: {} });
    const info = detectProjectType(tmpDir);
    expect(info.packageJsonPath).toBe(path.join(tmpDir, "package.json"));
  });

  it("returns correct rootPath", () => {
    writePackageJson(tmpDir, { name: "my-app", dependencies: {} });
    const info = detectProjectType(tmpDir);
    expect(info.rootPath).toBe(tmpDir);
  });
});
