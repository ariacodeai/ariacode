# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
