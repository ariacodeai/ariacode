/**
 * aria db migrate — propose changes to schema.prisma only.
 * NEVER executes prisma migrate commands. User runs those manually.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

import { getConfig } from '../config.js';
import { parsePrismaSchema, findSchemaPath } from '../db/schema.js';
import { manualMigrationInstructions } from '../db/migrate.js';
import { detectProjectType } from '../repo.js';
import { createProvider } from '../provider.js';
import { initializeDatabase, resolveOrCreateSession, updateSessionStatus, logMessage, logMutation } from '../storage.js';
import { validateFileSize } from '../safety.js';
import {
  readFileTool,
  searchCodeTool,
  readPrismaSchemaParserTool,
  findPrismaUsageTool,
  proposeSchemaChangeTool,
  applySchemaChangeTool,
} from '../tools.js';
import { agentLoop, UserCancelledError } from '../agent.js';
import {
  initUI,
  info,
  error as uiError,
  yellow,
  green,
  bold,
  ConfirmCancelledError,
} from '../ui.js';
import type { ExecutionContext } from '../context.js';
import type { Tool } from '../tools.js';
import { loadPromptTemplate } from '../prompt-loader.js';

const DB_MIGRATE_TOOLS: Tool[] = [
  readPrismaSchemaParserTool,
  findPrismaUsageTool,
  readFileTool,
  searchCodeTool,
  proposeSchemaChangeTool,
  applySchemaChangeTool,
];

export interface DbMigrateOptions {
  description: string;
  dryRun?: boolean;
  yes?: boolean;
  session?: string;
  quiet?: boolean;
  projectRoot?: string;
}

export async function runDbMigrate(options: DbMigrateOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = getConfig(projectRoot, { quiet: options.quiet });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  const schemaInfo = parsePrismaSchema(projectRoot);
  if (!schemaInfo) {
    uiError('No schema.prisma found. aria db migrate requires a Prisma project.');
    process.exit(5);
  }

  const schemaAbsPath = findSchemaPath(projectRoot);
  if (!schemaAbsPath) {
    uiError('Schema file disappeared between checks. Please try again.');
    process.exit(5);
  }

  // Validate schema file size before reading
  validateFileSize(schemaAbsPath, config.safety.maxFileSizeKb);
  const schemaContent = fs.readFileSync(schemaAbsPath, 'utf-8');

  const project = detectProjectType(projectRoot);
  const db = initializeDatabase();

  const sessionId = resolveOrCreateSession(db, {
    sessionId: options.session,
    command: 'db migrate',
    projectRoot,
    provider: config.provider.default,
    model: config.provider.model,
  });

  let provider;
  try {
    provider = createProvider(config.provider.default);
  } catch (err) {
    uiError(err instanceof Error ? err.message : String(err));
    updateSessionStatus(db, sessionId, 'failed', String(err));
    process.exit(4);
  }

  const ctx: ExecutionContext = {
    projectRoot,
    sessionId,
    provider: config.provider.default,
    model: config.provider.model,
    mode: 'build',
    dryRun: Boolean(options.dryRun),
    assumeYes: Boolean(options.yes),
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  const systemPrompt = buildDbMigratePrompt({
    projectType: project.type,
    schemaPath: schemaInfo.path,
    datasourceProvider: schemaInfo.datasourceProvider ?? 'unknown',
    schemaContent,
  });

  logMessage(db, sessionId, 'system', systemPrompt);

  if (options.dryRun) {
    info(bold('Dry-run mode — schema.prisma will not be modified.'));
  }

  try {
    await agentLoop(ctx, options.description, DB_MIGRATE_TOOLS, provider, config, 'db migrate', db, systemPrompt);

    if (!options.dryRun) {
      // Log the mutation
      logMutation(db, sessionId, {
        action: 'db_migrate_schema',
        affectedFiles: [schemaInfo.path],
        riskLevel: 'high',
        reversible: true,
        rollbackHints: [`git checkout -- ${schemaInfo.path}`],
      });

      info('');
      info(green(`✓ Schema updated: ${schemaInfo.path}`));
      info(manualMigrationInstructions(project.packageManager ?? 'npx'));
    } else {
      info('');
      info(yellow('Dry-run complete — schema.prisma was not modified.'));
    }

    updateSessionStatus(db, sessionId, 'completed');
  } catch (err) {
    if (err instanceof UserCancelledError || err instanceof ConfirmCancelledError) {
      info(yellow('Operation cancelled.'));
      updateSessionStatus(db, sessionId, 'cancelled');
      process.exit(130);
    }
    const message = err instanceof Error ? err.message : String(err);
    uiError(message);
    updateSessionStatus(db, sessionId, 'failed', message);
    process.exit(1);
  }
}

function buildDbMigratePrompt(opts: {
  projectType: string;
  schemaPath: string;
  datasourceProvider: string;
  schemaContent: string;
}): string {
  const template = loadPromptTemplate(
    'db_migrate',
    'You are Aria Code\'s schema migration assistant. Current schema:\n\n{{schemaContent}}',
  );

  // Use function replacer for schemaContent to avoid $& / $1 injection from schema text
  return template
    .replace(/\{\{projectType\}\}/g, opts.projectType)
    .replace(/\{\{schemaPath\}\}/g, opts.schemaPath)
    .replace(/\{\{datasourceProvider\}\}/g, opts.datasourceProvider)
    .replace(/\{\{schemaContent\}\}/g, () => opts.schemaContent);
}
