#!/usr/bin/env node

import pc from 'picocolors';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsk, runPlan, runPatch, runReview, runExplore, runHistory, runConfig, runDoctor } from './actions.js';
import { runDbSchema } from './actions/db-schema.js';
import { runDbAsk } from './actions/db-ask.js';
import { runDbExplain } from './actions/db-explain.js';
import { runDbMigrate } from './actions/db-migrate.js';
import { runUpgradeDeps } from './actions/upgrade-deps.js';
import { runUpgradePrisma } from './actions/upgrade-prisma.js';
import { initializeAriaHome } from './app.js';
import { parseCLI, validateArgs, GLOBAL_USAGE } from './parser.js';
import { ConfigError } from './config.js';
import { ProviderError } from './provider.js';
import { UserCancelledError } from './agent.js';
import { ConfirmCancelledError } from './ui.js';

// Re-export for consumers that import from cli.ts
export type { ParsedArgs } from './parser.js';
export { parseCLI, validateArgs } from './parser.js';

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 *   0  – success (never thrown)
 *   1  – generic error
 *   2  – invalid arguments
 *   3  – configuration error
 *   4  – provider error
 *   5  – project detection error
 *  130 – user cancelled
 */
function exitCodeFor(err: unknown): number {
  if (err instanceof UserCancelledError || err instanceof ConfirmCancelledError) return 130;
  if (err instanceof ConfigError) return 3;
  if (err instanceof ProviderError) return 4;
  if (err instanceof Error) {
    // Project detection errors surface with a specific message pattern
    if (err.message.includes('project detection') || err.message.includes('No package.json')) return 5;
  }
  return 1;
}

/**
 * Central error handler. Writes to stderr and exits with the correct code.
 */
export function handleError(err: unknown): never {
  const debug = Boolean(process.env['DEBUG']);
  const message = err instanceof Error ? err.message : String(err);

  process.stderr.write(pc.red('Error: ') + message + '\n');

  if (debug && err instanceof Error && err.stack) {
    process.stderr.write('\n' + err.stack + '\n');
  } else if (!debug) {
    process.stderr.write(pc.dim('Run with DEBUG=1 for stack trace') + '\n');
  }

  process.exit(exitCodeFor(err));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse, validate, and route to the appropriate command handler.
 */
export function run(): void {
  const args = parseCLI();

  // Handle --help / --version before validation
  if (args.command === '--help' || args.command === null) {
    console.log(GLOBAL_USAGE + `\n${pc.bold('VERSION:')}\n  ${VERSION}\n`);
    process.exit(0);
  }

  if (args.command === '--version') {
    console.log(VERSION);
    process.exit(0);
  }

  validateArgs(args);

  // First-run initialization: create ~/.aria dir, history.db, and default config
  try {
    initializeAriaHome();
  } catch {
    // Non-fatal: continue even if initialization fails
  }

  switch (args.command) {
    case 'doctor':
      runDoctor({
        format: args.format as 'text' | 'json' | 'ndjson' | 'plain' | undefined,
      }).catch(handleError);
      break;

    case 'ask':
      runAsk({
        question: args.question!,
        session: args.session,
        maxTokens: args.maxTokens,
        quiet: args.quiet,
        provider: args.provider,
        model: args.model,
        format: args.format,
      }).catch(handleError);
      break;

    case 'plan':
      runPlan({
        goal: args.goal!,
        session: args.session,
        output: args.output,
        quiet: args.quiet,
        provider: args.provider,
        model: args.model,
        format: args.format,
      }).catch(handleError);
      break;

    case 'patch':
      runPatch({
        description: args.description!,
        dryRun: args.dryRun,
        yes: args.assumeYes,
        session: args.session,
        quiet: args.quiet,
        provider: args.provider,
        model: args.model,
        split: args.historySplit,
        format: args.format,
      }).catch(handleError);
      break;

    case 'review':
      runReview({
        unstaged: args.unstaged,
        branch: args.branch,
        format: args.format,
        quiet: args.quiet,
        provider: args.provider,
        model: args.model,
      }).catch(handleError);
      break;

    case 'config':
      runConfig({
        subcommand: args.configSubcommand,
        key: args.configKey,
        value: args.configValue,
        dryRun: args.dryRun,
        yes: args.assumeYes,
        quiet: args.quiet,
      }).catch(handleError);
      break;

    case 'history':
      runHistory({
        limit: args.limit,
        session: args.session,
        tree: args.tree,
        quiet: args.quiet,
        search: args.historySearch,
        command: args.historyCommand,
        since: args.historySince,
        status: args.historyStatus,
        export: args.historyExport,
        format: args.format,
      }).catch(handleError);
      break;

    case 'explore':
      runExplore({
        depth: args.depth,
        save: args.save,
        quiet: args.quiet,
        provider: args.provider,
        model: args.model,
        format: args.format,
      }).catch(handleError);
      break;

    case 'db':
      switch (args.dbSubcommand) {
        case 'schema':
          runDbSchema({
            json: args.dbJson,
            prismaModel: args.dbModel,
            quiet: args.quiet,
            format: args.format,
          }).catch(handleError);
          break;
        case 'ask':
          if (!args.dbQuestion) {
            console.error(pc.red('Error: db ask requires a <question> argument'));
            process.exit(2);
          }
          runDbAsk({
            question: args.dbQuestion,
            session: args.session,
            prismaModel: args.dbModel,
            quiet: args.quiet,
            provider: args.provider,
            model: args.model,
            format: args.format,
          }).catch(handleError);
          break;
        case 'explain':
          if (!args.dbDescription) {
            console.error(pc.red('Error: db explain requires a <description> argument'));
            process.exit(2);
          }
          runDbExplain({
            description: args.dbDescription,
            file: args.dbFile,
            session: args.session,
            quiet: args.quiet,
            provider: args.provider,
            model: args.model,
            format: args.format,
          }).catch(handleError);
          break;
        case 'migrate':
          if (!args.dbDescription) {
            console.error(pc.red('Error: db migrate requires a <description> argument'));
            process.exit(2);
          }
          runDbMigrate({
            description: args.dbDescription,
            dryRun: args.dryRun,
            yes: args.assumeYes,
            session: args.session,
            quiet: args.quiet,
            provider: args.provider,
            model: args.model,
          }).catch(handleError);
          break;
        default:
          console.error(pc.red('Usage: aria db <schema|ask|explain|migrate>'));
          process.exit(2);
      }
      break;

    case 'upgrade':
      switch (args.upgradeSubcommand) {
        case 'deps':
          runUpgradeDeps({
            dryRun: args.dryRun,
            yes: args.assumeYes,
            risk: args.upgradeRisk,
            dev: args.upgradeDev,
            session: args.session,
            quiet: args.quiet,
            provider: args.provider,
            model: args.model,
            format: args.format,
          }).catch(handleError);
          break;
        case 'prisma':
          runUpgradePrisma({
            dryRun: args.dryRun,
            yes: args.assumeYes,
            session: args.session,
            quiet: args.quiet,
            provider: args.provider,
            model: args.model,
          }).catch(handleError);
          break;
        default:
          console.error(pc.red('Usage: aria upgrade <deps|prisma>'));
          process.exit(2);
      }
      break;

    default:
      console.error(pc.red(`Unknown command: "${args.command}"`));
      console.error(GLOBAL_USAGE);
      process.exit(2);
  }
}

run();
