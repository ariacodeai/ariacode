# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-04-09

UX Polish — in-house syntax highlighter, enhanced diff renderer, history search/filter/export, and structured `--format json/ndjson/plain` output across all data-producing commands.

### Added

**Diff Renderer (`src/ui/diff-renderer.ts`)**
- `renderDiff(diffText, options: DiffRenderOptions): string` — enhanced diff renderer with syntax highlighting, line numbers, collapsible unchanged sections, and optional side-by-side layout
- `DiffRenderOptions` interface: `split`, `lineNumbers`, `collapseThreshold`, `language?`, `terminalWidth?`
- Unchanged context runs exceeding `collapseThreshold` are collapsed to `... N unchanged lines ...`
- File header line above each file's diff showing path and `+M -N lines` mutation summary
- Side-by-side rendering when `--split` is passed and terminal width > 120 columns; falls back to unified silently otherwise

**In-House Syntax Highlighter (`src/ui/highlight.ts`)**
- `highlight(code, options): string` — zero-dependency syntax highlighter using `picocolors` (already a project dependency)
- `inferLanguageFromPath(filePath): SupportedLanguage | null` — maps file extensions to language identifiers
- Supported languages: TypeScript/JavaScript (keywords, strings, comments, numbers, type annotations), Prisma (model/enum/directive keywords), JSON (keys, values, booleans, null), Markdown (headings, bold/italic, inline code, fenced blocks)
- Returns input unchanged for unsupported languages — never throws

**History Queries (`src/storage/queries.ts`)**
- `searchSessions(db, query, options?)` — case-insensitive full-text search across session `command`, `project_root`, and message `content`; results ordered by relevance (message matches ranked above metadata matches)
- `filterSessions(db, filters)` — filter sessions by `command`, `since`, `status`, and `limit` with AND logic
- `exportSessionMarkdown(db, sessionId, outputPath)` — write a markdown transcript with session metadata table, chronological message transcript, and tool execution table; creates parent directories automatically
- `parseSinceExpression(expr): Date` — parses `"N days/hours/minutes ago"` and ISO 8601 date strings; throws with descriptive message for unrecognized formats

**History Command Enhancements**
- `aria history search "<query>"` — full-text search subcommand with relevance-ranked results
- `aria history --command <cmd>` — filter by command name
- `aria history --since "<expr>"` — filter by date (natural language or ISO 8601)
- `aria history --status <status>` — filter by session status (`running`, `completed`, `failed`, `cancelled`)
- `aria history --session <id> --export <path>` — export session as markdown file
- `--tree` now shows tool-type icons: `[R]` read, `[S]` search, `[W]` mutation, `[.]` other; `✓` green for success, `✗` red for error

**Structured Output (`src/output/schemas.ts`)**
- `OutputVersion = '1'` — versioned output type for downstream stability
- Zod schemas for all 11 commands: `AskOutputSchema`, `PlanOutputSchema`, `PatchOutputSchema`, `ReviewOutputSchema`, `ExploreOutputSchema`, `DbSchemaOutputSchema`, `DbAskOutputSchema`, `DbExplainOutputSchema`, `HistoryOutputSchema`, `DoctorOutputSchema`, `UpgradeDepsOutputSchema`
- `formatOutput<T>(data, format, schema): string` — validates data against schema before serializing; throws `OutputValidationError` on validation failure
- `OutputValidationError` class with `issues: ZodIssue[]` field

**`--format` Flag Expansion**
- All data-producing commands now accept `--format json`, `--format ndjson`, and `--format plain`
- `json` — single validated JSON object to stdout, all spinner/info output suppressed
- `ndjson` — one JSON object per line; final `{"version":"1","event":"done"}` line on success; `{"version":"1","event":"error","error":"..."}` to stderr on failure
- `plain` — tab-separated output with no ANSI codes and no `cli-table3` box-drawing characters
- Structured error output: `--format json` failures write `{"version":"1","error":"...","exitCode":N}` to stderr; stdout remains empty

**`aria patch` Enhancements**
- `--split` flag — enable side-by-side diff rendering (requires terminal width > 120)
- `--format plain` — disables line numbers and ANSI codes in diff output; requires `--yes` (exits with code 2 otherwise)
- Default diff rendering now uses `renderDiff` from `src/ui/diff-renderer.ts` with `lineNumbers: true` and `collapseThreshold: 5`

### Changed

- Bumped version to `0.2.3`
- `--format` type widened from `'text' | 'json'` to `'text' | 'json' | 'ndjson' | 'plain'`
- `validateArgs` rejects any `--format` value not in `['text', 'json', 'ndjson', 'plain']` with exit code 2
- `validateArgs` rejects any `--status` value not in `['running', 'completed', 'failed', 'cancelled']` with exit code 2
- `aria patch` diff preview uses the new enhanced renderer by default (line numbers on, collapse threshold 5)

## [0.2.2] - 2026-04-07

Provider Expansion — global `--provider` and `--model` flags, per-provider config overrides, and full provider support across all commands including `db` and `upgrade`.

### Added

**Global CLI Flags**
- `--provider <name>` — override the default provider for a single command (`anthropic`, `openai`, `ollama`, `openrouter`)
- `--model <name>` — override the LLM model for a single command (e.g. `deepseek/deepseek-chat`, `gpt-4o`)
- `--prisma-model <name>` — filter to a specific Prisma model in `db` commands (replaces the previous `--model` flag in `db` context)

**Per-Provider Configuration**
- `[provider.anthropic]` section in TOML config with optional `model` override
- `[provider.openrouter]` section in TOML config with optional `model` and `baseUrl` overrides
- `OPENROUTER_BASE_URL` environment variable for custom OpenRouter-compatible endpoints

**Provider Support in All Commands**
- `aria db ask`, `aria db explain`, `aria db migrate` now accept `--provider` and `--model`
- `aria upgrade deps`, `aria upgrade prisma` now accept `--provider` and `--model`

**Doctor Improvements**
- Provider check now shows the active model name
- Secondary providers with configured API keys are reported as available

**Tests**
- CLI parser tests for `--provider`, `--model`, `--prisma-model` flags and their `=` syntax variants
- Config tests for per-provider overrides, `--provider` flag validation, and `baseUrl` from TOML

### Changed

- `--model` is now a global flag for LLM model selection; use `--prisma-model` for Prisma model filtering in `db` commands
- Invalid `--provider` value now throws `ConfigError` with a clear message listing valid providers (was silently ignored)
- CLI `--model` flag takes precedence over per-provider model overrides from config files
- `OPENROUTER_BASE_URL` is validated as a URL before being passed to config (invalid URL throws `ConfigError`)
- Doctor no longer warns about unconfigured secondary providers — only reports providers with keys present
- `OpenRouterProvider` accepts a configurable `baseUrl` via constructor, config, or environment variable
- Default OpenRouter model aligned to `anthropic/claude-sonnet-4-6` (was `anthropic/claude-sonnet-4`)
- Help text for `--provider` now lists all four valid providers

### Fixed

- `aria db ask --provider openrouter` was silently ignored — provider/model flags now forwarded to all `db` and `upgrade` sub-actions
- `--model` in `db` commands no longer collides with the global LLM model flag — Prisma model filtering moved to `--prisma-model`
- `prisma-upgrade.ts` `fetchLatestVersion` — removed `as any` cast, narrowed npm registry response to proper type guard
- `resolveModel()` precedence: CLI `--model` now correctly overrides per-provider model from config files

## [0.2.1] - 2026-04-07

Upgrade Automation — AI-assisted dependency and framework upgrades with preview and safety gates.

### Added

**Commands**
- `aria upgrade deps` — analyze outdated dependencies, classify by semver risk (patch/minor/major), propose grouped upgrades to `package.json` with preview and confirmation
- `aria upgrade prisma` — Prisma-specific upgrade with version detection, migration guidance for major upgrades, and step-by-step next actions

**Modules**
- `src/upgrade/outdated.ts` — wraps `npm/pnpm/yarn/bun outdated --json` via subprocess, normalizes output across all package managers
- `src/upgrade/classifier.ts` — semver-based risk classification (patch/minor/major/prerelease) using `semver.diff()`
- `src/upgrade/changelog.ts` — fetches repository URLs from npm registry for release notes links; parallel HTTP requests
- `src/upgrade/prisma-upgrade.ts` — detects current Prisma version from `package.json`, fetches latest from npm registry with subprocess fallback

**Flags**
- `--risk <patch|minor|major|all>` — filter upgrades by risk level (default: `minor` includes patch + minor)
- `--dev` — include devDependencies in upgrade scope

**Prompts**
- `src/prompts/upgrade_deps.md` — system prompt for LLM-assisted major upgrade analysis
- `src/prompts/upgrade_prisma.md` — system prompt for Prisma-specific migration guidance

**Safety**
- Aria never runs `npm install`, `pnpm install`, `yarn install`, or `bun install` — only modifies `package.json` and prints the install command for the user
- Aria never runs `prisma migrate` — prints manual migration steps
- Property tests 21 (no install commands) and 22 (no prisma migrate) enforce this statically

**Tests**
- `tests/unit/classifier.test.ts` — semver classification edge cases + Property 20 (classification correctness via fast-check)
- `tests/unit/outdated.test.ts` — npm/pnpm/yarn output parsing with mocked subprocess
- `tests/unit/upgrade-safety.test.ts` — Properties 21 and 22 (static source scan for forbidden subprocess calls)
- CLI parser tests for `upgrade` subcommand, `--risk`, and `--dev` flags

### Changed

- Bumped version to `0.2.1`
- Added `semver` (^7.6.0) to dependencies, `@types/semver` (^7.5.0) to devDependencies

### Fixed

- Removed duplicate `OllamaProvider.prototype.chat` override in `provider.ts` (dead code — identical to class method)
- Added message array trimming in `agent.ts` to prevent unbounded memory growth during long sessions
- Parallelized HTTP requests in `changelog.ts` (was sequential, now `Promise.all`)
- Added response body drain on HTTP errors in `prisma-upgrade.ts` and `changelog.ts` to free TCP connections
- Removed unused function parameters in `upgrade-deps.ts` and `upgrade-prisma.ts`
- Fixed double session initialization in upgrade actions (was silently swallowing SQLite duplicate key errors)
- Optimized `classifyUpgrade` in `classifier.ts` — reduced from 5 semver calls to 2

## [0.2.0] - 2026-04-06

Prisma DB Assistant — schema-aware database tooling for Prisma projects. No database connections, no query execution — all value comes from deep understanding of `schema.prisma` and static analysis of Prisma Client usage in code.

### Added

**Commands**
- `aria db schema` — parse and render `schema.prisma` content (models, fields, relations, enums, indexes); supports `--json` and `--model <name>` filtering; no LLM call — instant and free
- `aria db ask <question>` — Q&A over Prisma schema with Prisma Client code generation; warns on sensitive field access (password, token, secret, apiKey)
- `aria db explain <description>` — analyze Prisma Client usage in code, identify N+1 queries, missing indexes, over-fetching; suggests `@@index` additions and query improvements
- `aria db migrate <description>` — propose changes to `schema.prisma` with diff preview and confirmation; prints manual `prisma migrate` commands for user to run; never executes migrations

**Modules**
- `src/db/schema.ts` — Prisma schema parser wrapping `@mrleebo/prisma-ast`; extracts models, fields, relations, enums, indexes, generators, datasource provider
- `src/db/summary.ts` — human-readable terminal rendering of parsed schema with color-coded tables
- `src/db/client-usage.ts` — ripgrep-based Prisma Client usage finder (`prisma.model.operation` patterns)
- `src/db/migrate.ts` — schema change proposal helpers, manual migration instruction generator

**Tools**
- `read_prisma_schema_parsed` — returns structured `PrismaSchemaInfo` for the project's schema
- `find_prisma_usage` — searches for Prisma Client calls in TS/JS files with model/operation filtering
- `find_model_references` — finds all references to a Prisma model name across the codebase
- `propose_schema_change` — validates new schema content, generates diff, stores for confirmation
- `apply_schema_change` — applies a previously proposed schema change atomically

**Prompts**
- `src/prompts/db_ask.md` — system prompt for schema Q&A and Prisma Client code generation
- `src/prompts/db_explain.md` — system prompt for query analysis and performance optimization
- `src/prompts/db_migrate.md` — system prompt for schema migration proposals

**Doctor**
- `aria doctor` now reports Prisma schema presence, provider, and model count

**Tests**
- Fixture projects: `prisma-simple`, `prisma-ecommerce`, `prisma-auth`, `prisma-relations`
- `tests/db/schema.test.ts` — parser tests across all fixtures
- `tests/db/summary.test.ts` — rendering tests
- `tests/db/client-usage.test.ts` — Prisma Client usage finder tests

### Changed

- Bumped version to `0.2.0`
- Added `@mrleebo/prisma-ast` (^0.15.0) to dependencies
- Updated CLI parser to support `db` subcommand group with `schema`, `ask`, `explain`, `migrate` subcommands
- Updated `aria --help` to list `db` command

## [0.1.0] - 2026-04-06

Initial release of Aria Code CLI.

### Added

**Commands**
- `aria ask` — read-only Q&A over the repository using read-only tools
- `aria plan` — generate structured implementation plans without making changes; supports `--output` to save as markdown
- `aria patch` — propose and apply unified diffs atomically with preview, confirmation, and rollback hints; supports `--dry-run` and `--yes`
- `aria review` — AI-assisted review of staged git changes; supports `--unstaged`, `--branch`, and `--format json`
- `aria explore` — scan repository structure, detect frameworks and entry points, summarize architectural patterns; supports `--save`
- `aria history` — inspect past sessions from the local SQLite database; supports `--session`, `--limit`, and `--tree`
- `aria config` — view and manage configuration with `get`, `set`, `path`, and `init` subcommands
- `aria doctor` — run environment diagnostics covering Node.js version, git, ripgrep, config validity, history DB, and provider readiness

**Provider Support**
- Anthropic (`claude-sonnet-4-6` default)
- OpenAI
- Ollama (local models)
- OpenRouter
- Exponential backoff retry logic for all provider API calls
- Configurable request timeout

**Configuration**
- TOML configuration files at `~/.aria/config.toml` (user) and `./.aria.toml` (project)
- Configuration precedence: CLI flags > environment variables > project config > user config > defaults
- Full schema validation with descriptive error messages
- Environment variable overrides for all major settings

**Safety**
- Project root boundary enforcement — all file operations validated against project root
- Path traversal and symlink escape prevention
- Shell command allowlist enforcement
- `.env` and `node_modules` excluded from directory listings by default
- API keys never logged to history or terminal output
- History database stored with `600` permissions (user-only)

**Session History**
- SQLite database at `~/.aria/history.db` with versioned schema migrations
- Sessions, messages, tool executions, and mutations all persisted
- Session lifecycle tracking: `running` → `completed` / `failed` / `cancelled`
- Configurable retention policy (default: 90 days)
- Session resumption via `--session` flag for `ask` and `plan`

**Terminal UI**
- Color output via `picocolors` with auto-detection of TTY support
- Diff rendering with syntax highlighting
- Tabular output via `cli-table3` for history and config commands
- Interactive confirmation prompts via `prompts`
- Progress indicators for long-running operations
- `--quiet` flag to suppress non-essential output

**Project Detection**
- Automatic detection of Next.js (app router and pages router), Nest.js, and Node.js projects
- Prisma detection from dependencies and schema file
- Package manager detection from lockfile presence (npm, pnpm, yarn, bun)

**Error Handling**
- Consistent exit codes: 0 success, 1 generic, 2 invalid args, 3 config, 4 provider, 5 project detection, 130 cancelled
- Stack traces shown only when `DEBUG=1` is set
- All error messages written to stderr
