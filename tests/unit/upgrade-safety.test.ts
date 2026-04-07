/**
 * Property tests 21 & 22: Verify that upgrade commands never run
 * install or migrate commands.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Property 21: Aria Never Runs Install Commands
 * For any `aria upgrade *` invocation with any flags, no subprocess call
 * to npm install, pnpm install, yarn install, or bun install is made.
 *
 * Property 22: Aria Never Runs prisma migrate
 * For any `aria upgrade prisma` invocation, no subprocess call to
 * prisma migrate * is made.
 *
 * We verify this statically by scanning the source code of upgrade modules.
 */

const UPGRADE_FILES = [
  'src/actions/upgrade-deps.ts',
  'src/actions/upgrade-prisma.ts',
  'src/upgrade/outdated.ts',
  'src/upgrade/classifier.ts',
  'src/upgrade/changelog.ts',
  'src/upgrade/prisma-upgrade.ts',
];

const INSTALL_PATTERNS = [
  /execFile\s*\([^)]*['"](?:npm|pnpm|yarn|bun)['"]\s*,\s*\[[^\]]*['"]install['"]/,
  /execFile\s*\([^)]*['"](?:npm|pnpm|yarn|bun)['"]\s*,\s*\[[^\]]*['"]update['"]/,
  /execFile\s*\([^)]*['"](?:npm|pnpm|yarn|bun)['"]\s*,\s*\[[^\]]*['"]add['"]/,
  /exec\s*\(\s*['"](?:npm|pnpm|yarn|bun)\s+install/,
  /exec\s*\(\s*['"](?:npm|pnpm|yarn|bun)\s+update/,
];

const MIGRATE_PATTERNS = [
  /execFile\s*\([^)]*['"]prisma['"]\s*,\s*\[[^\]]*['"]migrate['"]/,
  /exec\s*\(\s*['"](?:npx\s+)?prisma\s+migrate/,
];

describe('Property 21: Aria Never Runs Install Commands', () => {
  for (const file of UPGRADE_FILES) {
    it(`${file} does not contain install/update subprocess calls`, () => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) return; // skip if file doesn't exist yet
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const pattern of INSTALL_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

describe('Property 22: Aria Never Runs prisma migrate', () => {
  for (const file of UPGRADE_FILES) {
    it(`${file} does not contain prisma migrate subprocess calls`, () => {
      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const pattern of MIGRATE_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});
