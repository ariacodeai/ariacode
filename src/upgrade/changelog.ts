/**
 * Fetch changelog/release notes for major upgrades from npm registry.
 * Uses the npm registry API (read-only, no auth required for public packages).
 */

export interface ChangelogInfo {
  name: string;
  from: string;
  to: string;
  repositoryUrl?: string;
  releaseNotesUrl?: string;
}

/**
 * Build changelog info for packages. Uses npm registry to find repo URLs.
 * Actual changelog summarization is done by the LLM via the prompt.
 * Fetches with bounded concurrency (max 6 parallel) to avoid hammering the registry.
 */
export async function fetchChangelogInfo(
  packages: { name: string; current: string; target: string }[],
): Promise<ChangelogInfo[]> {
  const CONCURRENCY = 6;
  const results: ChangelogInfo[] = [];

  for (let i = 0; i < packages.length; i += CONCURRENCY) {
    const batch = packages.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (pkg) => {
        const repoUrl = await getRepositoryUrl(pkg.name);
        return {
          name: pkg.name,
          from: pkg.current,
          to: pkg.target,
          repositoryUrl: repoUrl ?? undefined,
          releaseNotesUrl: repoUrl ? buildReleaseNotesUrl(repoUrl, pkg.target) : undefined,
        };
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

async function getRepositoryUrl(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      return null;
    }
    const data = (await res.json()) as any;
    const repo = data.repository;
    if (!repo) return null;
    const url = typeof repo === 'string' ? repo : repo.url;
    if (!url) return null;
    // Normalize git URLs to HTTPS
    return url
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '')
      .replace(/^ssh:\/\/git@github\.com/, 'https://github.com');
  } catch {
    return null;
  }
}

function buildReleaseNotesUrl(repoUrl: string, version: string): string | undefined {
  if (repoUrl.includes('github.com')) {
    return `${repoUrl}/releases/tag/v${version}`;
  }
  return undefined;
}
