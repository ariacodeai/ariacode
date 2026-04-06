import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Project type detection result
 * Matches the design spec interface from design.md
 */
export interface ProjectInfo {
  type: "nextjs" | "nestjs" | "nodejs";
  framework?: {
    name: string;
    version?: string;
    router?: "app" | "pages"; // Next.js specific
  };
  hasPrisma: boolean;
  prismaSchemaPath?: string;
  packageJsonPath: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  rootPath: string;
}

/**
 * Detect project type based on framework indicators
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
 */
export function detectProjectType(rootDir: string = process.cwd()): ProjectInfo {
  const rootPath = resolve(rootDir);
  const packageJsonPath = join(rootPath, 'package.json');

  // Check if package.json exists
  if (!existsSync(packageJsonPath)) {
    throw new Error('No package.json found in project root');
  }

  // Parse package.json
  let packageJson: any = null;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to parse package.json: ${error}`);
  }

  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };

  // Detect Next.js (Requirement 4.1)
  const hasNextDep = !!deps?.next;
  const hasNextConfig = 
    existsSync(join(rootPath, 'next.config.js')) ||
    existsSync(join(rootPath, 'next.config.mjs')) ||
    existsSync(join(rootPath, 'next.config.ts')) ||
    existsSync(join(rootPath, 'next.config.cjs'));

  // Detect Prisma once for all project types
  const prisma = detectPrisma(rootPath, deps);
  const packageManager = detectPackageManager(rootPath);

  if (hasNextDep || hasNextConfig) {
    // Detect Next.js router type (Requirements 4.2, 4.3)
    const router = detectNextJsRouter(rootPath);

    return {
      type: "nextjs",
      framework: {
        name: "Next.js",
        version: deps?.next,
        router,
      },
      hasPrisma: prisma.hasPrisma,
      prismaSchemaPath: prisma.prismaSchemaPath,
      packageJsonPath,
      packageManager,
      rootPath,
    };
  }

  // Detect Nest.js (Requirement 4.4)
  const hasNestDep = !!deps?.['@nestjs/core'];
  const hasNestCli = existsSync(join(rootPath, 'nest-cli.json'));

  if (hasNestDep || hasNestCli) {
    return {
      type: "nestjs",
      framework: {
        name: "Nest.js",
        version: deps?.['@nestjs/core'],
      },
      hasPrisma: prisma.hasPrisma,
      prismaSchemaPath: prisma.prismaSchemaPath,
      packageJsonPath,
      packageManager,
      rootPath,
    };
  }

  // Fallback to Node.js (Requirement 4.5)
  return {
    type: "nodejs",
    hasPrisma: prisma.hasPrisma,
    prismaSchemaPath: prisma.prismaSchemaPath,
    packageJsonPath,
    packageManager,
    rootPath,
  };
}

/**
 * Detect Next.js router type (app vs pages)
 * Requirements: 4.2, 4.3
 */
function detectNextJsRouter(rootPath: string): "app" | "pages" | undefined {
  const appDir = join(rootPath, 'app');
  const pagesDir = join(rootPath, 'pages');

  // Check for app router indicators (Requirement 4.2)
  if (existsSync(appDir)) {
    try {
      const appContents = readdirSync(appDir);
      const hasAppRouter = appContents.some(file => 
        file.startsWith('layout.') || file.startsWith('page.')
      );
      if (hasAppRouter) {
        return "app";
      }
    } catch {
      // Ignore read errors
    }
  }

  // Check for pages router indicators (Requirement 4.3)
  if (existsSync(pagesDir)) {
    try {
      const pagesContents = readdirSync(pagesDir);
      const hasPagesRouter = pagesContents.some(file => 
        file.startsWith('_app.') || file.startsWith('_document.')
      );
      if (hasPagesRouter) {
        return "pages";
      }
    }
    catch {
      // Ignore read errors
    }
  }

  // If directories exist but no clear indicators, prefer app router
  if (existsSync(appDir)) return "app";
  if (existsSync(pagesDir)) return "pages";

  return undefined;
}

/**
 * Detect Prisma presence and schema path
 * Requirement: 4.6
 */
function detectPrisma(rootPath: string, deps: Record<string, any>): {
  hasPrisma: boolean;
  prismaSchemaPath?: string;
} {
  const hasPrismaDep = !!deps?.prisma || !!deps?.['@prisma/client'];
  const prismaSchemaPath = join(rootPath, 'prisma', 'schema.prisma');
  const hasPrismaSchema = existsSync(prismaSchemaPath);

  if (hasPrismaDep || hasPrismaSchema) {
    return {
      hasPrisma: true,
      prismaSchemaPath: hasPrismaSchema ? prismaSchemaPath : undefined,
    };
  }

  return { hasPrisma: false };
}

/**
 * Detect package manager from lockfile presence
 * Requirement: 4.7
 */
function detectPackageManager(rootPath: string): "npm" | "pnpm" | "yarn" | "bun" | undefined {
  if (existsSync(join(rootPath, 'pnpm-lock.yaml'))) {
    return "pnpm";
  }
  if (existsSync(join(rootPath, 'yarn.lock'))) {
    return "yarn";
  }
  if (existsSync(join(rootPath, 'bun.lockb'))) {
    return "bun";
  }
  if (existsSync(join(rootPath, 'package-lock.json'))) {
    return "npm";
  }
  return undefined;
}
