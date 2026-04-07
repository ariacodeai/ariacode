/**
 * Classify dependency upgrades by semver risk level.
 */

import semver from 'semver';
import type { OutdatedPackage } from './outdated.js';

export type UpgradeRisk = 'patch' | 'minor' | 'major' | 'prerelease';

export interface ClassifiedUpgrade {
  name: string;
  current: string;
  target: string;
  risk: UpgradeRisk;
  type: 'dependencies' | 'devDependencies' | 'peerDependencies';
  reasoning: string;
}

/**
 * Classify the risk of upgrading from `current` to `target` using semver.diff().
 */
export function classifyUpgrade(current: string, target: string): UpgradeRisk {
  const parsedTarget = semver.parse(target) ?? semver.parse(semver.coerce(target));
  const parsedCurrent = semver.parse(semver.coerce(current));
  if (!parsedCurrent || !parsedTarget) return 'major';

  // If target has a prerelease tag, classify as prerelease regardless of diff
  if (parsedTarget.prerelease.length > 0) return 'prerelease';

  const diff = semver.diff(parsedCurrent.version, parsedTarget.version);
  if (!diff) return 'patch'; // same version

  switch (diff) {
    case 'patch':
      return 'patch';
    case 'minor':
      return 'minor';
    case 'major':
    case 'premajor':
      return 'major';
    case 'preminor':
    case 'prepatch':
    case 'prerelease':
      return 'prerelease';
    default:
      return 'major';
  }
}

/**
 * Classify a list of outdated packages into risk-annotated upgrades.
 */
export function classifyAll(packages: OutdatedPackage[]): ClassifiedUpgrade[] {
  return packages.map((pkg) => {
    const risk = classifyUpgrade(pkg.current, pkg.latest);
    return {
      name: pkg.name,
      current: pkg.current,
      target: pkg.latest,
      risk,
      type: pkg.type,
      reasoning: buildReasoning(risk, pkg.current, pkg.latest),
    };
  });
}

/**
 * Group classified upgrades by risk level.
 */
export function groupByRisk(
  upgrades: ClassifiedUpgrade[],
): Record<UpgradeRisk, ClassifiedUpgrade[]> {
  const groups: Record<UpgradeRisk, ClassifiedUpgrade[]> = {
    patch: [],
    minor: [],
    major: [],
    prerelease: [],
  };
  for (const u of upgrades) {
    groups[u.risk].push(u);
  }
  return groups;
}

function buildReasoning(risk: UpgradeRisk, current: string, target: string): string {
  switch (risk) {
    case 'patch':
      return `Bug fix: ${current} → ${target}`;
    case 'minor':
      return `New features (backward-compatible): ${current} → ${target}`;
    case 'major':
      return `Breaking changes possible: ${current} → ${target}`;
    case 'prerelease':
      return `Pre-release version: ${current} → ${target}`;
  }
}
