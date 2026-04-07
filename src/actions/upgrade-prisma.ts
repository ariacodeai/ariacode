/**
 * aria upgrade prisma — Prisma-specific upgrade with migration guidance.
 * Updates package.json only. Never runs install or migrate commands.
 */

import * as path from 'node:path';

import { getConfig, type Config } from '../config.js';
import { detectProjectType } from '../repo.js';
import { parsePrismaSchema } from '../db/schema.js';
import { createProvider } from '../provider.js';
import {
  initializeDatabase,
  resolveOrCreateSession,
  updateSessionStatus,
  logMessage,
  logMutation,
} from '../storage.js';
import {
  initUI,
  info,
  success,
  warn,
  error as uiError,
  bold,
  dim,
  confirm,
  ConfirmCancelledError,
  createSpinner,
} from '../ui.js';
import { getPrismaVersionInfo } from '../upgrade/prisma-upgrade.js';
import { readJsonFile, writeFileAtomic } from '../fs-helpers.js';
import { loadPromptTemplate } from '../prompt-loader.js';

export interface UpgradePrismaOptions {
  dryRun?: boolean;
  yes?: boolean;
  session?: string;
  quiet?: boolean;
  projectRoot?: string;
  /** Override provider (v0.2.2) */
  provider?: string;
  /** Override LLM model (v0.2.2) */
  model?: string;
}

export async function runUpgradePrisma(options: UpgradePrismaOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = getConfig(projectRoot, { quiet: options.quiet, provider: options.provider, model: options.model });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  const project = detectProjectType(projectRoot);
  const pm = project.packageManager ?? 'npm';

  // 1. Check if project has Prisma
  const versionInfo = await getPrismaVersionInfo(projectRoot);
  if (!versionInfo.hasPrisma) {
    uiError('Prisma not detected in this project');
    process.exit(5);
  }

  const current = versionInfo.currentPrisma || versionInfo.currentClient;
  if (!current) {
    uiError('Could not determine current Prisma version from package.json');
    process.exit(5);
  }

  // 2. Fetch latest version
  const spinner = createSpinner('Checking latest Prisma version...');
  spinner.start();

  if (!versionInfo.latestVersion) {
    spinner.fail('Could not fetch latest Prisma version');
    process.exit(1);
  }

  if (current === versionInfo.latestVersion) {
    spinner.succeed(`Prisma is up to date (${current})`);
    return;
  }

  spinner.succeed(
    `Prisma upgrade available: ${current} → ${versionInfo.latestVersion} (${versionInfo.risk})`,
  );

  // 3. For major upgrades, use LLM for migration guidance
  const affectedFiles = ['package.json'];
  if (versionInfo.risk === 'major' && project.prismaSchemaPath) {
    affectedFiles.push(project.prismaSchemaPath);
    await generateMigrationGuidance(
      current,
      versionInfo.latestVersion,
      projectRoot,
      config,
    );
  }

  // 4. Show risk info
  info('');
  info(dim(`Risk: high | Files: ${affectedFiles.join(', ')} | Reversible: yes`));

  // 5. Handle dry-run / confirmation
  if (options.dryRun) {
    warn('Dry-run mode — package.json will not be modified.');
    return;
  }

  if (!options.yes) {
    const ok = await confirm('Apply Prisma upgrade to package.json?');
    if (!ok) throw new ConfirmCancelledError();
  }

  // 6. Update package.json (atomic write)
  applyPrismaUpgrade(projectRoot, versionInfo.latestVersion);

  // 7. Log mutation (with session existence check)
  const db = initializeDatabase();
  const sessionId = resolveOrCreateSession(db, {
    sessionId: options.session,
    command: 'upgrade prisma',
    projectRoot,
    provider: config.provider.default,
    model: config.provider.model,
  });
  logMutation(db, sessionId, {
    action: 'upgrade_prisma',
    affectedFiles,
    riskLevel: 'high',
    reversible: true,
    rollbackHints: ['git checkout -- package.json', `${pm} install`],
  });
  updateSessionStatus(db, sessionId, 'completed');

  // 8. Print next steps
  const prismaCmd = pm === 'npm' ? 'npx' : pm;
  const releaseUrl = `https://github.com/prisma/prisma/releases/tag/${versionInfo.latestVersion}`;

  info('');
  success('Updated Prisma versions in package.json:');
  if (versionInfo.currentPrisma) {
    info(`    prisma: ${versionInfo.currentPrisma} → ${versionInfo.latestVersion}`);
  }
  if (versionInfo.currentClient) {
    info(`    @prisma/client: ${versionInfo.currentClient} → ${versionInfo.latestVersion}`);
  }
  info('');
  info('Next steps (run in order):');
  info('');
  info('1. Install updated dependencies:');
  info(`     ${pm} install`);
  info('');
  info('2. Regenerate Prisma Client:');
  info(`     ${prismaCmd} prisma generate`);
  info('');
  info('3. Review breaking changes:');
  info(`     ${releaseUrl}`);
  info('');
  info('4. Run your test suite:');
  info(`     ${pm} test`);
  info('');
  info('Aria has updated package.json only.');
  info('Migration commands must be run manually.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Update prisma and @prisma/client versions in package.json (atomic write).
 */
function applyPrismaUpgrade(projectRoot: string, targetVersion: string): void {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = readJsonFile(pkgPath) as Record<string, any>;

  const updateSection = (section: Record<string, string> | undefined, name: string) => {
    if (!section || section[name] === undefined) return;
    const existing = section[name];
    const prefix = existing.match(/^[\^~>=<]+/)?.[0] ?? '^';
    section[name] = `${prefix}${targetVersion}`;
  };

  updateSection(pkg.dependencies, 'prisma');
  updateSection(pkg.dependencies, '@prisma/client');
  updateSection(pkg.devDependencies, 'prisma');
  updateSection(pkg.devDependencies, '@prisma/client');

  writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * Use LLM to generate Prisma-specific migration guidance for major upgrades.
 * Uses provider.chat directly — no tools needed for analysis.
 */
async function generateMigrationGuidance(
  currentVersion: string,
  targetVersion: string,
  projectRoot: string,
  config: Config,
): Promise<void> {
  const schemaInfo = parsePrismaSchema(projectRoot);
  const schemaSummary = schemaInfo
    ? `Models: ${schemaInfo.models.map((m) => m.name).join(', ')}\nProvider: ${schemaInfo.datasourceProvider ?? 'unknown'}`
    : 'No schema.prisma found';

  const template = loadPromptTemplate(
    'upgrade_prisma',
    'Analyze Prisma upgrade from {{ current_version }} to {{ target_version }}.\nSchema: {{ schema_summary }}',
  );

  const systemPrompt = template
    .replace(/\{\{ current_version \}\}/g, currentVersion)
    .replace(/\{\{ target_version \}\}/g, targetVersion)
    .replace(/\{\{ schema_summary \}\}/g, schemaSummary);

  info('');
  info(bold('Prisma upgrade analysis:'));

  try {
    const provider = createProvider(config.provider.default, config.provider);
    const db = initializeDatabase();
    const sessionId = resolveOrCreateSession(db, {
      command: 'upgrade prisma analysis',
      projectRoot,
      provider: config.provider.default,
      model: config.provider.model,
    });

    logMessage(db, sessionId, 'system', systemPrompt);

    // Use provider.chat directly instead of agentLoop with empty tools
    const response = await provider.chat(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Analyze the Prisma upgrade from ${currentVersion} to ${targetVersion} and provide migration guidance.`,
        },
      ],
      [],
      { model: config.provider.model, maxTokens: config.provider.maxTokens },
    );

    if (response.content) {
      info(response.content);
    }

    logMessage(db, sessionId, 'assistant', response.content);
    updateSessionStatus(db, sessionId, 'completed');
  } catch {
    warn('Could not generate AI analysis for Prisma upgrade. Proceeding without it.');
  }
}
