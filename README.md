# @ariacode/cli

<p align="center">
  <img src="./media/aria.jpg" alt="Aria Code" />
</p>

[![Node.js >=20](https://img.shields.io/node/v/@ariacode/cli.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@ariacode/cli)](https://www.npmjs.com/package/@ariacode/cli)

A predictable, terminal-native coding agent for Next.js, Nest.js, Prisma and Node.js projects.

Aria reads your repository, generates safe diffs with preview, understands your Prisma schema, upgrades dependencies with risk analysis, and tracks every mutation in a local SQLite history — no surprises.

## Requirements

- Node.js 20+
- `git` (for `review` command)
- `ripgrep` (for `search_code` tool — fast code search)

## Installation

```bash
npm install -g @ariacode/cli
```

After installation the `aria` binary is available globally.

## Quick Start

```bash
# Ask a question about your codebase
aria ask "How is authentication handled in this project?"

# Use a different provider for a single command
aria ask "Explain the data model" --provider openrouter --model deepseek/deepseek-chat

# Generate an implementation plan (read-only, no changes)
aria plan "Add rate limiting to the API routes"

# Preview a patch before applying
aria patch "Rename GeoPage to LandingPage" --dry-run

# Apply a patch with confirmation prompt
aria patch "Add error boundary to the root layout"

# Review staged git changes
aria review

# Explore an unfamiliar codebase
aria explore

# Prisma schema inspection (instant, no LLM)
aria db schema

# Ask about your database schema
aria db ask "users with more than 5 orders in the last 30 days"

# Upgrade outdated dependencies
aria upgrade deps

# Upgrade Prisma with migration guidance
aria upgrade prisma

# Check your environment
aria doctor
```

## Commands

### `aria ask <question>`

Ask a read-only question about the repository. The agent uses `read_file`, `list_directory`, and `search_code` to explore the codebase and answer your question.

```
aria ask "<question>" [--session <id>] [--max-tokens <n>] [--quiet] [--provider <name>] [--model <name>]
```

| Flag | Description |
|------|-------------|
| `--session <id>` | Resume an existing session |
| `--max-tokens <n>` | Override max tokens for this response |
| `--quiet` | Suppress non-essential output |
| `--provider <name>` | Override provider for this command |
| `--model <name>` | Override LLM model for this command |

### `aria plan <goal>`

Generate a structured implementation plan without making any changes. Returns steps, affected files, risks, and implementation notes.

```
aria plan "<goal>" [--session <id>] [--output <path>]
```

| Flag | Description |
|------|-------------|
| `--session <id>` | Resume an existing session |
| `--output <path>` | Save the plan as a markdown file |

### `aria patch <description>`

Analyze the repository, propose a unified diff, show a preview, and apply changes atomically after confirmation.

```
aria patch "<description>" [--dry-run] [--yes] [--split] [--format text|json|ndjson|plain] [--session <id>]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview the diff without applying changes |
| `--yes` | Skip the confirmation prompt |
| `--split` | Render diff side-by-side (requires terminal width > 120 columns) |
| `--format plain` | Plain-text diff output with no ANSI codes; requires `--yes` |
| `--session <id>` | Resume an existing session |

### `aria review`

Review git changes with AI assistance. Reads staged changes by default and returns a structured review with summary, issues, and suggestions.

```
aria review [--unstaged] [--branch <base>] [--format text|json|ndjson|plain]
```

| Flag | Description |
|------|-------------|
| `--unstaged` | Review unstaged changes instead of staged |
| `--branch <base>` | Compare current branch to a base branch |
| `--format <fmt>` | Output format: `text` (default), `json`, `ndjson`, `plain` |

### `aria explore`

Scan the repository structure, detect frameworks and entry points, and summarize architectural patterns.

```
aria explore [--depth <n>] [--save]
```

| Flag | Description |
|------|-------------|
| `--depth <n>` | Limit directory traversal depth |
| `--save` | Save the summary to `./.aria/explore.md` |

### `aria history`

Inspect past sessions stored in the local SQLite database.

```
aria history [--limit <n>] [--session <id>] [--tree] [--format text|json|ndjson|plain]
aria history search "<query>"
aria history [--command <cmd>] [--since "<expr>"] [--status <status>]
aria history --session <id> --export <path>
```

| Flag | Description |
|------|-------------|
| `--limit <n>` | Limit the number of sessions shown (default: 20) |
| `--session <id>` | Show the full log for a specific session |
| `--tree` | Render the tool execution tree with type icons (`[R]` read, `[S]` search, `[W]` mutation, `[.]` other) |
| `--command <cmd>` | Filter sessions by command name |
| `--since "<expr>"` | Filter by date — supports `"N days ago"`, `"N hours ago"`, `"N minutes ago"`, or ISO 8601 |
| `--status <status>` | Filter by status: `running`, `completed`, `failed`, `cancelled` |
| `--export <path>` | Export session transcript as a markdown file (requires `--session`) |
| `--format <fmt>` | Output format: `text` (default), `json`, `ndjson`, `plain` |

**Search example:**

```bash
aria history search "rate limiting"
aria history --command patch --status completed --since "7 days ago"
aria history --session abc123 --export ./session-transcript.md
```

### `aria config`

View and manage configuration.

```
aria config                        # Show effective config with sources
aria config get <key>              # Display a specific value
aria config set <key> <value>      # Write to ~/.aria/config.toml
aria config path                   # Show config file resolution paths
aria config init                   # Create ./.aria.toml with defaults
```

`config set` and `config init` support `--dry-run` and `--yes`.

### `aria doctor`

Run environment diagnostics: Node.js version, git, ripgrep, config validity, history DB, provider API keys, project detection, and Prisma schema presence.

```
aria doctor [--format text|json|ndjson|plain]
```

### `aria db schema`

Parse and render `schema.prisma` content — models, fields, relations, enums, indexes. No LLM call, instant and free.

```
aria db schema [--json] [--prisma-model <name>]
```

| Flag | Description |
|------|-------------|
| `--json` | Output raw `PrismaSchemaInfo` as JSON |
| `--prisma-model <name>` | Filter to a single Prisma model |

Example output:

```
Prisma Schema: prisma/schema.prisma
Provider: postgresql

Models (3)

  User
  ┌──────────────┬──────────┬──────────────────┐
  │ Field        │ Type     │ Modifiers        │
  ├──────────────┼──────────┼──────────────────┤
  │ id           │ String   │ @id @default     │
  │ email        │ String   │ @unique          │
  │ createdAt    │ DateTime │ @default(now())  │
  │ orders       │ Order[]  │ relation         │
  └──────────────┴──────────┴──────────────────┘

Enums (1)
  Role: ADMIN, USER, GUEST
```

### `aria db ask <question>`

Q&A over your Prisma schema. Generates runnable Prisma Client code. Warns when queries touch sensitive fields (password, token, secret, apiKey).

```
aria db ask "<question>" [--session <id>] [--prisma-model <name>] [--provider <name>] [--model <name>]
```

### `aria db explain <description>`

Analyze Prisma Client usage in your code. Identifies N+1 queries, missing indexes, over-fetching, and cartesian products. Suggests `@@index` additions and query improvements.

```
aria db explain "<description>" [--file <path>] [--session <id>]
```

### `aria db migrate <description>`

Propose changes to `schema.prisma` with diff preview and confirmation. Prints manual `prisma migrate` commands — Aria never runs migrations.

```
aria db migrate "<description>" [--dry-run] [--yes] [--session <id>]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview schema diff without writing |
| `--yes` | Skip confirmation prompt |

After a successful write:

```
✓ Schema updated: prisma/schema.prisma

To apply this migration, run:

  Development:
    pnpm prisma migrate dev --name <migration_name>

  Production:
    pnpm prisma migrate deploy

Aria does not run migrations automatically.
Review the generated SQL before applying to production.
```

### `aria upgrade deps`

Analyze outdated dependencies, classify by semver risk, and propose upgrades to `package.json`. Supports npm, pnpm, yarn, and bun.

```
aria upgrade deps [--dry-run] [--yes] [--risk patch|minor|major|all] [--dev]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview upgrades without modifying `package.json` |
| `--yes` | Skip confirmation prompt |
| `--risk <level>` | Filter by risk: `patch`, `minor` (default — includes patch), `major`, `all` |
| `--dev` | Include devDependencies |

Behavior:
1. Detects your package manager from lockfile
2. Runs `{pm} outdated --json` (read-only)
3. Classifies each upgrade as patch / minor / major / prerelease
4. For major upgrades, uses LLM to summarize breaking changes
5. Shows a grouped table preview
6. On confirmation, updates `package.json` and prints install command

Aria never runs `npm install` / `pnpm install` / `yarn install` / `bun install`. You run it.

```
✓ Updated package.json with 12 dependency upgrades

To install the new versions, run:
  pnpm install

Then verify:
  pnpm test
  pnpm run build
```

### `aria upgrade prisma`

Prisma-specific upgrade with version detection and migration guidance for major upgrades.

```
aria upgrade prisma [--dry-run] [--yes]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview without modifying `package.json` |
| `--yes` | Skip confirmation prompt |

For major Prisma upgrades, the LLM analyzes your `schema.prisma` for patterns affected by breaking changes and provides project-specific migration steps.

After a successful upgrade:

```
✓ Updated Prisma versions in package.json:
    prisma: 5.22.0 → 6.1.0
    @prisma/client: 5.22.0 → 6.1.0

Next steps (run in order):

1. Install updated dependencies:
     pnpm install

2. Regenerate Prisma Client:
     pnpm prisma generate

3. Review breaking changes:
     https://github.com/prisma/prisma/releases/tag/6.1.0

4. Run your test suite:
     pnpm test

Aria has updated package.json only.
Migration commands must be run manually.
```

## Configuration

Aria loads configuration from multiple sources in this precedence order (highest wins):

1. CLI flags
2. Environment variables
3. `./.aria.toml` (project-level)
4. `~/.aria/config.toml` (user-level)
5. Built-in defaults

### Configuration File Format

```toml
[provider]
default = "anthropic"       # anthropic | openai | ollama | openrouter
model = "claude-sonnet-4-6"
max_tokens = 4096

# Per-provider overrides (optional)
[provider.anthropic]
model = "claude-sonnet-4-6"       # override model when using Anthropic

[provider.openrouter]
model = "deepseek/deepseek-chat"  # override model when using OpenRouter
base_url = "https://openrouter.ai/api/v1"  # custom endpoint (optional)

[agent]
max_iterations = 25
mode = "build"              # build | plan
timeout_seconds = 120

[safety]
require_confirm_for_shell = true
allowed_shell_commands = ["npm", "pnpm", "yarn", "npx", "git", "prisma", "tsc", "node"]
max_file_size_kb = 1024
max_files_per_patch = 50

[ui]
color = "auto"              # auto | always | never
quiet = false

[history]
retain_days = 90
```

Run `aria config init` to generate a `.aria.toml` in the current directory.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Anthropic provider |
| `OPENAI_API_KEY` | API key for OpenAI provider |
| `OPENROUTER_API_KEY` | API key for OpenRouter provider |
| `OPENROUTER_BASE_URL` | Custom base URL for OpenRouter-compatible endpoints |
| `ARIA_PROVIDER` | Override default provider |
| `ARIA_MODEL` | Override model name |
| `ARIA_MAX_TOKENS` | Override max tokens |
| `ARIA_MAX_ITERATIONS` | Override max agent iterations |
| `ARIA_TIMEOUT_SECONDS` | Override request timeout |
| `ARIA_COLOR` | Override color mode (`auto`/`always`/`never`) |
| `ARIA_QUIET` | Set to `true` to suppress non-essential output |
| `ARIA_RETAIN_DAYS` | Override session retention period |
| `DEBUG` | Set to `1` to show stack traces on errors |

## Providers

Aria supports four provider backends. Anthropic is the default. OpenRouter gives you access to virtually every hosted model from a single API key.

### Anthropic (default)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
aria ask "What does this project do?"
```

| Model | ID |
|-------|----|
| Claude Opus 4.6 | `claude-opus-4-6` |
| Claude Sonnet 4.6 *(default)* | `claude-sonnet-4-6` |
| Claude Haiku 3.5 | `claude-haiku-3-5` |

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
aria config set provider.default openai
aria config set provider.model gpt-4o
```

| Model | ID |
|-------|----|
| GPT-5 | `gpt-5` |
| GPT-5.1 | `gpt-5.1` |
| GPT-4o | `gpt-4o` |
| GPT-4o mini | `gpt-4o-mini` |
| o3 | `o3` |
| o4-mini | `o4-mini` |

### Ollama (local, no API key required)

Run any model locally — no API key needed.

```bash
# Pull a model first, then point Aria at it
ollama pull llama4
aria config set provider.default ollama
aria config set provider.model llama4
```

Popular models available via `ollama pull`:

| Model | ID |
|-------|----|
| Llama 4 | `llama4` |
| Llama 3.3 | `llama3.3` |
| Mistral | `mistral` |
| Qwen 2.5 Coder | `qwen2.5-coder` |
| DeepSeek Coder V2 | `deepseek-coder-v2` |
| Phi-4 | `phi4` |
| Gemma 3 | `gemma3` |

See the full list at [ollama.com/library](https://ollama.com/library).

### OpenRouter

Access hundreds of hosted models from a single API key — including Claude, GPT, Gemini, Mistral, DeepSeek, Qwen, MiniMax, and more.

```bash
export OPENROUTER_API_KEY=sk-or-...
aria config set provider.default openrouter
aria config set provider.model deepseek/deepseek-r1
```

**Anthropic via OpenRouter**

| Model | ID |
|-------|----|
| Claude Sonnet 4.5 | `anthropic/claude-sonnet-4-5` |
| Claude Opus 4 | `anthropic/claude-opus-4` |
| Claude Haiku 3.5 | `anthropic/claude-haiku-3-5` |

**OpenAI via OpenRouter**

| Model | ID |
|-------|----|
| GPT-5 | `openai/gpt-5` |
| GPT-5.1 | `openai/gpt-5.1` |
| GPT-4o | `openai/gpt-4o` |
| o3 | `openai/o3` |
| o4-mini | `openai/o4-mini` |

**Google via OpenRouter**

| Model | ID |
|-------|----|
| Gemini 3.1 Pro | `google/gemini-3.1-pro-preview` |
| Gemini 3.1 Flash | `google/gemini-3.1-flash-preview` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro-preview` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash-preview` |

**DeepSeek via OpenRouter**

| Model | ID |
|-------|----|
| DeepSeek R1 | `deepseek/deepseek-r1` |
| DeepSeek V3 | `deepseek/deepseek-chat` |
| DeepSeek Coder V2 | `deepseek/deepseek-coder` |

**Mistral via OpenRouter**

| Model | ID |
|-------|----|
| Mistral Large | `mistralai/mistral-large` |
| Mistral Small | `mistralai/mistral-small` |
| Codestral | `mistralai/codestral-2501` |

**Qwen via OpenRouter**

| Model | ID |
|-------|----|
| Qwen3 235B | `qwen/qwen3-235b-a22b` |
| Qwen2.5 Coder 32B | `qwen/qwen-2.5-coder-32b-instruct` |
| QwQ 32B | `qwen/qwq-32b` |

**Xiaomi MiMo via OpenRouter**

| Model | ID |
|-------|----|
| MiMo V2 Pro *(1T params, 1M ctx)* | `xiaomi/mimo-v2-pro` |
| MiMo V2 Omni *(multimodal)* | `xiaomi/mimo-v2-omni` |
| MiMo V2 Flash *(open-source, fast)* | `xiaomi/mimo-v2-flash` |

**MiniMax via OpenRouter**

| Model | ID |
|-------|----|
| MiniMax M1 | `minimax/minimax-m1` |
| MiniMax Text 01 | `minimax/minimax-01` |

**Meta via OpenRouter**

| Model | ID |
|-------|----|
| Llama 4 Maverick | `meta-llama/llama-4-maverick` |
| Llama 4 Scout | `meta-llama/llama-4-scout` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |

See the full model catalogue at [openrouter.ai/models](https://openrouter.ai/models).

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Generic error |
| `2` | Invalid arguments |
| `3` | Configuration error |
| `4` | Provider error (e.g. missing API key) |
| `5` | Project detection error / Prisma not found |
| `130` | User cancelled (Ctrl+C or declined confirmation) |

## Structured Output

All data-producing commands support `--format json`, `--format ndjson`, and `--format plain` for scripting and pipeline integration.

| Format | Description |
|--------|-------------|
| `text` | Default — colored terminal output |
| `json` | Single validated JSON object to stdout; all spinner/info output suppressed |
| `ndjson` | One JSON object per line; final `{"version":"1","event":"done"}` on success |
| `plain` | Tab-separated output with no ANSI codes and no box-drawing characters |

All JSON output includes a top-level `"version": "1"` field for downstream stability.

On failure with `--format json`, a JSON error object is written to **stderr** and stdout remains empty:

```json
{"version":"1","error":"Provider API key not configured","exitCode":4}
```

On failure with `--format ndjson`, an error event is emitted to **stderr**:

```json
{"version":"1","event":"error","error":"Provider API key not configured"}
```

**Commands that support `--format`:** `ask`, `plan`, `patch`, `review`, `explore`, `db schema`, `db ask`, `db explain`, `history`, `doctor`, `upgrade deps`

## Session History

Every command execution is logged to `~/.aria/history.db` (SQLite). Sessions record messages, tool executions, and mutations. The database is created automatically on first run with permissions set to `600` (user-only).

View recent sessions:

```bash
aria history
aria history --limit 10
aria history --session <id>
aria history --session <id> --tree

# Search and filter
aria history search "authentication"
aria history --command patch --status completed
aria history --since "3 days ago"

# Export a session transcript
aria history --session <id> --export ./transcript.md
```

Sessions older than `retain_days` (default: 90) are cleaned up automatically.

## Safety

- All file operations are validated against the project root — no writes outside the project directory
- Path traversal attempts (`../`) and symlink escapes are rejected
- Shell commands are restricted to an explicit allowlist
- `.env` files and `node_modules` are excluded from directory listings by default
- API keys are never logged to the history database or terminal output
- All mutations require confirmation unless `--yes` is passed
- `aria db migrate` never executes `prisma migrate` — prints commands for user to run
- `aria upgrade deps` never runs `npm/pnpm/yarn/bun install` — modifies `package.json` only
- `aria upgrade prisma` never runs `prisma migrate` or install commands

## Contributing

Contributions are welcome. Please open an issue or pull request at [github.com/ariacodeai/ariacode](https://github.com/ariacodeai/ariacode).

## License

MIT — see [LICENSE](./LICENSE)
