/**
 * aria db ask — Q&A over Prisma schema, generates Prisma Client code.
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

const DB_ASK_TOOLS: Tool[] = [
  readPrismaSchemaParserTool,
  findPrismaUsageTool,
  findModelReferencesTool,
  readFileTool,
  searchCodeTool,
];

const SENSITIVE_PATTERN = /password|token|secret|hash|apiKey|stripeCustomerId|ssn/i;

export interface DbAskOptions {
  question: string;
  session?: string;
  model?: string; // Prisma model filter hint
  quiet?: boolean;
  projectRoot?: string;
}

export async function runDbAsk(options: DbAskOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = getConfig(projectRoot, { quiet: options.quiet });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  // Validate schema exists
  const schemaInfo = parsePrismaSchema(projectRoot);
  if (!schemaInfo) {
    uiError('No schema.prisma found. aria db ask requires a Prisma project.');
    process.exit(5);
  }

  const project = detectProjectType(projectRoot);
  const db = initializeDatabase();

  let sessionId: string;
  if (options.session) {
    // Validate session exists before resuming
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
      command: 'db ask',
      projectRoot,
      provider: config.provider.default,
      model: config.provider.model,
    });
  }

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
    mode: 'plan', // always read-only
    dryRun: false,
    assumeYes: false,
    maxIterations: config.agent.maxIterations,
    timeoutSeconds: config.agent.timeoutSeconds,
  };

  const schemaSummary = renderSchemaSummary(schemaInfo, false);

  const systemPrompt = buildDbAskPrompt({
    projectType: project.type,
    schemaPath: schemaInfo.path,
    datasourceProvider: schemaInfo.datasourceProvider ?? 'unknown',
    schemaSummary,
    templateDir: path.join(__dirname, '..', 'prompts'),
  });

  logMessage(db, sessionId, 'system', systemPrompt);

  // Prepend sensitivity warning hint to question if relevant
  let userRequest = options.question;
  if (options.model) {
    userRequest = `[Focus on model: ${options.model}]\n\n${userRequest}`;
  }
  if (SENSITIVE_PATTERN.test(options.question)) {
    userRequest = `[NOTE: This question may involve sensitive fields. Add a WARNING above the code.]\n\n${userRequest}`;
  }

  try {
    await agentLoop(ctx, userRequest, DB_ASK_TOOLS, provider, config, 'db ask', db, systemPrompt);
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

function buildDbAskPrompt(opts: {
  projectType: string;
  schemaPath: string;
  datasourceProvider: string;
  schemaSummary: string;
  templateDir: string;
}): string {
  const templatePath = path.join(opts.templateDir, 'db_ask.md');
  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    template = 'You are Aria Code\'s Prisma DB Assistant. Schema: {{schemaSummary}}';
  }

  return template
    .replace(/\{\{projectType\}\}/g, opts.projectType)
    .replace(/\{\{schemaPath\}\}/g, opts.schemaPath)
    .replace(/\{\{datasourceProvider\}\}/g, opts.datasourceProvider)
    .replace(/\{\{schemaSummary\}\}/g, () => opts.schemaSummary);
}
