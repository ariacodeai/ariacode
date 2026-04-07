import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import semver from 'semver';
import { classifyUpgrade, classifyAll, groupByRisk } from '../../src/upgrade/classifier.js';
import type { OutdatedPackage } from '../../src/upgrade/outdated.js';

describe('classifyUpgrade', () => {
  it('classifies patch upgrade', () => {
    expect(classifyUpgrade('1.0.0', '1.0.1')).toBe('patch');
  });

  it('classifies minor upgrade', () => {
    expect(classifyUpgrade('1.0.0', '1.1.0')).toBe('minor');
  });

  it('classifies major upgrade', () => {
    expect(classifyUpgrade('1.0.0', '2.0.0')).toBe('major');
  });

  it('classifies prerelease upgrade', () => {
    expect(classifyUpgrade('1.0.0', '1.0.1-beta.1')).toBe('prerelease');
  });

  it('returns patch for same version', () => {
    expect(classifyUpgrade('1.0.0', '1.0.0')).toBe('patch');
  });

  it('handles versions with range prefixes via coerce', () => {
    expect(classifyUpgrade('^1.0.0', '1.1.0')).toBe('minor');
    expect(classifyUpgrade('~2.0.0', '3.0.0')).toBe('major');
  });

  it('returns major for unparseable versions', () => {
    expect(classifyUpgrade('not-a-version', 'also-not')).toBe('major');
  });
});

describe('classifyAll', () => {
  it('classifies a list of outdated packages', () => {
    const packages: OutdatedPackage[] = [
      { name: 'a', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1', type: 'dependencies', location: '' },
      { name: 'b', current: '1.0.0', wanted: '1.1.0', latest: '2.0.0', type: 'devDependencies', location: '' },
    ];
    const result = classifyAll(packages);
    expect(result).toHaveLength(2);
    expect(result[0].risk).toBe('patch');
    expect(result[1].risk).toBe('major');
  });
});

describe('groupByRisk', () => {
  it('groups upgrades by risk level', () => {
    const packages: OutdatedPackage[] = [
      { name: 'a', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1', type: 'dependencies', location: '' },
      { name: 'b', current: '1.0.0', wanted: '1.1.0', latest: '1.1.0', type: 'dependencies', location: '' },
      { name: 'c', current: '1.0.0', wanted: '1.0.0', latest: '2.0.0', type: 'dependencies', location: '' },
    ];
    const classified = classifyAll(packages);
    const groups = groupByRisk(classified);
    expect(groups.patch).toHaveLength(1);
    expect(groups.minor).toHaveLength(1);
    expect(groups.major).toHaveLength(1);
    expect(groups.prerelease).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property 20: Upgrade classification correctness
// For any semver-valid current and target versions, classifyUpgrade returns
// the correct semver diff level.
// ---------------------------------------------------------------------------
describe('Property 20: Upgrade classification correctness', () => {
  const semverArb = fc.tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
  ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

  it('classifyUpgrade matches semver.diff for valid versions', () => {
    fc.assert(
      fc.property(semverArb, semverArb, (current, target) => {
        const result = classifyUpgrade(current, target);
        const expected = semver.diff(current, target);

        // Our classifier checks for prerelease tags on the target
        const parsed = semver.parse(target);
        if (parsed && parsed.prerelease.length > 0) {
          expect(result).toBe('prerelease');
          return;
        }

        if (!expected) {
          // same version
          expect(result).toBe('patch');
          return;
        }

        switch (expected) {
          case 'patch':
            expect(result).toBe('patch');
            break;
          case 'minor':
            expect(result).toBe('minor');
            break;
          case 'major':
          case 'premajor':
            expect(result).toBe('major');
            break;
          case 'preminor':
          case 'prepatch':
          case 'prerelease':
            expect(result).toBe('prerelease');
            break;
        }
      }),
      { numRuns: 200 },
    );
  });
});
