/**
 * Find Prisma Client usage in TypeScript/JavaScript files using ripgrep.
 * No TypeScript compilation or AST parsing — fast regex-based search only.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export interface PrismaClientUsage {
  file: string;
  line: number;
  model: string;
  operation: string;
  snippet: string;
}

// Prisma Client operations we recognise
const PRISMA_OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
  '$queryRaw',
  '$executeRaw',
  '$transaction',
];

const OPERATION_PATTERN = PRISMA_OPERATIONS.join('|');

/**
 * Search for Prisma Client calls in project code.
 * Uses ripgrep for fast search, then simple regex for extraction.
 *
 * @param projectRoot - Absolute path to project root
 * @param modelName   - Optional model name filter (e.g. "user")
 */
export async function findPrismaClientUsage(
  projectRoot: string,
  modelName?: string,
): Promise<PrismaClientUsage[]> {
  // Build ripgrep pattern — escape modelName to prevent regex injection
  const escapedModel = modelName ? modelName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\w+';
  const pattern = `prisma\\.${escapedModel}\\.(${OPERATION_PATTERN})\\(`;

  const rgArgs = [
    '--json',
    '--max-count=200',
    '--type=ts',
    '--type=js',
    '-e',
    pattern,
    projectRoot,
  ];

  let output: string;
  try {
    output = execFileSync('rg', rgArgs, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      cwd: projectRoot,
    });
  } catch (err: any) {
    // ripgrep exits 1 when no matches
    if (err.status === 1) return [];
    // rg not installed — return empty gracefully
    if (err.code === 'ENOENT' || err.message?.includes('not found') || err.message?.includes('not recognized')) return [];
    throw err;
  }

  const results: PrismaClientUsage[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'match') continue;

    const filePath = path.relative(projectRoot, parsed.data.path.text);
    const lineNumber: number = parsed.data.line_number;
    const snippet: string = parsed.data.lines.text.trim();

    // Extract model and operation from the matched text
    const matchText: string = parsed.data.submatches?.[0]?.match?.text ?? snippet;
    const extracted = extractModelAndOperation(matchText, snippet);
    if (!extracted) continue;

    results.push({
      file: filePath,
      line: lineNumber,
      model: extracted.model,
      operation: extracted.operation,
      snippet,
    });
  }

  return results;
}

function extractModelAndOperation(
  matchText: string,
  fallback: string,
): { model: string; operation: string } | null {
  // Try to match prisma.<model>.<operation>(
  const re = /prisma\.(\w+)\.(\w+)\(/;
  const m = re.exec(matchText) ?? re.exec(fallback);
  if (!m) return null;
  return { model: m[1], operation: m[2] };
}
