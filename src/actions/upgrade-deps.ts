/**
 * aria upgrade deps — analyze outdated dependencies, propose upgrades grouped by risk.
 * Modifies package.json only. Never runs install commands.
 */

import * as path from 'node:path';

import { getConfig, type Config } from '../config.js';
import { detectProjectType } from '../repo.js';
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
  green,
  yellow,
  red,
  cyan,
  printTable,
  confirm,
  ConfirmCancelledError,
  createSpinner,
} from '../ui.js';
import type { MutationSummary, RiskLevel } from '../context.js';
import { getOutdatedPackages } from '../upgrade/outdated.js';
import {
  classifyAll,
  type ClassifiedUpgrade,
  type UpgradeRisk,
} from '../upgrade/classifier.js';
import { fetchChangelogInfo } from '../upgrade/changelog.js';
import { readJsonFile, writeFileAtomic } from '../fs-helpers.js';
import { loadPromptTemplate } from '../prompt-loader.js';

export interface UpgradeDepsOptions {
  dryRun?: boolean;
  yes?: boolean;
  risk?: 'patch' | 'minor' | 'major' | 'all';
  dev?: boolean;
  session?: string;
  quiet?: boolean;
  projectRoot?: string;
  /** Override provider (v0.2.2) */
  provider?: string;
  /** Override LLM model (v0.2.2) */
  model?: string;
}

export async function runUpgradeDeps(options: UpgradeDepsOptions): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const config = getConfig(projectRoot, { quiet: options.quiet, provider: options.provider, model: options.model });
  initUI(config.ui.color, config.ui.quiet || Boolean(options.quiet));

  const project = detectProjectType(projectRoot);
  const pm = project.packageManager ?? 'npm';

  // 1. Fetch outdated packages
  const spinner = createSpinner('Checking for outdated packages...');
  spinner.start();

  let outdated;
  try {
    outdated = await getOutdatedPackages(projectRoot, pm);
  } catch (err) {
    spinner.fail('Failed to check outdated packages');
    uiError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (outdated.length === 0) {
    spinner.succeed('All dependencies up to date');
    return;
  }
  spinner.succeed(`Found ${outdated.length} outdated package(s)`);

  // 2. Classify by risk
  const classified = classifyAll(outdated);

  // 3. Filter by --risk flag (default: patch + minor)
  const riskFilter = options.risk ?? 'minor';
  const filtered = filterByRisk(classified, riskFilter);

  if (filtered.length === 0) {
    info(`No upgrades matching risk level "${riskFilter}". Use --risk all to see everything.`);
    return;
  }

  // 4. Render upgrade preview table
  renderUpgradeTable(filtered);

  // 5. For major upgrades, use LLM to summarize breaking changes
  const majors = filtered.filter((u) => u.risk === 'major');
  if (majors.length > 0) {
    await summarizeMajorUpgrades(majors, project.type, projectRoot, config);
  }

  // 6. Build MutationSummary
  const highestRisk = getHighestRisk(filtered);
  const summary: MutationSummary = {
    action: 'upgrade_deps',
    affectedFiles: ['package.json'],
    commandsToRun: [`${pm} install`],
    migrations: [],
    riskLevel: riskToLevel(highestRisk),
    reversible: true,
    rollbackHints: ['git checkout -- package.json', `${pm} install`],
  };

  info('');
  info(dim(`Risk: ${summary.riskLevel} | Files: package.json | Reversible: yes`));

  // 7. Handle dry-run / confirmation
  if (options.dryRun) {
    warn('Dry-run mode — package.json will not be modified.');
    return;
  }

  if (!options.yes) {
    const ok = await confirm(`Apply ${filtered.length} upgrade(s) to package.json?`);
    if (!ok) throw new ConfirmCancelledError();
  }

  // 8. Apply changes to package.json (atomic write)
  applyUpgrades(projectRoot, filtered);

  // 9. Log mutation (with session existence check)
  const db = initializeDatabase();
  const sessionId = resolveOrCreateSession(db, {
    sessionId: options.session,
    command: 'upgrade deps',
    projectRoot,
    provider: config.provider.default,
    model: config.provider.model,
  });
  logMutation(db, sessionId, {
    action: 'upgrade_deps',
    affectedFiles: ['package.json'],
    riskLevel: riskToLevel(highestRisk),
    reversible: true,
    rollbackHints: ['git checkout -- package.json', `${pm} install`],
  });
  updateSessionStatus(db, sessionId, 'completed');

  // 10. Print next steps
  info('');
  success(`Updated package.json with ${filtered.length} dependency upgrade(s)`);
  info('');
  info('To install the new versions, run:');
  info(`  ${pm} install`);
  info('');
  info('Then verify:');
  info(`  ${pm} test`);
  info(`  ${pm} run build`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterByRisk(upgrades: ClassifiedUpgrade[], risk: string): ClassifiedUpgrade[] {
  switch (risk) {
    case 'patch':
      return upgrades.filter((u) => u.risk === 'patch');
    case 'minor':
      return upgrades.filter((u) => u.risk === 'patch' || u.risk === 'minor');
    case 'major':
    case 'all':
      return upgrades;
    default:
      return upgrades.filter((u) => u.risk === 'patch' || u.risk === 'minor');
  }
}

function renderUpgradeTable(upgrades: ClassifiedUpgrade[]): void {
  const riskColor = (risk: UpgradeRisk): string => {
    switch (risk) {
      case 'patch':
        return green(risk);
      case 'minor':
        return yellow(risk);
      case 'major':
        return red(risk);
      case 'prerelease':
        return cyan(risk);
    }
  };

  info('');
  info(bold('Dependency Upgrades:'));
  printTable(
    {
      head: ['Package', 'Current', 'Target', 'Risk', 'Type'],
      colWidths: [30, 12, 12, 14, 18],
    },
    upgrades.map((u) => [u.name, u.current, u.target, riskColor(u.risk), u.type]),
  );
}

function getHighestRisk(upgrades: ClassifiedUpgrade[]): UpgradeRisk {
  if (upgrades.some((u) => u.risk === 'major')) return 'major';
  if (upgrades.some((u) => u.risk === 'minor')) return 'minor';
  if (upgrades.some((u) => u.risk === 'prerelease')) return 'prerelease';
  return 'patch';
}

function riskToLevel(risk: UpgradeRisk): RiskLevel {
  switch (risk) {
    case 'major':
      return 'high';
    case 'minor':
    case 'prerelease':
      return 'medium';
    case 'patch':
      return 'low';
  }
}

/**
 * Modify package.json in-place (atomic write), updating version ranges for each upgrade.
 */
function applyUpgrades(projectRoot: string, upgrades: ClassifiedUpgrade[]): void {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = readJsonFile(pkgPath) as Record<string, any>;

  for (const u of upgrades) {
    const section = pkg[u.type];
    if (section && section[u.name] !== undefined) {
      const existing: string = section[u.name];
      const prefix = existing.match(/^[\^~>=<]+/)?.[0] ?? '^';
      section[u.name] = `${prefix}${u.target}`;
    }
  }

  writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/**
 * Use LLM to summarize breaking changes for major upgrades.
 */
async function summarizeMajorUpgrades(
  majors: ClassifiedUpgrade[],
  projectType: string,
  projectRoot: string,
  config: Config,
): Promise<void> {
  const changelogInfos = await fetchChangelogInfo(
    majors.map((m) => ({ name: m.name, current: m.current, target: m.target })),
  );

  const majorSummary = majors
    .map((m) => {
      const cl = changelogInfos.find((c) => c.name === m.name);
      const repoLine = cl?.releaseNotesUrl ? `  Release notes: ${cl.releaseNotesUrl}` : '';
      return `- ${m.name}: ${m.current} → ${m.target}${repoLine}`;
    })
    .join('\n');

  const template = loadPromptTemplate(
    'upgrade_deps',
    'Summarize breaking changes for:\n{{ major_upgrades }}',
  );

  const systemPrompt = template
    .replace(/\{\{ major_upgrades \}\}/g, majorSummary)
    .replace(/\{\{ project_type \}\}/g, projectType);

  info('');
  info(bold('Major upgrade analysis:'));

  try {
    const provider = createProvider(config.provider.default, config.provider);
    const db = initializeDatabase();
    const sessionId = resolveOrCreateSession(db, {
      command: 'upgrade deps analysis',
      projectRoot,
      provider: config.provider.default,
      model: config.provider.model,
    });

    logMessage(db, sessionId, 'system', systemPrompt);

    // Use provider.chat directly instead of agentLoop with empty tools —
    // no tools needed for changelog summarization, avoids wasted tokens.
    const response = await provider.chat(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Analyze these major dependency upgrades and summarize breaking changes:\n${majorSummary}`,
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
    warn('Could not generate AI analysis for major upgrades. Proceeding without it.');
  }
}
