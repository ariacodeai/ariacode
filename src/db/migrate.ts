/**
 * Schema change proposal helpers for aria db migrate.
 * Validates proposed schema content and generates diffs.
 * Never executes prisma migrate commands.
 */

import { createPatch } from 'diff';
import { parsePrismaSchemaContent } from './schema.js';
import type { MutationSummary } from '../context.js';
import { randomUUID } from 'node:crypto';

export interface SchemaChangeProposal {
  diffId: string;
  diff: string;
  summary: MutationSummary;
  schemaPath: string;
  newContent: string;
}

/**
 * Validate that content is parseable as a Prisma schema.
 * Returns null on success, error message on failure.
 */
export function validateSchemaContent(content: string): string | null {
  try {
    parsePrismaSchemaContent(content);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Build a SchemaChangeProposal from old and new schema content.
 */
export function buildSchemaChangeProposal(
  schemaPath: string,
  oldContent: string,
  newContent: string,
): SchemaChangeProposal {
  const diff = createPatch(schemaPath, oldContent, newContent, 'current', 'proposed');
  const diffId = randomUUID();

  const summary: MutationSummary = {
    action: 'db_migrate_schema',
    affectedFiles: [schemaPath],
    commandsToRun: [],
    migrations: [],
    riskLevel: 'high',
    reversible: true,
    rollbackHints: [`git checkout -- ${schemaPath}`],
    diffId,
  };

  return { diffId, diff, summary, schemaPath, newContent };
}

/**
 * Return the manual migration commands the user should run after schema update.
 */
export function manualMigrationInstructions(packageManager: string = 'npx'): string {
  const pm = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npx';
  return [
    '',
    'To apply this migration, run:',
    '',
    '  Development:',
    `    ${pm} prisma migrate dev --name <migration_name>`,
    '',
    '  Production:',
    `    ${pm} prisma migrate deploy`,
    '',
    'Aria does not run migrations automatically.',
    'Review the generated SQL before applying to production.',
  ].join('\n');
}
