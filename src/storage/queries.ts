import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session, SessionStatus } from '../storage.js';
import { writeFileAtomic } from '../fs-helpers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  limit?: number; // default 20
}

export interface FilterOptions {
  command?: string;
  since?: string; // natural-language or ISO 8601 expression
  status?: SessionStatus;
  limit?: number; // default 50
}

export interface SearchResult {
  session: Session;
  /** true when the query matched a message body (higher relevance) */
  matchedInMessages: boolean;
}

// ─── parseSinceExpression ─────────────────────────────────────────────────────

const SUPPORTED_FORMATS_MSG =
  "Supported formats: 'N days ago', 'N hours ago', 'N minutes ago', ISO 8601 date string (e.g. '2024-01-15' or '2024-01-15T10:00:00Z')";

/**
 * Parse a natural-language or ISO 8601 date expression into a Date.
 * Throws with a message containing "Supported formats" for unrecognized input.
 */
export function parseSinceExpression(expr: string): Date {
  const trimmed = expr.trim();

  // "N days/hours/minutes ago"
  const relativeMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s+(days?|hours?|minutes?)\s+ago$/i);
  if (relativeMatch) {
    const raw = relativeMatch[1];
    // Reject fractional and zero values
    if (raw.includes('.')) {
      throw new Error(`Unrecognized date expression. ${SUPPORTED_FORMATS_MSG}`);
    }
    const n = parseInt(raw, 10);
    if (n <= 0) {
      throw new Error(`Unrecognized date expression. ${SUPPORTED_FORMATS_MSG}`);
    }
    const unit = relativeMatch[2].toLowerCase();
    const now = Date.now();
    let ms: number;
    if (unit.startsWith('day')) ms = n * 86400 * 1000;
    else if (unit.startsWith('hour')) ms = n * 3600 * 1000;
    else ms = n * 60 * 1000;
    return new Date(now - ms);
  }

  // ISO date-only: "2024-01-15"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(trimmed + 'T00:00:00Z');
  }

  // ISO datetime without timezone: "2024-01-15T10:00:00"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return new Date(trimmed + 'Z');
  }

  // ISO datetime with Z or offset: "2024-01-15T10:00:00Z" / "2024-01-15T10:00:00+05:00"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d;
  }

  throw new Error(`Unrecognized date expression. ${SUPPORTED_FORMATS_MSG}`);
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row['id'] as string,
    command: row['command'] as string,
    projectRoot: row['projectRoot'] as string,
    provider: row['provider'] as string,
    model: row['model'] as string,
    status: row['status'] as SessionStatus,
    createdAt: row['createdAt'] as string,
    completedAt: (row['completedAt'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape SQLite LIKE wildcards (% and _) so user input is treated as literal text.
 */
function escapeLike(str: string): string {
  return str.replace(/[%_]/g, (ch) => `\\${ch}`);
}

// ─── searchSessions ───────────────────────────────────────────────────────────

/**
 * Full-text search across session command, project_root, and message content.
 * Returns sessions ordered by relevance: message matches before metadata matches.
 */
export function searchSessions(
  db: Database.Database,
  query: string,
  options?: SearchOptions,
): SearchResult[] {
  if (!query) return [];

  const limit = options?.limit ?? 20;
  const pattern = `%${escapeLike(query.toLowerCase())}%`;

  // Sessions matching in messages (higher relevance)
  const messageMatchRows = db
    .prepare(
      `SELECT DISTINCT s.id, s.command, s.project_root as projectRoot, s.provider, s.model,
              s.status, s.created_at as createdAt, s.completed_at as completedAt, s.error
       FROM sessions s
       INNER JOIN messages m ON m.session_id = s.id
       WHERE LOWER(m.content) LIKE ? ESCAPE '\\'
       ORDER BY s.created_at DESC
       LIMIT ?`,
    )
    .all(pattern, limit) as Record<string, unknown>[];

  const messageMatchIds = new Set(messageMatchRows.map((r) => r['id'] as string));

  // Sessions matching only in metadata (lower relevance)
  const metaMatchRows = db
    .prepare(
      `SELECT id, command, project_root as projectRoot, provider, model,
              status, created_at as createdAt, completed_at as completedAt, error
       FROM sessions
       WHERE (LOWER(command) LIKE ? ESCAPE '\\' OR LOWER(project_root) LIKE ? ESCAPE '\\')
         AND id NOT IN (SELECT DISTINCT session_id FROM messages WHERE LOWER(content) LIKE ? ESCAPE '\\')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, limit) as Record<string, unknown>[];

  const results: SearchResult[] = [
    ...messageMatchRows.map((r) => ({ session: rowToSession(r), matchedInMessages: true })),
    ...metaMatchRows
      .filter((r) => !messageMatchIds.has(r['id'] as string))
      .map((r) => ({ session: rowToSession(r), matchedInMessages: false })),
  ];

  return results.slice(0, limit);
}

// ─── filterSessions ───────────────────────────────────────────────────────────

/**
 * Filter sessions by command, date range, status, with AND logic.
 */
export function filterSessions(db: Database.Database, filters: FilterOptions): Session[] {
  const limit = filters.limit ?? 50;
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.command) {
    clauses.push('command = ?');
    params.push(filters.command);
  }

  if (filters.since) {
    const since = parseSinceExpression(filters.since);
    clauses.push('created_at >= ?');
    params.push(since.toISOString());
  }

  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT id, command, project_root as projectRoot, provider, model,
           status, created_at as createdAt, completed_at as completedAt, error
    FROM sessions
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToSession);
}

// ─── exportSessionMarkdown ────────────────────────────────────────────────────

/**
 * Write a markdown transcript of a session to outputPath.
 * Creates parent directories if they do not exist.
 * Uses atomic write to prevent partial files on crash.
 *
 * Path validation (preventing writes outside project root) is the caller's
 * responsibility — see runHistory in actions.ts.
 */
export function exportSessionMarkdown(
  db: Database.Database,
  sessionId: string,
  outputPath: string,
): void {
  const session = db
    .prepare(
      `SELECT id, command, project_root as projectRoot, provider, model,
              status, created_at as createdAt, completed_at as completedAt, error
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as Record<string, unknown> | undefined;

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const messages = db
    .prepare(
      `SELECT role, content, created_at as createdAt
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId) as { role: string; content: string; createdAt: string }[];

  const tools = db
    .prepare(
      `SELECT tool_name as toolName, output, error, created_at as createdAt
       FROM tool_executions WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(sessionId) as { toolName: string; output: string | null; error: string | null; createdAt: string }[];

  const lines: string[] = [];

  // Metadata table
  lines.push(`# Session: ${session['id']}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Command | ${session['command']} |`);
  lines.push(`| Status | ${session['status']} |`);
  lines.push(`| Started | ${session['createdAt']} |`);
  lines.push(`| Completed | ${session['completedAt'] ?? '—'} |`);
  lines.push(`| Project | ${session['projectRoot']} |`);
  lines.push(`| Provider / Model | ${session['provider']} / ${session['model']} |`);
  lines.push('');

  // Message transcript
  lines.push('## Messages');
  lines.push('');
  for (const msg of messages) {
    lines.push(`### [${msg.role}] ${msg.createdAt}`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
  }

  // Tool executions table
  lines.push('## Tool Executions');
  lines.push('');
  lines.push('| # | Tool | Status | Input Summary | Time |');
  lines.push('|---|---|---|---|---|');
  tools.forEach((t, i) => {
    const status = t.error ? '✗' : '✓';
    const inputSummary = t.output
      ? t.output.slice(0, 60).replace(/\n/g, ' ').replace(/\|/g, '\\|')
      : '—';
    lines.push(`| ${i + 1} | ${t.toolName} | ${status} | ${inputSummary} | ${t.createdAt} |`);
  });
  lines.push('');

  const content = lines.join('\n');
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(resolved, content);
}
