/**
 * aria db explain — analyze Prisma Client usage, explain performance characteristics.
 * Forced read-only (plan mode). Never mutates.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { getConfig } from '../config.js';
import { parsePrismaSchema } from '../db/schema.js';
import { renderSchemaSummary } from '../db/summary.js';
import { detectProjectType } from '../repo.js';
import { createProvider } from '../provider.js';
import { initializeDatabase, createSession, updateSessionStatus, logMessage } from '../storage.js';
import {
  readFileTool,
  searchCodeTool,
  readPrismaSchemaParserTool,
  findPrismaUsageTool,
  findModelReferencesTool,
} from '../tools.js';
import { agentLoop, UserCancelledError } from '../agent.js';
import { initUI, info, error as uiError, yellow } from '../ui.js';
import { ConfirmCancelledError } from '../ui.js';
import type { ExecutionContext } from '../context.js';
import type { Tool } from '../tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_EXPLAIN_TOOLS: Tool[] = [
  readPrismaSchemaParserTool,
  findPrismaUsageTool,
  findModelReferencesTool,
  readFileTool,
  searchCodeTool,
];

export interface DbExplainOptions {
  description: string;
  file?: string;
  session?: string;
  quiet?: boolean;
  projectRoot?: string;
  /** Override provider (v0.2.2) */
  provider?: string;
  /** Override LLM model (v0.2.2) */
  model?: string;
}

export async function runDbExplain(options: DbExplainOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = getConfig(projectRoot, { quiet: options.quiet, provider: options.provider, model: options.model });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  const schemaInfo = parsePrismaSchema(projectRoot);
  if (!schemaInfo) {
    uiError('No schema.prisma found. aria db explain requires a Prisma project.');
    process.exit(5);
  }

  const project = detectProjectType(projectRoot);
  const db = initializeDatabase();

  let sessionId: string;
  if (options.session) {
    const { getSession } = await import('../storage.js');
    const existing = getSession(db, options.session);
    if (!existing) {
      uiError(`Session not found: ${options.session}`);
      process.exit(1);
    }
    sessionId = existing.id;
  } else {
    sessionId = randomUUID();
    createSession(db, {
      id: sessionId,
      command: 'db explain',
      projectRoot,
      provider: config.provider.default,
      model: config.provider.model,
    });
  }

  let provider;
  try {
    provider = createProvider(config.provider.default, config.provider);
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
    mode: 'plan',
    dryRun: false,
    assumeYes: false,
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  const schemaSummary = renderSchemaSummary(schemaInfo, false);

  const systemPrompt = buildDbExplainPrompt({
    projectType: project.type,
    schemaPath: schemaInfo.path,
    datasourceProvider: schemaInfo.datasourceProvider ?? 'unknown',
    schemaSummary,
    templateDir: path.join(__dirname, '..', 'prompts'),
  });

  logMessage(db, sessionId, 'system', systemPrompt);

  let userRequest = options.description;
  if (options.file) {
    userRequest = `[Focus on file: ${options.file}]\n\n${userRequest}`;
  }

  try {
    await agentLoop(ctx, userRequest, DB_EXPLAIN_TOOLS, provider, config, 'db explain', db, systemPrompt);
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

function buildDbExplainPrompt(opts: {
  projectType: string;
  schemaPath: string;
  datasourceProvider: string;
  schemaSummary: string;
  templateDir: string;
}): string {
  const templatePath = path.join(opts.templateDir, 'db_explain.md');
  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    template = 'You are Aria Code\'s Prisma query analyzer. Schema: {{schemaSummary}}';
  }

  return template
    .replace(/\{\{projectType\}\}/g, opts.projectType)
    .replace(/\{\{schemaPath\}\}/g, opts.schemaPath)
    .replace(/\{\{datasourceProvider\}\}/g, opts.datasourceProvider)
    .replace(/\{\{schemaSummary\}\}/g, () => opts.schemaSummary);
}
