/**
 * Prisma-specific upgrade logic.
 * Detects current Prisma version, fetches latest, classifies risk.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { classifyUpgrade, type UpgradeRisk } from './classifier.js';
import { readJsonFile } from '../fs-helpers.js';

export interface PrismaVersionInfo {
  currentPrisma: string;
  currentClient: string;
  latestVersion: string;
  risk: UpgradeRisk;
  hasPrisma: boolean;
}

/**
 * Detect current Prisma versions from package.json and fetch latest from npm registry.
 */
export async function getPrismaVersionInfo(projectRoot: string): Promise<PrismaVersionInfo> {
  const pkgPath = join(projectRoot, 'package.json');
  const pkg = readJsonFile(pkgPath) as Record<string, any>;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const hasPrisma = Boolean(deps.prisma || deps['@prisma/client']);
  if (!hasPrisma) {
    return { currentPrisma: '', currentClient: '', latestVersion: '', risk: 'patch', hasPrisma: false };
  }

  const currentPrisma = stripRange(deps.prisma ?? '');
  const currentClient = stripRange(deps['@prisma/client'] ?? '');
  const current = currentPrisma || currentClient;

  const latestVersion = await fetchLatestVersion('prisma');
  const risk = current && latestVersion ? classifyUpgrade(current, latestVersion) : 'major';

  return { currentPrisma, currentClient, latestVersion, risk, hasPrisma };
}

/**
 * Fetch the latest version of a package from npm registry.
 */
export async function fetchLatestVersion(packageName: string): Promise<string> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Drain the response body to free the connection
      await res.text().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as any;
    return data.version ?? '';
  } catch {
    // Fallback: use npm view via subprocess
    return npmViewVersion(packageName);
  }
}

function npmViewVersion(packageName: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('npm', ['view', packageName, 'version'], { timeout: 10_000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** Strip semver range prefixes like ^, ~, >= */
function stripRange(version: string): string {
  return version.replace(/^[\^~>=<]+/, '').trim();
}
