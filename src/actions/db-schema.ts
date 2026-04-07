/**
 * aria db schema — parse and render schema.prisma content.
 * No LLM call: pure parsing + rendering. Instant and free.
 */

import { parsePrismaSchema } from '../db/schema.js';
import { renderSchemaSummary, renderModelSummary } from '../db/summary.js';
import { initUI, info, error as uiError } from '../ui.js';
import { getConfig } from '../config.js';
import * as path from 'node:path';

export interface DbSchemaOptions {
  json?: boolean;
  prismaModel?: string;
  quiet?: boolean;
  projectRoot?: string;
}

export async function runDbSchema(options: DbSchemaOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = getConfig(projectRoot, { quiet: options.quiet });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  const schemaInfo = parsePrismaSchema(projectRoot);
  if (!schemaInfo) {
    uiError('No schema.prisma found in project. Run `prisma init` to create one.');
    process.exit(5);
  }

  // --json: output raw JSON
  if (options.json) {
    process.stdout.write(JSON.stringify(schemaInfo, null, 2) + '\n');
    return;
  }

  // --model <name>: filter to single model
  if (options.prismaModel) {
    const model = schemaInfo.models.find(
      (m) => m.name.toLowerCase() === options.prismaModel!.toLowerCase(),
    );
    if (!model) {
      uiError(`Model "${options.prismaModel}" not found in schema. Available: ${schemaInfo.models.map((m) => m.name).join(', ')}`);
      process.exit(2);
    }
    const colorEnabled = config.ui.color !== 'never';
    info(renderModelSummary(model, colorEnabled));
    return;
  }

  const colorEnabled = config.ui.color !== 'never';
  info(renderSchemaSummary(schemaInfo, colorEnabled));
}