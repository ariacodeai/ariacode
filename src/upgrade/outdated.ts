/**
 * Run `npm/pnpm/yarn outdated --json` via subprocess and parse results.
 * Read-only: never executes install or update commands.
 */

import { execFile } from 'node:child_process';

export interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type: 'dependencies' | 'devDependencies' | 'peerDependencies';
  location: string;
}

/**
 * Run the package manager's `outdated --json` command and return normalized results.
 * npm outdated returns exit code 1 when outdated packages exist — that's expected.
 */
export async function getOutdatedPackages(
  projectRoot: string,
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun',
): Promise<OutdatedPackage[]> {
  const { cmd, args } = buildCommand(packageManager);
  const raw = await runOutdated(cmd, args, projectRoot);
  if (!raw.trim()) return [];
  return parseOutput(raw, packageManager);
}

function buildCommand(pm: string): { cmd: string; args: string[] } {
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['outdated', '--json'] };
    case 'yarn':
      return { cmd: 'yarn', args: ['outdated', '--json'] };
    case 'bun':
      return { cmd: 'bun', args: ['outdated', '--json'] };
    default:
      return { cmd: 'npm', args: ['outdated', '--json'] };
  }
}

function runOutdated(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      // npm outdated exits with code 1 when there are outdated packages — not an error
      if (error && stdout) {
        resolve(stdout);
        return;
      }
      if (error) {
        // Distinguish "command not found" from "outdated failed"
        const isNotFound = (error as any).code === 'ENOENT';
        const msg = isNotFound
          ? `${cmd} is not installed or not in PATH`
          : `Failed to run ${cmd} outdated: ${error.message}${stderr ? ` (${stderr.trim()})` : ''}`;
        reject(new Error(msg));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Parse JSON output from different package managers into a normalized format.
 * Each PM has a slightly different JSON structure.
 */
function parseOutput(
  raw: string,
  pm: 'npm' | 'pnpm' | 'yarn' | 'bun',
): OutdatedPackage[] {
  if (pm === 'npm' || pm === 'bun') return parseNpmOutput(raw);
  if (pm === 'pnpm') return parsePnpmOutput(raw);
  return parseYarnOutput(raw);
}

/**
 * npm outdated --json returns:
 * { "package-name": { "current": "1.0.0", "wanted": "1.0.1", "latest": "2.0.0", "type": "dependencies", "location": "..." } }
 */
function parseNpmOutput(raw: string): OutdatedPackage[] {
  const data = JSON.parse(raw) as Record<
    string,
    { current?: string; wanted?: string; latest?: string; type?: string; location?: string }
  >;
  return Object.entries(data)
    .filter(([, v]) => v.current && v.latest)
    .map(([name, v]) => ({
      name,
      current: v.current!,
      wanted: v.wanted ?? v.current!,
      latest: v.latest!,
      type: normalizeDepType(v.type),
      location: v.location ?? '',
    }));
}

/**
 * pnpm outdated --json returns an array:
 * [{ "packageName": "...", "current": "...", "latest": "...", "wanted": "...", "dependencyType": "..." }]
 */
function parsePnpmOutput(raw: string): OutdatedPackage[] {
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : [];
  return list
    .filter((p: any) => p.current && p.latest)
    .map((p: any) => ({
      name: p.packageName ?? p.name ?? '',
      current: p.current,
      wanted: p.wanted ?? p.current,
      latest: p.latest,
      type: normalizeDepType(p.dependencyType ?? p.type),
      location: p.location ?? '',
    }));
}

/**
 * yarn outdated --json outputs newline-delimited JSON.
 * The "data" table row format: [name, current, wanted, latest, type, url]
 */
function parseYarnOutput(raw: string): OutdatedPackage[] {
  const results: OutdatedPackage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'table' && obj.data?.body) {
        for (const row of obj.data.body) {
          if (row.length >= 5) {
            results.push({
              name: row[0],
              current: row[1],
              wanted: row[2],
              latest: row[3],
              type: normalizeDepType(row[4]),
              location: '',
            });
          }
        }
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return results;
}

function normalizeDepType(
  raw?: string,
): 'dependencies' | 'devDependencies' | 'peerDependencies' {
  if (!raw) return 'dependencies';
  const lower = raw.toLowerCase();
  if (lower.includes('dev')) return 'devDependencies';
  if (lower.includes('peer')) return 'peerDependencies';
  return 'dependencies';
}
